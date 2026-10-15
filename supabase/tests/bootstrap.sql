-- Minimal Supabase interfaces for disposable PostgreSQL regression tests only.
-- This is deliberately NOT a migration and MUST NOT run against a real project.
\set ON_ERROR_STOP on
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema storage;
create table storage.buckets(id text primary key, name text not null, public boolean not null default false);
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null);
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
grant select, insert, update, delete on storage.buckets to anon, authenticated, service_role;
-- Simulate a previously installed, accidentally broad Storage policy. The new
-- restrictive policy must still deny browser reads/writes of our private bucket.
create policy existing_broad_policy on storage.objects for all to anon, authenticated using (true) with check (true);
create policy existing_broad_bucket_policy on storage.buckets for all to anon, authenticated using (true) with check (true);

create schema test;
grant usage on schema test to anon, authenticated, service_role;
create function test.ok(p_value boolean, p_label text) returns void language plpgsql
as $$ begin
  if p_value is distinct from true then raise exception 'FAILED: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end $$;
create function test.throws(p_statement text, p_sqlstate text, p_label text) returns void language plpgsql
as $$ begin
  begin
    execute p_statement;
  exception when others then
    if sqlstate = p_sqlstate then raise notice 'PASS: %', p_label; return; end if;
    raise exception 'FAILED: % (expected %, got %: %)', p_label, p_sqlstate, sqlstate, sqlerrm;
  end;
  raise exception 'FAILED: % (expected error %)', p_label, p_sqlstate;
end $$;
