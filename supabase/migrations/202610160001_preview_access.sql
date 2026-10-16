-- Internal customer review is separate from permission to publish/download.
-- Execute after 202610150001_portal_foundation.sql as the migration owner.
begin;

alter table public.asset_versions
  add column preview_object_path text,
  add column preview_content_sha256 text;

-- A legacy "preview ready" flag must never expose the original file. Existing
-- versions have no separate preview yet and remain unavailable until prepared.
update public.asset_versions set preview_available = false where preview_object_path is null and preview_available;

alter table public.asset_versions
  add constraint preview_metadata_pair check (
    (preview_object_path is null and preview_content_sha256 is null)
    or (preview_object_path is not null and preview_content_sha256 is not null)
  ),
  add constraint preview_object_path_safe check (preview_object_path is null or (
    preview_object_path like tenant_id::text || '/' || asset_id::text || '/' || id::text || '/preview/%'
    and length(preview_object_path) between 1 and 1024
    and preview_object_path ~ '^[A-Za-z0-9_./-]+$'
    and preview_object_path !~ '//|/$|(^|/)[.]{1,2}(/|$)'
    and preview_object_path <> object_path
  )),
  add constraint preview_content_is_separate check (preview_content_sha256 is null or (
    preview_content_sha256 ~ '^[0-9a-f]{64}$'
    and preview_content_sha256 <> content_sha256
  )),
  add constraint preview_ready_requires_metadata check (
    not preview_available or (preview_object_path is not null and preview_content_sha256 is not null)
  );

-- An approval identifies both the reviewed preview and the final delivery.
-- Existing approved versions without previews need a new version to add one.
create or replace function staycut_private.preserve_approved_content() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.version_approvals a where a.version_id = old.id)
    and row(new.id, new.asset_id, new.tenant_id, new.version_number, new.object_path, new.content_sha256,
      new.preview_object_path, new.preview_content_sha256, new.created_at)
      is distinct from row(old.id, old.asset_id, old.tenant_id, old.version_number, old.object_path, old.content_sha256,
        old.preview_object_path, old.preview_content_sha256, old.created_at)
  then
    raise exception 'approved_content_is_immutable_create_new_version' using errcode = '55000';
  end if;
  return new;
end
$$;

create function public.authorize_asset_preview(p_version_id uuid)
returns table(bucket_id text, object_path text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_asset public.assets;
  v_version public.asset_versions;
begin
  if auth.uid() is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  select a.* into v_asset from public.assets a
    join public.asset_versions v on v.asset_id = a.id and v.tenant_id = a.tenant_id
    where v.id = p_version_id for share of a;
  if not found or not staycut_private.can_access_asset(v_asset.id, v_asset.tenant_id) then
    raise exception 'asset_version_unavailable' using errcode = '42501';
  end if;
  select * into v_version from public.asset_versions where id = p_version_id for share;
  if v_asset.latest_version_id is distinct from p_version_id then
    raise exception 'latest_version_required' using errcode = '55000';
  end if;
  if not v_version.preview_available or v_version.preview_object_path is null or v_version.preview_content_sha256 is null then
    raise exception 'preview_unavailable' using errcode = '55000';
  end if;
  -- Payment and publication rights are intentionally checked only by the final
  -- download RPC. Members need to review pending or revision-requested content.
  -- Never fall back to the final delivery object, including when no preview
  -- has been generated/uploaded yet.
  return query select 'staycut-deliverables'::text, v_version.preview_object_path;
end
$$;

revoke all on function public.authorize_asset_preview(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_asset_preview(uuid) to authenticated;

commit;
