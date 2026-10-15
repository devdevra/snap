-- Explicit system operators, staged media delivery, and atomic publication into
-- the customer portal. Customer tenant owners are never implicit operators.
begin;

update storage.buckets set public=false,file_size_limit=52428800,
  allowed_mime_types=array['video/mp4','video/webm']::text[] where id='staycut-deliverables';

create table public.portal_operators (
  user_id uuid primary key references auth.users(id),
  active boolean not null default false,
  created_at timestamptz not null default now()
);
create table public.operator_action_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id),
  action text not null,
  entity_id uuid not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default clock_timestamp()
);
create index operator_action_log_actor on public.operator_action_log(actor_id,created_at desc);

alter table public.asset_versions
  add column delivery_bytes bigint check (delivery_bytes between 1 and 52428800),
  add column preview_bytes bigint check (preview_bytes between 1 and 52428800),
  add column delivery_mime_type text check (delivery_mime_type in ('video/mp4','video/webm')),
  add column preview_mime_type text check (preview_mime_type in ('video/mp4','video/webm'));

create table public.operator_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.portal_operators(user_id),
  tenant_id uuid not null references public.tenants(id),
  asset_id uuid not null,
  version_id uuid not null unique,
  version_number integer not null check (version_number > 0),
  is_new_asset boolean not null,
  expected_latest_version_id uuid,
  expected_revision_id uuid,
  title text not null,
  assigned_approver_id uuid not null,
  terms jsonb not null,
  change_summary text not null default '',
  delivery_sha256 text not null check (delivery_sha256 ~ '^[0-9a-f]{64}$'),
  delivery_bytes bigint not null check (delivery_bytes between 1 and 52428800),
  delivery_mime_type text not null check (delivery_mime_type in ('video/mp4','video/webm')),
  delivery_staging_path text not null unique,
  delivery_final_path text not null unique,
  preview_sha256 text not null check (preview_sha256 ~ '^[0-9a-f]{64}$'),
  preview_bytes bigint not null check (preview_bytes between 1 and 52428800),
  preview_mime_type text not null check (preview_mime_type in ('video/mp4','video/webm')),
  preview_staging_path text not null unique,
  preview_final_path text not null unique,
  status text not null default 'prepared' check (status in ('prepared','committed')),
  expires_at timestamptz not null default (clock_timestamp() + interval '2 hours'),
  created_at timestamptz not null default clock_timestamp(),
  committed_at timestamptz,
  foreign key (tenant_id,assigned_approver_id) references public.tenant_members(tenant_id,user_id),
  check (delivery_sha256 <> preview_sha256),
  check ((status='prepared' and committed_at is null) or (status='committed' and committed_at is not null))
);
create index operator_upload_sessions_actor on public.operator_upload_sessions(actor_id,created_at desc);

alter table public.portal_operators enable row level security;
alter table public.operator_action_log enable row level security;
alter table public.operator_upload_sessions enable row level security;
revoke all on public.portal_operators,public.operator_action_log,public.operator_upload_sessions from public,anon,authenticated,service_role;
grant select on public.portal_operators,public.operator_action_log,public.operator_upload_sessions to service_role;

create trigger immutable_operator_log before update or delete on public.operator_action_log
  for each row execute function staycut_private.preserve_approval();
create trigger immutable_operator_log_truncate before truncate on public.operator_action_log
  for each statement execute function staycut_private.preserve_approval();

create or replace function staycut_private.preserve_approved_content() returns trigger
language plpgsql security definer set search_path = ''
as $$ begin
  if exists (select 1 from public.version_approvals a where a.version_id=old.id)
    and row(new.id,new.asset_id,new.tenant_id,new.version_number,new.object_path,new.content_sha256,
      new.preview_object_path,new.preview_content_sha256,new.delivery_bytes,new.preview_bytes,
      new.delivery_mime_type,new.preview_mime_type,new.created_at)
      is distinct from row(old.id,old.asset_id,old.tenant_id,old.version_number,old.object_path,old.content_sha256,
        old.preview_object_path,old.preview_content_sha256,old.delivery_bytes,old.preview_bytes,
        old.delivery_mime_type,old.preview_mime_type,old.created_at) then
    raise exception 'approved_content_is_immutable_create_new_version' using errcode='55000';
  end if;
  return new;
end $$;

