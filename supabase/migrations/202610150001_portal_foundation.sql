-- Apply with the Supabase migration owner, never from the browser.
begin;

create schema if not exists staycut_private;
revoke all on schema staycut_private from public;
grant usage on schema staycut_private to authenticated, service_role;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  created_at timestamptz not null default now()
);

create table public.tenant_members (
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('owner', 'member')),
  active boolean not null default true,
  access_allowed boolean not null default false,
  access_start_date date not null,
  access_end_date date not null,
  primary key (tenant_id, user_id),
  check (access_start_date <= access_end_date)
);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  title text not null check (length(btrim(title)) between 1 and 200),
  assigned_approver_id uuid not null,
  latest_version_id uuid,
  access_allowed boolean not null default false,
  access_start_date date not null,
  access_end_date date not null,
  rights_status text not null default 'pending' check (rights_status in ('pending', 'valid', 'expired')),
  rights_start_date date not null,
  rights_end_date date not null,
  allowed_channels text[] not null default '{}',
  allowed_purposes text[] not null default '{}',
  final_delivery_paid boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (tenant_id, assigned_approver_id) references public.tenant_members(tenant_id, user_id),
  check (access_start_date <= access_end_date),
  check (rights_start_date <= rights_end_date),
  check (allowed_channels <@ array['instagram', 'youtube']::text[] and array_position(allowed_channels, null) is null),
  check (allowed_purposes <@ array['organic', 'advertising']::text[] and array_position(allowed_purposes, null) is null)
);

create table public.asset_versions (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null,
  tenant_id uuid not null,
  version_number integer not null check (version_number > 0),
  review_status text not null default 'pending' check (review_status in ('pending', 'revision_requested', 'approved')),
  change_summary text not null default '',
  preview_available boolean not null default false,
  delivery_available boolean not null default false,
  -- Upload first, then create the version. A new file always gets a new version/path.
  object_path text not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (asset_id, version_number),
  unique (asset_id, tenant_id, id),
  unique (object_path),
  foreign key (asset_id, tenant_id) references public.assets(id, tenant_id),
  check (object_path like tenant_id::text || '/' || asset_id::text || '/' || id::text || '/%'),
  check (length(object_path) between 1 and 1024 and object_path ~ '^[A-Za-z0-9_./-]+$'
    and object_path !~ '//|/$|(^|/)[.]{1,2}(/|$)')
);

alter table public.assets add constraint assets_latest_version_same_asset
  foreign key (id, tenant_id, latest_version_id)
  references public.asset_versions(asset_id, tenant_id, id);

create table public.version_approvals (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null unique,
  asset_id uuid not null,
  tenant_id uuid not null,
  actor_id uuid not null references auth.users(id),
  channel text not null check (channel in ('instagram', 'youtube')),
  purpose text not null check (purpose in ('organic', 'advertising')),
  -- Preserve the exact approved content and contract scope as an audit snapshot.
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  rights_start_date date not null,
  rights_end_date date not null,
  approved_at timestamptz not null default clock_timestamp(),
  foreign key (asset_id, tenant_id, version_id) references public.asset_versions(asset_id, tenant_id, id),
  foreign key (tenant_id, actor_id) references public.tenant_members(tenant_id, user_id)
);

create table public.revision_requests (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null,
  asset_id uuid not null,
  tenant_id uuid not null,
  actor_id uuid not null references auth.users(id),
  message text not null check (length(message) between 1 and 4000 and message ~ '[^[:space:]]'),
  requested_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  foreign key (asset_id, tenant_id, version_id) references public.asset_versions(asset_id, tenant_id, id),
  foreign key (tenant_id, actor_id) references public.tenant_members(tenant_id, user_id),
  check (resolved_at is null or resolved_at >= requested_at)
);
create unique index one_open_revision_per_asset on public.revision_requests(asset_id) where resolved_at is null;
create index tenant_members_user on public.tenant_members(user_id, tenant_id);
create index assets_tenant on public.assets(tenant_id);
create index asset_versions_tenant on public.asset_versions(tenant_id, asset_id);
create index version_approvals_tenant on public.version_approvals(tenant_id, asset_id);
create index revision_requests_tenant on public.revision_requests(tenant_id, asset_id);

create function staycut_private.contract_today() returns date
language sql stable set search_path = ''
as $$ select (statement_timestamp() at time zone 'Asia/Seoul')::date $$;

create function staycut_private.is_tenant_member(p_tenant_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.tenant_members m
    where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid())
      and m.active and m.access_allowed
      and staycut_private.contract_today() between m.access_start_date and m.access_end_date
  )
$$;

create function staycut_private.can_access_asset(p_asset_id uuid, p_tenant_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.assets a
    where a.id = p_asset_id and a.tenant_id = p_tenant_id
      and staycut_private.is_tenant_member(a.tenant_id)
      and a.access_allowed
      and staycut_private.contract_today() between a.access_start_date and a.access_end_date
  )
$$;

create function staycut_private.preserve_approval() returns trigger
language plpgsql set search_path = ''
as $$ begin raise exception 'approval_history_is_immutable' using errcode = '55000'; end $$;
create trigger immutable_version_approval before update or delete on public.version_approvals
  for each row execute function staycut_private.preserve_approval();
