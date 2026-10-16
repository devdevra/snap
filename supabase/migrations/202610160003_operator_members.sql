-- Operator-only membership management. Revoke access without deleting customer
-- identity, historical approvals, or tenant roles. This is an additive upgrade.
begin;

alter table public.tenant_members add column revision integer not null default 1
  check (revision > 0);

create function staycut_private.bump_member_revision() returns trigger
language plpgsql set search_path = '' as $$ begin
  -- All updates, including administrator SQL, invalidate previously loaded forms.
  new.revision:=old.revision+1;
  return new;
end $$;
create trigger tenant_member_revision before update on public.tenant_members
  for each row execute function staycut_private.bump_member_revision();

create function staycut_private.member_access(p_input jsonb) returns jsonb
language plpgsql set search_path = '' as $$ declare v_start date; v_end date; begin
  if jsonb_typeof(p_input->'accessAllowed') is distinct from 'boolean' then
    raise exception 'explicit_member_access_required' using errcode='22023';
  end if;
  v_start:=staycut_private.operator_date(p_input->'accessStartDate');
  v_end:=staycut_private.operator_date(p_input->'accessEndDate');
  if v_start>v_end then raise exception 'invalid_member_access_dates' using errcode='22023'; end if;
  return jsonb_build_object('accessAllowed',p_input->'accessAllowed','accessStartDate',v_start,'accessEndDate',v_end);
end $$;

create function public.operator_add_member(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$ declare
  v_actor uuid; v_tenant uuid; v_email text; v_ids uuid[]; v_user uuid;
  v_access jsonb; v_member public.tenant_members;
begin
  v_actor:=staycut_private.require_operator();
  perform staycut_private.operator_keys(p_input,
    array['tenantId','customerEmail','accessAllowed','accessStartDate','accessEndDate'],
    array['tenantId','customerEmail','accessAllowed','accessStartDate','accessEndDate']);
  if jsonb_typeof(p_input->'tenantId') is distinct from 'string'
    or jsonb_typeof(p_input->'customerEmail') is distinct from 'string' then
    raise exception 'member_tenant_and_email_required' using errcode='22023';
  end if;
  v_tenant:=(p_input->>'tenantId')::uuid;
  v_email:=lower(btrim(p_input->>'customerEmail'));
  if length(v_email) not between 3 and 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
    raise exception 'valid_customer_email_required' using errcode='22023';
  end if;
  v_access:=staycut_private.member_access(p_input);
  perform pg_catalog.set_config('lock_timeout','5s',true);
  perform 1 from public.tenants t where t.id=v_tenant for share;
  if not found then raise exception 'member_tenant_unavailable' using errcode='42501'; end if;
  select coalesce(array_agg(locked.id),'{}'::uuid[]) into v_ids
    from(select u.id from auth.users u where lower(u.email)=v_email for share) locked;
  if cardinality(v_ids)<>1 then
    raise exception 'exact_verified_customer_account_required' using errcode='42501';
  end if;
  v_user:=v_ids[1];
  if not exists(select 1 from auth.users u where u.id=v_user and u.email_confirmed_at is not null) then
    raise exception 'verified_customer_account_required' using errcode='42501';
  end if;
  -- Serialize duplicate additions before checking the absent composite key.
  -- Unrelated customers and tenants remain independent.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('staycut-member:'||v_tenant::text||':'||v_user::text,0));
  select * into v_member from public.tenant_members m
    where m.tenant_id=v_tenant and m.user_id=v_user for update;
  if found then
    if v_member.role<>'member' or not v_member.active
      or v_member.access_allowed is distinct from (v_access->>'accessAllowed')::boolean
      or v_member.access_start_date is distinct from (v_access->>'accessStartDate')::date
      or v_member.access_end_date is distinct from (v_access->>'accessEndDate')::date then
      raise exception 'member_already_exists_use_update' using errcode='55000';
    end if;
    return jsonb_build_object('tenantId',v_tenant,'userId',v_user,'revision',v_member.revision);
  end if;
  insert into public.tenant_members(tenant_id,user_id,role,active,access_allowed,access_start_date,access_end_date)
    values(v_tenant,v_user,'member',true,(v_access->>'accessAllowed')::boolean,
      (v_access->>'accessStartDate')::date,(v_access->>'accessEndDate')::date) returning * into v_member;
  insert into public.operator_action_log(actor_id,action,entity_id,details)
    values(v_actor,'member_added',v_tenant,jsonb_build_object('userId',v_user,'after',to_jsonb(v_member)));
  return jsonb_build_object('tenantId',v_tenant,'userId',v_user,'revision',v_member.revision);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'invalid_member_identifier_or_number' using errcode='22023';
end $$;

