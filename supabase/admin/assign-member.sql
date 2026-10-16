-- First-owner setup. Run as administrator in the intended project's SQL Editor.
-- Replace the four quoted placeholders and review the two explicit flags.
-- Dates are inclusive Seoul calendar dates. A short first-login test interval
-- is membership access only: this script grants no media/publication rights.
-- When rendering customer strings, SQL-escape apostrophes and choose an outer
-- dollar delimiter absent from every supplied value; never concatenate raw SQL.
-- All changes are in this one atomic DO statement. No Auth/password writes,
-- media fixtures, payment changes, or rights changes are performed.
do $staycut_first_owner$
declare
  input_email constant text := '__AUTH_EMAIL__';
  input_tenant_name constant text := '__LODGING_NAME__';
  input_access_start constant text := '__ACCESS_START_DATE__';
  input_access_end constant text := '__ACCESS_END_DATE__';
  input_active constant boolean := true;
  input_access_allowed constant boolean := true;

  v_email text := lower(btrim(input_email));
  v_tenant_name text := btrim(input_tenant_name);
  v_access_start date;
  v_access_end date;
  v_user_ids uuid[];
  v_user_id uuid;
  v_confirmed_at timestamptz;
  v_named_tenants uuid[];
  v_user_tenants uuid[];
  v_tenant_id uuid;
  v_existing_tenant_name text;
  v_existing_member public.tenant_members;
begin
  if input_email is null or input_tenant_name is null
    or input_email = '__AUTH_' || 'EMAIL__'
    or input_tenant_name = '__LODGING_' || 'NAME__'
    or length(v_email) not between 3 and 254
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
    or length(v_tenant_name) not between 1 and 120
    or v_tenant_name ~ '[[:cntrl:]]'
    or input_active is null or input_access_allowed is null then
    raise exception 'first_owner_setup_requires_explicit_valid_inputs' using errcode = '22023';
  end if;
  if input_access_start is null or input_access_end is null
    or input_access_start !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or input_access_end !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'explicit_access_start_and_end_dates_required' using errcode = '22023';
  end if;
  begin
    v_access_start := input_access_start::date;
    v_access_end := input_access_end::date;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'invalid_access_calendar_dates' using errcode = '22023';
  end;
  if v_access_start > v_access_end then
    raise exception 'access_start_must_not_follow_end' using errcode = '22023';
  end if;

  -- Serialize this bounded setup, and also stop concurrent non-template tenant
  -- or membership writes between the collision checks and insertion.
  perform pg_catalog.set_config('lock_timeout', '5s', true);
  perform pg_catalog.pg_advisory_xact_lock(197481, 1);
  lock table public.tenants, public.tenant_members in share row exclusive mode;

  select coalesce(array_agg(locked.id), '{}'::uuid[]) into v_user_ids
    from (select u.id from auth.users u where lower(u.email) = v_email for share) locked;
  if cardinality(v_user_ids) <> 1 then
    raise exception 'exactly_one_existing_auth_email_required' using errcode = '42501';
  end if;
  v_user_id := v_user_ids[1];
  select u.email_confirmed_at into v_confirmed_at from auth.users u
    where u.id = v_user_id and lower(u.email) = v_email for share;
  if not found or v_confirmed_at is null then
    raise exception 'verified_existing_auth_account_required' using errcode = '42501';
  end if;

  select coalesce(array_agg(t.id), '{}'::uuid[]) into v_named_tenants
    from public.tenants t where lower(btrim(t.name)) = lower(v_tenant_name);
  select coalesce(array_agg(m.tenant_id), '{}'::uuid[]) into v_user_tenants
    from public.tenant_members m where m.user_id = v_user_id;

  if cardinality(v_user_tenants) > 0 then
    -- Only an exact replay of a single-user first-owner setup is a no-op.
    -- Never select a customer's tenant by name and attach another user to it.
    if cardinality(v_user_tenants) <> 1 or cardinality(v_named_tenants) <> 1
      or v_user_tenants[1] <> v_named_tenants[1] then
      raise exception 'existing_membership_or_tenant_name_conflict' using errcode = '55000';
    end if;
    v_tenant_id := v_user_tenants[1];
    select t.name into v_existing_tenant_name from public.tenants t where t.id = v_tenant_id;
    select m.* into v_existing_member from public.tenant_members m
      where m.tenant_id = v_tenant_id and m.user_id = v_user_id;
    if v_existing_tenant_name is distinct from v_tenant_name
      or v_existing_member.role is distinct from 'owner'
      or v_existing_member.active is distinct from input_active
      or v_existing_member.access_allowed is distinct from input_access_allowed
      or v_existing_member.access_start_date is distinct from v_access_start
      or v_existing_member.access_end_date is distinct from v_access_end
      or exists (select 1 from public.tenant_members m
        where m.tenant_id = v_tenant_id and m.user_id <> v_user_id) then
      raise exception 'not_an_identical_first_owner_rerun_use_member_management' using errcode = '55000';
    end if;
    raise notice 'first_owner_already_assigned tenant_id=% user_id=% access_start=% access_end=%',
      v_tenant_id, v_user_id, v_access_start, v_access_end;
    return;
  end if;

  if cardinality(v_named_tenants) <> 0 then
    raise exception 'tenant_name_already_exists_do_not_attach_by_name' using errcode = '55000';
  end if;
  insert into public.tenants(name) values (v_tenant_name) returning id into v_tenant_id;
  insert into public.tenant_members(tenant_id, user_id, role, active, access_allowed, access_start_date, access_end_date)
    values (v_tenant_id, v_user_id, 'owner', input_active, input_access_allowed, v_access_start, v_access_end);
  raise notice 'first_owner_created tenant_id=% user_id=% access_start=% access_end=%',
    v_tenant_id, v_user_id, v_access_start, v_access_end;
end
$staycut_first_owner$;