create trigger immutable_version_approval_truncate before truncate on public.version_approvals
  for each statement execute function staycut_private.preserve_approval();

create function staycut_private.preserve_approved_content() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.version_approvals a where a.version_id = old.id)
    and row(new.id, new.asset_id, new.tenant_id, new.version_number, new.object_path, new.content_sha256, new.created_at)
      is distinct from row(old.id, old.asset_id, old.tenant_id, old.version_number, old.object_path, old.content_sha256, old.created_at)
  then
    raise exception 'approved_content_is_immutable_create_new_version' using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger immutable_approved_content before update on public.asset_versions
  for each row execute function staycut_private.preserve_approved_content();

alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;
alter table public.assets enable row level security;
alter table public.asset_versions enable row level security;
alter table public.version_approvals enable row level security;
alter table public.revision_requests enable row level security;

create policy tenant_member_read on public.tenants for select to authenticated
  using (staycut_private.is_tenant_member(id));
create policy member_self_read on public.tenant_members for select to authenticated
  using (user_id = (select auth.uid()) and staycut_private.is_tenant_member(tenant_id));
create policy asset_member_read on public.assets for select to authenticated
  using (staycut_private.can_access_asset(id, tenant_id));
create policy version_member_read on public.asset_versions for select to authenticated
  using (staycut_private.can_access_asset(asset_id, tenant_id));
create policy approval_member_read on public.version_approvals for select to authenticated
  using (staycut_private.can_access_asset(asset_id, tenant_id));
create policy revision_member_read on public.revision_requests for select to authenticated
  using (staycut_private.can_access_asset(asset_id, tenant_id));

-- No browser INSERT/UPDATE/DELETE grants or policies, even for a tenant owner.
revoke all on public.tenants, public.tenant_members, public.assets, public.asset_versions,
  public.version_approvals, public.revision_requests from public, anon, authenticated;
grant select on public.tenants, public.tenant_members, public.assets, public.asset_versions,
  public.version_approvals, public.revision_requests to authenticated;
grant all on public.tenants, public.tenant_members, public.assets, public.asset_versions,
  public.revision_requests to service_role;
-- Approvals can only be inserted by the user-scoped SECURITY DEFINER RPC.
revoke all on public.version_approvals from service_role;
grant select on public.version_approvals to service_role;

create function staycut_private.assert_scope(
  p_asset public.assets, p_channel text, p_purpose text
) returns void language plpgsql set search_path = ''
as $$
begin
  if p_channel is null or p_channel not in ('instagram', 'youtube')
    or p_purpose is null or p_purpose not in ('organic', 'advertising') then
    raise exception 'invalid_usage_scope' using errcode = '22023';
  end if;
  if p_asset.rights_status <> 'valid'
    or staycut_private.contract_today() not between p_asset.rights_start_date and p_asset.rights_end_date
    or not (p_channel = any(p_asset.allowed_channels))
    or not (p_purpose = any(p_asset.allowed_purposes)) then
    raise exception 'usage_rights_unavailable' using errcode = '55000';
  end if;
end
$$;