create function public.operator_update_member(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$ declare
  v_actor uuid; v_tenant uuid; v_user uuid; v_expected integer; v_access jsonb;
  v_member public.tenant_members; v_before jsonb;
begin
  v_actor:=staycut_private.require_operator();
  perform staycut_private.operator_keys(p_input,
    array['tenantId','userId','expectedRevision','active','accessAllowed','accessStartDate','accessEndDate'],
    array['tenantId','userId','expectedRevision','active','accessAllowed','accessStartDate','accessEndDate']);
  if jsonb_typeof(p_input->'tenantId') is distinct from 'string'
    or jsonb_typeof(p_input->'userId') is distinct from 'string'
    or jsonb_typeof(p_input->'expectedRevision') is distinct from 'number'
    or p_input->>'expectedRevision' !~ '^[0-9]{1,10}$'
    or jsonb_typeof(p_input->'active') is distinct from 'boolean' then
    raise exception 'explicit_member_revision_and_state_required' using errcode='22023';
  end if;
  v_tenant:=(p_input->>'tenantId')::uuid; v_user:=(p_input->>'userId')::uuid;
  v_expected:=(p_input->>'expectedRevision')::integer;
  if v_expected<1 then raise exception 'positive_member_revision_required' using errcode='22023'; end if;
  v_access:=staycut_private.member_access(p_input);
  perform pg_catalog.set_config('lock_timeout','5s',true);
  -- Do not lock assets from here: customer review and upload use asset→member order.
  select * into v_member from public.tenant_members m
    where m.tenant_id=v_tenant and m.user_id=v_user for update;
  if not found then raise exception 'member_in_tenant_required' using errcode='42501'; end if;
  if v_member.revision<>v_expected then
    raise exception 'member_changed_reload_operator_context' using errcode='55000';
  end if;
  v_before:=to_jsonb(v_member);
  update public.tenant_members set active=(p_input->>'active')::boolean,
    access_allowed=(v_access->>'accessAllowed')::boolean,
    access_start_date=(v_access->>'accessStartDate')::date,access_end_date=(v_access->>'accessEndDate')::date
    where tenant_id=v_tenant and user_id=v_user returning * into v_member;
  insert into public.operator_action_log(actor_id,action,entity_id,details)
    values(v_actor,'member_updated',v_tenant,jsonb_build_object('userId',v_user,'before',v_before,'after',to_jsonb(v_member)));
  return jsonb_build_object('tenantId',v_tenant,'userId',v_user,'revision',v_member.revision);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'invalid_member_identifier_or_number' using errcode='22023';
end $$;

-- Revoke/expiry affects both assignment and uploads that have not committed yet.
create or replace function staycut_private.operator_assignee(p_tenant_id uuid,p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
  perform 1 from public.tenant_members m join auth.users u on u.id=m.user_id
    where m.tenant_id=p_tenant_id and m.user_id=p_user_id and m.active and m.access_allowed
      and staycut_private.contract_today() between m.access_start_date and m.access_end_date
      and u.email_confirmed_at is not null for share of m,u;
  if not found then raise exception 'active_verified_assignee_in_tenant_required' using errcode='42501'; end if;
end $$;

create function public.operator_assign_approver(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$ declare
  v_actor uuid; v_asset public.assets; v_assignee uuid; v_expected uuid; v_latest uuid;
begin
  v_actor:=staycut_private.require_operator();
  perform staycut_private.operator_keys(p_input,
    array['assetId','assignedApproverId','expectedAssignedApproverId','expectedLatestVersionId'],
    array['assetId','assignedApproverId','expectedAssignedApproverId','expectedLatestVersionId']);
  if jsonb_typeof(p_input->'assetId') is distinct from 'string'
    or jsonb_typeof(p_input->'assignedApproverId') is distinct from 'string'
    or jsonb_typeof(p_input->'expectedAssignedApproverId') not in ('string','null')
    or jsonb_typeof(p_input->'expectedLatestVersionId') not in ('string','null') then
    raise exception 'explicit_observed_asset_assignment_required' using errcode='22023';
  end if;
  v_assignee:=(p_input->>'assignedApproverId')::uuid;
  v_expected:=(p_input->>'expectedAssignedApproverId')::uuid;
  v_latest:=(p_input->>'expectedLatestVersionId')::uuid;
  perform pg_catalog.set_config('lock_timeout','5s',true);
  select * into v_asset from public.assets a where a.id=(p_input->>'assetId')::uuid for update;
  if not found then raise exception 'asset_unavailable' using errcode='42501'; end if;
  if v_asset.assigned_approver_id is distinct from v_expected or v_asset.latest_version_id is distinct from v_latest then
    raise exception 'asset_assignment_changed_reload_operator_context' using errcode='55000';
  end if;
  perform staycut_private.operator_assignee(v_asset.tenant_id,v_assignee);
  if v_asset.assigned_approver_id<>v_assignee then
    update public.assets set assigned_approver_id=v_assignee where id=v_asset.id;
    insert into public.operator_action_log(actor_id,action,entity_id,details)
      values(v_actor,'asset_approver_assigned',v_asset.id,
        jsonb_build_object('before',v_asset.assigned_approver_id,'after',v_assignee,'latestVersionId',v_asset.latest_version_id));
  end if;
  return jsonb_build_object('assetId',v_asset.id,'assignedApproverId',v_assignee,'latestVersionId',v_asset.latest_version_id);
exception when invalid_text_representation then
  raise exception 'invalid_asset_assignment_identifier' using errcode='22023';
end $$;

create function staycut_private.preserve_upload_assignee() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
  -- operator_commit_upload holds the asset lock before this transition. Raising
  -- here rolls back its version, feedback, latest pointer, and audit atomically.
  if old.status='prepared' and new.status='committed' and not old.is_new_asset
    and exists(select 1 from public.assets a where a.id=old.asset_id
      and a.assigned_approver_id is distinct from old.assigned_approver_id) then
    raise exception 'upload_assignee_changed_prepare_again' using errcode='55000';
  end if;
  return new;
end $$;
create trigger upload_assignee_unchanged before update of status on public.operator_upload_sessions
  for each row execute function staycut_private.preserve_upload_assignee();

revoke all on function staycut_private.bump_member_revision(),staycut_private.member_access(jsonb),
  staycut_private.operator_assignee(uuid,uuid),staycut_private.preserve_upload_assignee()
  from public,anon,authenticated,service_role;
revoke all on function public.operator_add_member(jsonb),public.operator_update_member(jsonb),
  public.operator_assign_approver(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.operator_add_member(jsonb),public.operator_update_member(jsonb),
  public.operator_assign_approver(jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