create function staycut_private.require_operator() returns uuid
language plpgsql security definer set search_path = ''
as $$ declare v_actor uuid := auth.uid(); begin
  if v_actor is null then raise exception 'operator_required' using errcode='42501'; end if;
  perform 1 from public.portal_operators o where o.user_id=v_actor and o.active for share;
  if not found then raise exception 'operator_required' using errcode='42501'; end if;
  return v_actor;
end $$;

create function staycut_private.operator_keys(p_value jsonb,p_allowed text[],p_required text[])
returns void language plpgsql set search_path = ''
as $$ begin
  if p_value is null or jsonb_typeof(p_value)<>'object' then
    raise exception 'object_payload_required' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_object_keys(p_value) k where not(k=any(p_allowed)))
    or not(p_value ?& p_required) then
    raise exception 'unexpected_or_missing_payload_fields' using errcode='22023';
  end if;
end $$;

create function staycut_private.operator_date(p_value jsonb) returns date
language plpgsql set search_path = ''
as $$ declare v_text text; begin
  if jsonb_typeof(p_value) is distinct from 'string' then
    raise exception 'iso_calendar_date_required' using errcode='22023';
  end if;
  v_text := p_value #>> '{}';
  if v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'iso_calendar_date_required' using errcode='22023';
  end if;
  return v_text::date;
exception when invalid_datetime_format or datetime_field_overflow then
  raise exception 'invalid_calendar_date' using errcode='22023';
end $$;

create function staycut_private.operator_terms(p_value jsonb) returns jsonb
language plpgsql set search_path = ''
as $$ declare
  v_access_start date; v_access_end date; v_rights_start date; v_rights_end date;
  v_status text := coalesce(p_value->>'rightsStatus','pending');
begin
  perform staycut_private.operator_keys(p_value,
    array['accessAllowed','accessStartDate','accessEndDate','rightsStatus','rightsStartDate','rightsEndDate','allowedChannels','allowedPurposes','finalDeliveryPaid'],
    array['accessAllowed','accessStartDate','accessEndDate','rightsStartDate','rightsEndDate','allowedChannels','allowedPurposes']);
  v_access_start:=staycut_private.operator_date(p_value->'accessStartDate');
  v_access_end:=staycut_private.operator_date(p_value->'accessEndDate');
  v_rights_start:=staycut_private.operator_date(p_value->'rightsStartDate');
  v_rights_end:=staycut_private.operator_date(p_value->'rightsEndDate');
  if v_access_start>v_access_end or v_rights_start>v_rights_end
    or v_status not in ('pending','valid','expired')
    or (p_value ? 'rightsStatus' and jsonb_typeof(p_value->'rightsStatus')<>'string')
    or (p_value ? 'accessAllowed' and jsonb_typeof(p_value->'accessAllowed')<>'boolean')
    or (p_value ? 'finalDeliveryPaid' and jsonb_typeof(p_value->'finalDeliveryPaid')<>'boolean')
    or jsonb_typeof(p_value->'allowedChannels') is distinct from 'array'
    or jsonb_typeof(p_value->'allowedPurposes') is distinct from 'array' then
    raise exception 'invalid_asset_terms' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_value->'allowedChannels') e where jsonb_typeof(e)<>'string' or e#>>'{}' not in ('instagram','youtube'))
    or exists(select 1 from jsonb_array_elements(p_value->'allowedPurposes') e where jsonb_typeof(e)<>'string' or e#>>'{}' not in ('organic','advertising'))
    or (v_status='valid' and (jsonb_array_length(p_value->'allowedChannels')=0 or jsonb_array_length(p_value->'allowedPurposes')=0)) then
    raise exception 'invalid_asset_usage_scope' using errcode='22023';
  end if;
  return jsonb_build_object('accessAllowed',coalesce((p_value->>'accessAllowed')::boolean,false),
    'accessStartDate',v_access_start,'accessEndDate',v_access_end,'rightsStatus',v_status,
    'rightsStartDate',v_rights_start,'rightsEndDate',v_rights_end,
    'allowedChannels',p_value->'allowedChannels','allowedPurposes',p_value->'allowedPurposes',
    'finalDeliveryPaid',coalesce((p_value->>'finalDeliveryPaid')::boolean,false));
end $$;

create function staycut_private.asset_terms(p_asset public.assets) returns jsonb
language sql set search_path = '' as $$
 select jsonb_build_object('accessAllowed',p_asset.access_allowed,'accessStartDate',p_asset.access_start_date,
 'accessEndDate',p_asset.access_end_date,'rightsStatus',p_asset.rights_status,'rightsStartDate',p_asset.rights_start_date,
 'rightsEndDate',p_asset.rights_end_date,'allowedChannels',p_asset.allowed_channels,
 'allowedPurposes',p_asset.allowed_purposes,'finalDeliveryPaid',p_asset.final_delivery_paid)
$$;

create function staycut_private.operator_file(p_value jsonb) returns void
language plpgsql set search_path = '' as $$ begin
  perform staycut_private.operator_keys(p_value,array['sha256','bytes','mimeType'],array['sha256','bytes','mimeType']);
  if jsonb_typeof(p_value->'sha256') is distinct from 'string' or p_value->>'sha256' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_value->'mimeType') is distinct from 'string' or p_value->>'mimeType' not in ('video/mp4','video/webm')
    or jsonb_typeof(p_value->'bytes') is distinct from 'number' or p_value->>'bytes' !~ '^[0-9]{1,8}$' then
    raise exception 'invalid_media_manifest' using errcode='22023';
  end if;
  if (p_value->>'bytes')::bigint not between 1 and 52428800 then
    raise exception 'media_size_out_of_bounds' using errcode='22023';
  end if;
