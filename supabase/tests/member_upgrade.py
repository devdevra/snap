"""Verify migration 4 preserves an existing installation in the disposable CI DB."""
from pathlib import Path
import os
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ('202610150001_portal_foundation.sql', '202610160001_preview_access.sql',
              '202610160002_operator_uploads.sql', '202610160003_operator_members.sql')


def migration(name):
    source = (ROOT / 'migrations' / name).read_text(encoding='utf-8')
    for marker in ('begin', 'commit'):
        if len(re.findall(rf'^{marker};$', source, re.M)) != 1:
            raise SystemExit(f'{name}: expected one outer {marker} statement')
        source = re.sub(rf'^{marker};\n?', '', source, count=1, flags=re.M)
    return source


def script():
    # No real users/files are involved. Approval is created by the original RPC.
    user, revoked, tenant, asset, version = [f'00000000-0000-4000-8000-{n:012d}' for n in range(3101, 3106)]
    fixture = f"""
insert into auth.users(id,email,email_confirmed_at) values
 ('{user}','upgrade-owner@example.invalid',now()),('{revoked}','upgrade-revoked@example.invalid',now());
insert into public.tenants(id,name) values ('{tenant}','Synthetic existing upgrade tenant');
insert into public.tenant_members(tenant_id,user_id,role,active,access_allowed,access_start_date,access_end_date) values
 ('{tenant}','{user}','owner',true,true,staycut_private.contract_today()-10,staycut_private.contract_today()+10),
 ('{tenant}','{revoked}','member',false,false,staycut_private.contract_today()-20,staycut_private.contract_today()-1);
insert into public.portal_operators(user_id,active) values ('{user}',true);
insert into public.assets(id,tenant_id,title,assigned_approver_id,access_allowed,access_start_date,access_end_date,
 rights_status,rights_start_date,rights_end_date,allowed_channels,allowed_purposes,final_delivery_paid) values
 ('{asset}','{tenant}','Existing approved clip','{user}',true,staycut_private.contract_today()-10,staycut_private.contract_today()+10,
 'valid',staycut_private.contract_today()-10,staycut_private.contract_today()+10,array['instagram'],array['organic'],false);
insert into public.asset_versions(id,asset_id,tenant_id,version_number,object_path,content_sha256,preview_available,
 preview_object_path,preview_content_sha256,delivery_available) values
 ('{version}','{asset}','{tenant}',1,'{tenant}/{asset}/{version}/delivery.mp4',repeat('a',64),true,
 '{tenant}/{asset}/{version}/preview/review.webm',repeat('b',64),true);
update public.assets set latest_version_id='{version}' where id='{asset}';
select set_config('request.jwt.claim.sub','{user}',true);
set local role authenticated;
select public.approve_asset_version('{version}','instagram','organic',true);
reset role;
create temporary table upgrade_members on commit drop as select to_jsonb(m) value from public.tenant_members m;
create temporary table upgrade_assets on commit drop as select to_jsonb(a) value from public.assets a;
create temporary table upgrade_versions on commit drop as select to_jsonb(v) value from public.asset_versions v;
create temporary table upgrade_approvals on commit drop as select to_jsonb(a) value from public.version_approvals a;
"""
    checks = f"""
select test.ok((select count(*)=2 and bool_and(revision=1) from public.tenant_members),'upgrade gives every existing member revision one');
select test.ok(not exists((select to_jsonb(m)-'revision' from public.tenant_members m except select value from upgrade_members)
 union all (select value from upgrade_members except select to_jsonb(m)-'revision' from public.tenant_members m)),
 'upgrade preserves exact active and revoked membership flags, roles and periods');
select test.ok((select to_jsonb(a)=s.value from public.assets a cross join upgrade_assets s),'upgrade preserves exact asset terms and latest pointer');
select test.ok((select to_jsonb(v)=s.value and v.review_status='approved' from public.asset_versions v cross join upgrade_versions s),
 'upgrade preserves approved version metadata and hashes');
select test.ok((select to_jsonb(a)=s.value from public.version_approvals a cross join upgrade_approvals s),
 'upgrade preserves exact approval actor and historical evidence');
select test.ok((select bool_and(has_function_privilege('authenticated',p.oid,'execute')
 and not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('service_role',p.oid,'execute')) and count(*)=3
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
 and p.proname in ('operator_add_member','operator_update_member','operator_assign_approver')),
 'upgrade grants management RPCs only to authenticated users');
set local role authenticated;
select public.operator_update_member(jsonb_build_object('tenantId','{tenant}','userId','{revoked}','expectedRevision',1,
 'active',false,'accessAllowed',false,'accessStartDate',staycut_private.contract_today()-20,'accessEndDate',staycut_private.contract_today()-1));
reset role;
select test.ok((select revision=2 and not active and not access_allowed and role='member' from public.tenant_members where user_id='{revoked}'),
 'new update RPC advances revision of a preexisting member without reactivation');
select test.throws($q$update public.asset_versions set content_sha256=repeat('c',64) where id='{version}'$q$,'55000',
 'upgrade retains approved file immutability');
select test.throws($q$delete from public.version_approvals where version_id='{version}'$q$,'55000',
 'upgrade retains approval deletion protection');
select test.throws($q$update public.version_approvals set actor_id='{revoked}' where version_id='{version}'$q$,'55000',
 'upgrade retains approval actor immutability');
rollback;
select test.ok(to_regclass('public.tenants') is null and to_regnamespace('staycut_private') is null
 and not exists(select 1 from storage.buckets where id='staycut-deliverables'),'upgrade fixture and all migrations fully roll back');
select test.ok(to_regprocedure('auth.uid()') is not null and to_regprocedure('test.ok(boolean,text)') is not null
 and not exists(select 1 from auth.users where id in ('{user}','{revoked}')),'upgrade rollback preserves bootstrap and removes synthetic identities');
"""
    return '\n'.join(['begin;', *(migration(name) for name in MIGRATIONS[:3]), fixture, migration(MIGRATIONS[3]), checks])


def main():
    if (os.environ.get('CI') != 'true' or os.environ.get('PGHOST') != '127.0.0.1'
            or os.environ.get('PGPORT', '5432') != '5432' or os.environ.get('PGDATABASE') != 'staycut_test'
            or any(os.environ.get(key) for key in ('DATABASE_URL', 'PGSERVICE', 'PGSERVICEFILE'))):
        raise SystemExit('Refusing: requires the disposable local staycut_test CI database.')
    result = subprocess.run(['psql', '-X', '--quiet', '--set=ON_ERROR_STOP=1', '--host=127.0.0.1',
                             '--port=5432', '--dbname=staycut_test'], input=script(), text=True, capture_output=True, check=False)
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    if result.returncode == 0:
        print('Member upgrade preservation regression passed (12 assertions).')
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
