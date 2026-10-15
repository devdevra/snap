-- Operator setup. Run only as administrator in the intended project's SQL Editor.
-- Replace the quoted email placeholder and review the explicit active=true flag.
-- This grants portal-wide operator access to one verified existing Auth account;
-- it does not create an account or alter any customer's membership or role.
-- When rendering the email, SQL-escape apostrophes and choose an outer dollar
-- delimiter absent from the supplied value; never concatenate raw SQL.
-- All changes are in this one atomic DO statement. No Auth/password writes,
-- media fixtures, payment changes, or rights changes are performed.
do $staycut_assign_operator$
declare
  input_email constant text := '__AUTH_EMAIL__';
  input_active constant boolean := true;

  v_email text := lower(btrim(input_email));
  v_user_ids uuid[];
  v_user_id uuid;
  v_confirmed_at timestamptz;
  v_existing_active boolean;
begin
  if input_email is null
    or input_email = '__AUTH_' || 'EMAIL__'
    or length(v_email) not between 3 and 254
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
    or input_active is distinct from true then
    raise exception 'operator_setup_requires_explicit_valid_inputs' using errcode = '22023';
  end if;

  -- Serialize this bounded setup and concurrent direct operator writes. Auth
  -- rows are held FOR SHARE during the lookup and are never changed here.
  perform pg_catalog.set_config('lock_timeout', '5s', true);
  perform pg_catalog.pg_advisory_xact_lock(197481, 2);
  lock table public.portal_operators in share row exclusive mode;

  select coalesce(array_agg(locked.id), '{}'::uuid[]) into v_user_ids
    from (select u.id from auth.users u
      where lower(btrim(u.email)) = v_email for share) locked;
  if cardinality(v_user_ids) <> 1 then
    raise exception 'exactly_one_existing_auth_email_required' using errcode = '42501';
  end if;
  v_user_id := v_user_ids[1];
  select u.email_confirmed_at into v_confirmed_at from auth.users u
    where u.id = v_user_id and lower(btrim(u.email)) = v_email for share;
  if not found or v_confirmed_at is null then
    raise exception 'verified_existing_auth_account_required' using errcode = '42501';
  end if;

  select o.active into v_existing_active from public.portal_operators o
    where o.user_id = v_user_id;
  if found then
    if v_existing_active is distinct from input_active then
      raise exception 'inactive_operator_requires_explicit_reactivation' using errcode = '55000';
    end if;
    raise notice 'operator_already_assigned user_id=%', v_user_id;
    return;
  end if;

  insert into public.portal_operators(user_id, active) values (v_user_id, input_active);
  -- SQL Editor bootstrap has no authenticated end-user actor. Preserve that
  -- distinction rather than attributing this administrator action to its target.
  insert into public.operator_action_log(actor_id, action, entity_id, details)
    values (null, 'operator_bootstrap', v_user_id, jsonb_build_object('source', 'admin_sql'));
  raise notice 'operator_created user_id=%', v_user_id;
end
$staycut_assign_operator$;