end $$;

create function staycut_private.operator_assignee(p_tenant_id uuid,p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
  perform 1 from public.tenant_members m join auth.users u on u.id=m.user_id
    where m.tenant_id=p_tenant_id and m.user_id=p_user_id and m.active and m.access_allowed
      and u.email_confirmed_at is not null for share of m,u;
  if not found then raise exception 'active_verified_assignee_in_tenant_required' using errcode='42501'; end if;
end $$;

create function staycut_private.upload_manifest(p_session public.operator_upload_sessions) returns jsonb
language sql set search_path = '' as $$
 select jsonb_build_object('sessionId',p_session.id,'tenantId',p_session.tenant_id,'assetId',p_session.asset_id,
 'versionId',p_session.version_id,'status',p_session.status,'expiresAt',p_session.expires_at,
 'delivery',jsonb_build_object('stagingPath',p_session.delivery_staging_path,'finalPath',p_session.delivery_final_path,
 'sha256',p_session.delivery_sha256,'bytes',p_session.delivery_bytes,'mimeType',p_session.delivery_mime_type),
 'preview',jsonb_build_object('stagingPath',p_session.preview_staging_path,'finalPath',p_session.preview_final_path,
 'sha256',p_session.preview_sha256,'bytes',p_session.preview_bytes,'mimeType',p_session.preview_mime_type))
$$;

create function public.operator_context() returns jsonb
language plpgsql security definer set search_path = '' as $$ declare v_actor uuid; begin
  v_actor:=staycut_private.require_operator();
  return jsonb_build_object('operator',jsonb_build_object('user_id',v_actor),
    'tenants',coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at desc) from public.tenants t),'[]'::jsonb),
    'members',coalesce((select jsonb_agg(to_jsonb(m)||jsonb_build_object('email',u.email) order by m.tenant_id,m.user_id)
      from public.tenant_members m join auth.users u on u.id=m.user_id),'[]'::jsonb),
    'assets',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('latest_version',to_jsonb(v),
      'open_revision',(select to_jsonb(r) from public.revision_requests r where r.asset_id=a.id and r.resolved_at is null)) order by a.created_at desc)
      from public.assets a left join public.asset_versions v on v.id=a.latest_version_id),'[]'::jsonb));
end $$;