create function public.approve_asset_version(
  p_version_id uuid, p_channel text, p_purpose text, p_confirmed boolean, p_feedback text default ''
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_asset public.assets;
  v_version public.asset_versions;
  v_approval public.version_approvals;
  v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  -- Every review RPC locks the asset first. A concurrent latest-version change
  -- or second review therefore cannot approve stale content.
  select a.* into v_asset from public.assets a
    join public.asset_versions v on v.asset_id = a.id and v.tenant_id = a.tenant_id
    where v.id = p_version_id for update of a;
  if not found or not staycut_private.can_access_asset(v_asset.id, v_asset.tenant_id) then
    raise exception 'asset_version_unavailable' using errcode = '42501';
  end if;
  select * into v_version from public.asset_versions where id = p_version_id for update;
  if v_asset.latest_version_id is distinct from p_version_id then
    raise exception 'latest_version_required' using errcode = '55000';
  end if;
  if v_asset.assigned_approver_id <> v_actor then
    raise exception 'assigned_approver_required' using errcode = '42501';
  end if;
  if v_version.review_status <> 'pending'
    or exists (select 1 from public.revision_requests r where r.asset_id = v_asset.id and r.resolved_at is null)
    or exists (select 1 from public.version_approvals a where a.version_id = p_version_id) then
    raise exception 'version_not_pending_review' using errcode = '55000';
  end if;
  perform staycut_private.assert_scope(v_asset, p_channel, p_purpose);
  if not v_version.preview_available then
    raise exception 'preview_unavailable' using errcode = '55000';
  end if;
  if p_confirmed is distinct from true or coalesce(p_feedback, '') ~ '[^[:space:]]' then
    raise exception 'explicit_confirmation_without_unsent_feedback_required' using errcode = '22023';
  end if;
  insert into public.version_approvals(version_id, asset_id, tenant_id, actor_id, channel, purpose,
    content_sha256, rights_start_date, rights_end_date)
    values (p_version_id, v_asset.id, v_asset.tenant_id, v_actor, p_channel, p_purpose,
      v_version.content_sha256, v_asset.rights_start_date, v_asset.rights_end_date)
    returning * into v_approval;
  update public.asset_versions set review_status = 'approved' where id = p_version_id;
  return jsonb_build_object('approval_id', v_approval.id, 'version_id', p_version_id, 'approved_at', v_approval.approved_at);
end
$$;

create function public.request_asset_revision(p_version_id uuid, p_message text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_asset public.assets;
  v_version public.asset_versions;
  v_request public.revision_requests;
  v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  if p_message is null or length(p_message) not between 1 and 4000 or p_message !~ '[^[:space:]]' then
    raise exception 'revision_message_required_max_4000' using errcode = '22023';
  end if;
  select a.* into v_asset from public.assets a
    join public.asset_versions v on v.asset_id = a.id and v.tenant_id = a.tenant_id
    where v.id = p_version_id for update of a;
  if not found or not staycut_private.can_access_asset(v_asset.id, v_asset.tenant_id) then
    raise exception 'asset_version_unavailable' using errcode = '42501';
  end if;
  select * into v_version from public.asset_versions where id = p_version_id for update;
  if v_asset.latest_version_id is distinct from p_version_id then
    raise exception 'latest_version_required' using errcode = '55000';
  end if;
  if v_asset.assigned_approver_id <> v_actor then
    raise exception 'assigned_approver_required' using errcode = '42501';
  end if;
  if v_version.review_status <> 'pending'
    or exists (select 1 from public.revision_requests r where r.asset_id = v_asset.id and r.resolved_at is null)
    or exists (select 1 from public.version_approvals a where a.version_id = p_version_id) then
    raise exception 'version_not_pending_review' using errcode = '55000';
  end if;
  insert into public.revision_requests(version_id, asset_id, tenant_id, actor_id, message)
    values (p_version_id, v_asset.id, v_asset.tenant_id, v_actor,
      regexp_replace(p_message, '^[[:space:]]+|[[:space:]]+$', '', 'g')) returning * into v_request;
  update public.asset_versions set review_status = 'revision_requested' where id = p_version_id;
  return jsonb_build_object('request_id', v_request.id, 'version_id', p_version_id, 'requested_at', v_request.requested_at);
end
$$;

create function public.authorize_asset_download(p_version_id uuid, p_channel text, p_purpose text)
returns table(bucket_id text, object_path text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_asset public.assets;
  v_version public.asset_versions;
begin
  if auth.uid() is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  select a.* into v_asset from public.assets a
    join public.asset_versions v on v.asset_id = a.id and v.tenant_id = a.tenant_id
    where v.id = p_version_id for share of a;
  if not found or not staycut_private.can_access_asset(v_asset.id, v_asset.tenant_id) then
    raise exception 'asset_version_unavailable' using errcode = '42501';
  end if;
  select * into v_version from public.asset_versions where id = p_version_id for share;
  if v_asset.latest_version_id is distinct from p_version_id
    or v_version.review_status <> 'approved'
    or not exists (select 1 from public.version_approvals a where a.version_id = p_version_id
      and a.content_sha256 = v_version.content_sha256)
    or exists (select 1 from public.revision_requests r where r.asset_id = v_asset.id and r.resolved_at is null) then
    raise exception 'exact_latest_approved_version_required' using errcode = '55000';
  end if;
  perform staycut_private.assert_scope(v_asset, p_channel, p_purpose);
  if not v_asset.final_delivery_paid then
    raise exception 'final_delivery_payment_required' using errcode = '55000';
  end if;
  if not v_version.delivery_available then
    raise exception 'delivery_file_unavailable' using errcode = '55000';
  end if;
  return query select 'staycut-deliverables'::text, v_version.object_path;
end
$$;

-- PostgreSQL grants new functions to PUBLIC by default; remove that explicitly.
revoke all on all functions in schema staycut_private from public, anon, authenticated;
grant execute on function staycut_private.contract_today(),
  staycut_private.is_tenant_member(uuid), staycut_private.can_access_asset(uuid, uuid) to authenticated;
revoke all on function public.approve_asset_version(uuid, text, text, boolean, text),
  public.request_asset_revision(uuid, text), public.authorize_asset_download(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.approve_asset_version(uuid, text, text, boolean, text),
  public.request_asset_revision(uuid, text), public.authorize_asset_download(uuid, text, text) to authenticated;

insert into storage.buckets(id, name, public) values ('staycut-deliverables', 'staycut-deliverables', false)
  on conflict (id) do update set public = false;
-- A restrictive policy also blocks accidental broad SELECT/upload policies from
-- exposing this bucket. The trusted signing server uses service_role's bypass.
create policy staycut_server_only_storage on storage.objects as restrictive
  for all to anon, authenticated
  using (bucket_id <> 'staycut-deliverables')
  with check (bucket_id <> 'staycut-deliverables');
create policy staycut_server_only_bucket on storage.buckets as restrictive
  for all to anon, authenticated
  using (id <> 'staycut-deliverables')
  with check (id <> 'staycut-deliverables');

commit;