create function public.operator_create_tenant(p_name text,p_customer_email text,p_access_start_date date,p_access_end_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$ declare
  v_actor uuid; v_ids uuid[]; v_customer uuid; v_tenant uuid; v_name text:=btrim(p_name); v_email text:=lower(btrim(p_customer_email));
begin
  v_actor:=staycut_private.require_operator();
  if p_name is null or length(v_name) not between 1 and 120 or v_name~'[[:cntrl:]]'
    or p_customer_email is null or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
    or p_access_start_date is null or p_access_end_date is null or p_access_start_date>p_access_end_date then
    raise exception 'explicit_valid_customer_and_access_dates_required' using errcode='22023';
  end if;
  perform pg_catalog.set_config('lock_timeout','5s',true);
  perform pg_catalog.pg_advisory_xact_lock(197481,3);
  lock table public.tenants,public.tenant_members in share row exclusive mode;
  select coalesce(array_agg(locked.id),'{}'::uuid[]) into v_ids
    from(select u.id from auth.users u where lower(u.email)=v_email for share) locked;
  if cardinality(v_ids)<>1 then raise exception 'exact_verified_customer_account_required' using errcode='42501'; end if;
  v_customer:=v_ids[1];
  if not exists(select 1 from auth.users u where u.id=v_customer and u.email_confirmed_at is not null) then
    raise exception 'verified_customer_account_required' using errcode='42501';
  end if;
  if exists(select 1 from public.tenants t where lower(btrim(t.name))=lower(v_name)) then
    raise exception 'tenant_name_already_exists' using errcode='55000';
  end if;
  insert into public.tenants(name) values(v_name) returning id into v_tenant;
  insert into public.tenant_members(tenant_id,user_id,role,active,access_allowed,access_start_date,access_end_date)
    values(v_tenant,v_customer,'owner',true,true,p_access_start_date,p_access_end_date);
  insert into public.operator_action_log(actor_id,action,entity_id,details)
    values(v_actor,'tenant_created',v_tenant,jsonb_build_object('customerId',v_customer,'accessStartDate',p_access_start_date,'accessEndDate',p_access_end_date));
  return jsonb_build_object('tenantId',v_tenant,'customerId',v_customer);
end $$;

create function public.operator_prepare_upload(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$ declare
  v_actor uuid; v_tenant uuid; v_asset_id uuid; v_version uuid:=gen_random_uuid(); v_session_id uuid:=gen_random_uuid();
  v_asset public.assets; v_session public.operator_upload_sessions; v_terms jsonb; v_title text; v_assignee uuid;
  v_new boolean; v_number integer; v_latest uuid; v_revision uuid; v_summary text;
  v_delivery_ext text; v_preview_ext text; v_prefix text;
begin
  v_actor:=staycut_private.require_operator();
  perform staycut_private.operator_keys(p_input,array['tenantId','assetId','title','assignedApproverId','terms','changeSummary','expectedLatestVersionId','expectedRevisionId','delivery','preview'],array['tenantId','delivery','preview']);
  if jsonb_typeof(p_input->'tenantId') is distinct from 'string'
    or (p_input ? 'changeSummary' and jsonb_typeof(p_input->'changeSummary')<>'string') then
    raise exception 'invalid_upload_fields' using errcode='22023';
  end if;
  v_tenant:=(p_input->>'tenantId')::uuid;
  v_new:=not(p_input ? 'assetId') or p_input->'assetId'='null'::jsonb;
  v_summary:=coalesce(p_input->>'changeSummary','');
  if length(v_summary)>4000 then raise exception 'change_summary_too_long' using errcode='22023'; end if;
  perform staycut_private.operator_file(p_input->'delivery');
  perform staycut_private.operator_file(p_input->'preview');
  if p_input->'delivery'->>'sha256'=p_input->'preview'->>'sha256' then
    raise exception 'separate_preview_content_required' using errcode='22023';
  end if;
  if v_new then
    perform staycut_private.operator_keys(p_input,array['tenantId','assetId','title','assignedApproverId','terms','changeSummary','delivery','preview'],array['tenantId','title','assignedApproverId','terms','delivery','preview']);
    if jsonb_typeof(p_input->'title') is distinct from 'string'
      or length(btrim(p_input->>'title')) not between 1 and 200
      or p_input->>'title'~'[[:cntrl:]]'
      or jsonb_typeof(p_input->'assignedApproverId') is distinct from 'string' then
      raise exception 'new_asset_title_and_assignee_required' using errcode='22023';
    end if;
    v_title:=btrim(p_input->>'title'); v_assignee:=(p_input->>'assignedApproverId')::uuid;
    v_terms:=staycut_private.operator_terms(p_input->'terms'); v_asset_id:=gen_random_uuid(); v_number:=1;
  else
    perform staycut_private.operator_keys(p_input,array['tenantId','assetId','changeSummary','expectedLatestVersionId','expectedRevisionId','delivery','preview'],array['tenantId','assetId','expectedLatestVersionId','expectedRevisionId','delivery','preview']);
    if jsonb_typeof(p_input->'assetId') is distinct from 'string' then
      raise exception 'asset_id_required' using errcode='22023';
    end if;
    v_asset_id:=(p_input->>'assetId')::uuid;
    select * into v_asset from public.assets where id=v_asset_id and tenant_id=v_tenant for update;
    if not found then raise exception 'asset_in_tenant_required' using errcode='42501'; end if;
    v_title:=v_asset.title; v_assignee:=v_asset.assigned_approver_id;
    v_terms:=staycut_private.asset_terms(v_asset); v_latest:=v_asset.latest_version_id;
    if jsonb_typeof(p_input->'expectedLatestVersionId') not in ('string','null')
      or v_latest is distinct from (p_input->>'expectedLatestVersionId')::uuid then
      raise exception 'latest_version_changed_reload_operator_context' using errcode='55000';
    end if;
    select coalesce(max(version_number),0)+1 into v_number from public.asset_versions where asset_id=v_asset_id;
    select id into v_revision from public.revision_requests where asset_id=v_asset_id and resolved_at is null;
    if (jsonb_typeof(p_input->'expectedRevisionId') not in ('string','null'))
      or v_revision is distinct from (p_input->>'expectedRevisionId')::uuid then
      raise exception 'revision_feedback_changed_reload_operator_context' using errcode='55000';
    end if;
  end if;
  perform staycut_private.operator_assignee(v_tenant,v_assignee);
  v_delivery_ext:=case p_input->'delivery'->>'mimeType' when 'video/mp4' then 'mp4' else 'webm' end;
  v_preview_ext:=case p_input->'preview'->>'mimeType' when 'video/mp4' then 'mp4' else 'webm' end;
  v_prefix:=v_tenant::text||'/'||v_asset_id::text||'/'||v_version::text||'/';
  insert into public.operator_upload_sessions(id,actor_id,tenant_id,asset_id,version_id,version_number,is_new_asset,
    expected_latest_version_id,expected_revision_id,title,assigned_approver_id,terms,change_summary,
    delivery_sha256,delivery_bytes,delivery_mime_type,delivery_staging_path,delivery_final_path,
    preview_sha256,preview_bytes,preview_mime_type,preview_staging_path,preview_final_path)
    values(v_session_id,v_actor,v_tenant,v_asset_id,v_version,v_number,v_new,v_latest,v_revision,v_title,v_assignee,v_terms,v_summary,
      p_input->'delivery'->>'sha256',(p_input->'delivery'->>'bytes')::bigint,p_input->'delivery'->>'mimeType',
      'staging/'||v_session_id::text||'/delivery.'||v_delivery_ext,v_prefix||'delivery.'||v_delivery_ext,
      p_input->'preview'->>'sha256',(p_input->'preview'->>'bytes')::bigint,p_input->'preview'->>'mimeType',
      'staging/'||v_session_id::text||'/preview.'||v_preview_ext,v_prefix||'preview/review.'||v_preview_ext)
      returning * into v_session;
  insert into public.operator_action_log(actor_id,action,entity_id,details)
    values(v_actor,'upload_prepared',v_session_id,jsonb_build_object('assetId',v_asset_id,'versionId',v_version,
      'expectedLatestVersionId',v_latest,'expectedRevisionId',v_revision,'isNewAsset',v_new,'terms',v_terms));
  return staycut_private.upload_manifest(v_session);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'invalid_upload_identifier_or_number' using errcode='22023';
end $$;

create function public.operator_upload_manifest(p_session_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$ declare
  v_actor uuid; v_session public.operator_upload_sessions;
begin
  v_actor:=staycut_private.require_operator();
  select * into v_session from public.operator_upload_sessions where id=p_session_id and actor_id=v_actor;
  if not found then raise exception 'own_upload_session_required' using errcode='42501'; end if;
  if v_session.status='prepared' and v_session.expires_at<=clock_timestamp() then
    raise exception 'upload_session_expired' using errcode='55000';
  end if;
  return staycut_private.upload_manifest(v_session);
end $$;

create function public.operator_update_asset(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$ declare
  v_actor uuid; v_asset public.assets; v_terms jsonb; v_before jsonb;
begin
  v_actor:=staycut_private.require_operator();
  perform staycut_private.operator_keys(p_input,array['assetId','terms'],array['assetId','terms']);
  if jsonb_typeof(p_input->'assetId') is distinct from 'string' then
    raise exception 'asset_id_required' using errcode='22023';
  end if;
  perform staycut_private.operator_keys(p_input->'terms',array['accessAllowed','accessStartDate','accessEndDate','rightsStatus','rightsStartDate','rightsEndDate','allowedChannels','allowedPurposes','finalDeliveryPaid'],
    array['accessAllowed','accessStartDate','accessEndDate','rightsStatus','rightsStartDate','rightsEndDate','allowedChannels','allowedPurposes','finalDeliveryPaid']);
  v_terms:=staycut_private.operator_terms(p_input->'terms');
  select * into v_asset from public.assets where id=(p_input->>'assetId')::uuid for update;
  if not found then raise exception 'asset_unavailable' using errcode='42501'; end if;
  v_before:=staycut_private.asset_terms(v_asset);
  update public.assets set access_allowed=(v_terms->>'accessAllowed')::boolean,
    access_start_date=(v_terms->>'accessStartDate')::date,access_end_date=(v_terms->>'accessEndDate')::date,
    rights_status=v_terms->>'rightsStatus',rights_start_date=(v_terms->>'rightsStartDate')::date,
    rights_end_date=(v_terms->>'rightsEndDate')::date,
    allowed_channels=array(select jsonb_array_elements_text(v_terms->'allowedChannels')),
    allowed_purposes=array(select jsonb_array_elements_text(v_terms->'allowedPurposes')),
    final_delivery_paid=(v_terms->>'finalDeliveryPaid')::boolean
    where id=v_asset.id returning * into v_asset;
  insert into public.operator_action_log(actor_id,action,entity_id,details)
    values(v_actor,'asset_terms_updated',v_asset.id,jsonb_build_object('before',v_before,'after',v_terms));
  return to_jsonb(v_asset);
exception when invalid_text_representation then
  raise exception 'invalid_asset_identifier' using errcode='22023';
end $$;

-- Only the trusted server can attest bytes it actually fetched from immutable
-- final objects. Browser JWTs cannot call this or write the session tables.
create function public.operator_commit_upload(p_session_id uuid,p_actor_id uuid,p_delivery_sha256 text,
  p_delivery_bytes bigint,p_preview_sha256 text,p_preview_bytes bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$ declare
  v_session public.operator_upload_sessions; v_asset public.assets; v_revision uuid;
begin
  select * into v_session from public.operator_upload_sessions where id=p_session_id for update;
  if not found or v_session.actor_id is distinct from p_actor_id then
    raise exception 'own_upload_session_required' using errcode='42501';
  end if;
  perform 1 from public.portal_operators o where o.user_id=p_actor_id and o.active for share;
  if not found then raise exception 'active_upload_operator_required' using errcode='42501'; end if;
  if p_delivery_sha256 is distinct from v_session.delivery_sha256 or p_delivery_bytes is distinct from v_session.delivery_bytes
    or p_preview_sha256 is distinct from v_session.preview_sha256 or p_preview_bytes is distinct from v_session.preview_bytes then
    raise exception 'verified_media_manifest_mismatch' using errcode='55000';
  end if;
  -- Completed retries do not touch latest pointers, terms, or revision history,
  -- even after another newer version has subsequently been committed.
  if v_session.status='committed' then
    return jsonb_build_object('sessionId',v_session.id,'tenantId',v_session.tenant_id,'assetId',v_session.asset_id,
      'versionId',v_session.version_id,'status','committed');
  end if;
  if v_session.expires_at<=clock_timestamp() then
    raise exception 'upload_session_expired' using errcode='55000';
  end if;
  if v_session.is_new_asset then
    if exists(select 1 from public.assets a where a.id=v_session.asset_id) then
      raise exception 'reserved_asset_already_exists' using errcode='55000';
    end if;
    perform staycut_private.operator_assignee(v_session.tenant_id,v_session.assigned_approver_id);
    insert into public.assets(id,tenant_id,title,assigned_approver_id,access_allowed,access_start_date,access_end_date,
      rights_status,rights_start_date,rights_end_date,allowed_channels,allowed_purposes,final_delivery_paid)
      values(v_session.asset_id,v_session.tenant_id,v_session.title,v_session.assigned_approver_id,
        (v_session.terms->>'accessAllowed')::boolean,(v_session.terms->>'accessStartDate')::date,(v_session.terms->>'accessEndDate')::date,
        v_session.terms->>'rightsStatus',(v_session.terms->>'rightsStartDate')::date,(v_session.terms->>'rightsEndDate')::date,
        array(select jsonb_array_elements_text(v_session.terms->'allowedChannels')),
        array(select jsonb_array_elements_text(v_session.terms->'allowedPurposes')),(v_session.terms->>'finalDeliveryPaid')::boolean)
        returning * into v_asset;
  else
    select * into v_asset from public.assets where id=v_session.asset_id and tenant_id=v_session.tenant_id for update;
    if not found then raise exception 'asset_in_tenant_required' using errcode='42501'; end if;
    if v_asset.latest_version_id is distinct from v_session.expected_latest_version_id then
      raise exception 'upload_latest_version_changed_prepare_again' using errcode='55000';
    end if;
    select id into v_revision from public.revision_requests where asset_id=v_asset.id and resolved_at is null;
    if v_revision is distinct from v_session.expected_revision_id then
      raise exception 'revision_feedback_changed_prepare_again' using errcode='55000';
    end if;
    perform staycut_private.operator_assignee(v_asset.tenant_id,v_asset.assigned_approver_id);
  end if;
  if exists(select 1 from public.asset_versions v where v.id=v_session.version_id
    or (v.asset_id=v_session.asset_id and v.version_number=v_session.version_number)
    or v.object_path=v_session.delivery_final_path or v.preview_object_path=v_session.preview_final_path) then
    raise exception 'version_or_final_path_already_used' using errcode='55000';
  end if;
  insert into public.asset_versions(id,asset_id,tenant_id,version_number,review_status,change_summary,preview_available,
    delivery_available,object_path,content_sha256,preview_object_path,preview_content_sha256,delivery_bytes,preview_bytes,
    delivery_mime_type,preview_mime_type)
    values(v_session.version_id,v_session.asset_id,v_session.tenant_id,v_session.version_number,'pending',v_session.change_summary,
      true,true,v_session.delivery_final_path,v_session.delivery_sha256,v_session.preview_final_path,v_session.preview_sha256,
      v_session.delivery_bytes,v_session.preview_bytes,v_session.delivery_mime_type,v_session.preview_mime_type);
  update public.assets set latest_version_id=v_session.version_id where id=v_session.asset_id;
  if v_session.expected_revision_id is not null then
    update public.revision_requests set resolved_at=clock_timestamp()
      where id=v_session.expected_revision_id and asset_id=v_session.asset_id and resolved_at is null;
  end if;
  update public.operator_upload_sessions set status='committed',committed_at=clock_timestamp() where id=v_session.id;
  insert into public.operator_action_log(actor_id,action,entity_id,details)
    values(p_actor_id,case when v_session.is_new_asset then 'asset_created' else 'asset_version_created' end,v_session.asset_id,
      jsonb_build_object('sessionId',v_session.id,'versionId',v_session.version_id,'resolvedRevisionId',v_session.expected_revision_id,
        'deliverySha256',p_delivery_sha256,'deliveryBytes',p_delivery_bytes,'previewSha256',p_preview_sha256,'previewBytes',p_preview_bytes));
  return jsonb_build_object('sessionId',v_session.id,'tenantId',v_session.tenant_id,'assetId',v_session.asset_id,
    'versionId',v_session.version_id,'status','committed');
end $$;

revoke all on all functions in schema staycut_private from public,anon,authenticated,service_role;
grant execute on function staycut_private.contract_today(),staycut_private.is_tenant_member(uuid),
  staycut_private.can_access_asset(uuid,uuid) to authenticated;
revoke all on function public.operator_context(),public.operator_create_tenant(text,text,date,date),
  public.operator_prepare_upload(jsonb),public.operator_upload_manifest(uuid),public.operator_update_asset(jsonb),
  public.operator_commit_upload(uuid,uuid,text,bigint,text,bigint) from public,anon,authenticated,service_role;
grant execute on function public.operator_context(),public.operator_create_tenant(text,text,date,date),
  public.operator_prepare_upload(jsonb),public.operator_upload_manifest(uuid),public.operator_update_asset(jsonb) to authenticated;
grant execute on function public.operator_commit_upload(uuid,uuid,text,bigint,text,bigint) to service_role;

commit;
