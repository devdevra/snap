"""Run the exact first-owner SQL template against the disposable CI database."""
from pathlib import Path
import os
import subprocess
import sys


def sql_literal(value):
    return "'" + value.replace("'", "''") + "'"


TEMPLATE = Path(__file__).resolve().parents[1] / 'admin' / 'assign-member.sql'
SOURCE = TEMPLATE.read_text(encoding='utf-8')
MARKERS = ('__AUTH_EMAIL__', '__LODGING_NAME__', '__ACCESS_START_DATE__', '__ACCESS_END_DATE__')


def render(email, name, start='2026-01-01', end='2026-01-07'):
    values = (email, name, start, end)
    delimiter = '$staycut_first_owner$'
    assert SOURCE.count(delimiter) == 2
    candidate = '$staycut_first_owner_rendered_0$'
    suffix = 0
    while any(candidate in value for value in values):
        suffix += 1
        candidate = f'$staycut_first_owner_rendered_{suffix}$'
    result = SOURCE.replace(delimiter, candidate)
    for marker, value in zip(MARKERS, values):
        assert result.count(sql_literal(marker)) == 1
        result = result.replace(sql_literal(marker), sql_literal(value))
    return result


def expected_error(statement, state, label):
    return f'select test.throws({sql_literal(statement)}, {sql_literal(state)}, {sql_literal(label)});'


def main():
    if (os.environ.get('CI') != 'true' or os.environ.get('PGHOST') != '127.0.0.1'
            or os.environ.get('PGPORT', '5432') != '5432'
            or os.environ.get('PGDATABASE') != 'staycut_test'
            or any(os.environ.get(key) for key in ('DATABASE_URL', 'PGSERVICE', 'PGSERVICEFILE'))):
        raise SystemExit('Refusing: requires the disposable local staycut_test CI database.')

    # All identities are synthetic and rolled back, including successful setup.
    owner = '00000000-0000-4000-8000-000000000501'
    other = '00000000-0000-4000-8000-000000000502'
    name = "회귀 숙소 O'Reilly $staycut_first_owner$"
    setup = render('OWNER-ONE@example.invalid', name)
    q_name = sql_literal(name)
    statements = ["""
begin;
insert into auth.users(id,email,email_confirmed_at) values
 ('00000000-0000-4000-8000-000000000501','owner-one@example.invalid',now()),
 ('00000000-0000-4000-8000-000000000502','owner-two@example.invalid',now()),
 ('00000000-0000-4000-8000-000000000503','unconfirmed@example.invalid',null),
 ('00000000-0000-4000-8000-000000000504','duplicate@example.invalid',now()),
 ('00000000-0000-4000-8000-000000000505','DUPLICATE@example.invalid',now());
""",
        expected_error(SOURCE, '22023', 'admin setup refuses unchanged placeholders'),
        expected_error(render('owner-one@example.invalid', name, end='2026-02-30'), '22023', 'invalid calendar date is rejected'),
        expected_error(render('owner-one@example.invalid', name, end='2025-12-31'), '22023', 'reversed access interval is rejected'),
        expected_error(render('absent@example.invalid', name), '42501', 'missing Auth account is not created'),
        expected_error(render('unconfirmed@example.invalid', name), '42501', 'unconfirmed Auth account cannot become owner'),
        expected_error(render('duplicate@example.invalid', name), '42501', 'ambiguous normalized Auth email is rejected'),
        setup,
        f"select test.ok((select count(*)=1 from public.tenants where name={q_name}), 'first setup creates exactly one named tenant with safely quoted input');",
        f"select test.ok((select count(*)=1 from public.tenant_members where user_id='{owner}' and role='owner' and active and access_allowed and access_start_date='2026-01-01' and access_end_date='2026-01-07'), 'first setup assigns exact owner and explicit access interval');",
        "create temporary table first_owner_snapshot on commit drop as select tenant_id from public.tenant_members where user_id='00000000-0000-4000-8000-000000000501';",
        setup,
        f"select test.ok((select count(*)=1 from public.tenant_members m join first_owner_snapshot s using(tenant_id) where m.user_id='{owner}'), 'identical rerun preserves original tenant identity');",
        "select test.ok((select count(*)=1 from public.tenants) and (select count(*)=1 from public.tenant_members), 'identical rerun creates no duplicate rows');",
        expected_error(render('owner-two@example.invalid', '  ' + name.upper() + '  '), '55000', 'normalized name collision never attaches another user'),
        f"select test.ok((select count(*)=0 from public.tenant_members where user_id='{other}'), 'rejected name collision grants no unrelated membership');",
        expected_error(render('owner-one@example.invalid', 'Another fixture lodging'), '55000', 'existing user cannot gain another tenant through first-owner setup'),
        expected_error(render('owner-one@example.invalid', name, end='2026-02-07'), '55000', 'rerun cannot extend access interval'),
        f"select test.ok((select access_end_date='2026-01-07' from public.tenant_members where user_id='{owner}'), 'rejected access extension leaves original interval unchanged');",
        f"update public.tenant_members set role='member' where user_id='{owner}';",
        expected_error(setup, '55000', 'existing ordinary member is never promoted by setup'),
        f"select test.ok((select role='member' from public.tenant_members where user_id='{owner}'), 'rejected promotion preserves existing role');",
        f"update public.tenant_members set role='owner',active=false,access_allowed=false where user_id='{owner}';",
        expected_error(setup, '55000', 'rerun cannot reactivate or reauthorize an existing member'),
        f"select test.ok((select not active and not access_allowed from public.tenant_members where user_id='{owner}'), 'rejected reactivation preserves existing flags');",
        f"update public.tenant_members set active=true,access_allowed=true where user_id='{owner}';",
        f"insert into public.tenant_members(tenant_id,user_id,role,active,access_allowed,access_start_date,access_end_date) select tenant_id,'{other}','member',true,true,'2026-01-01','2026-01-07' from first_owner_snapshot;",
        expected_error(setup, '55000', 'shared tenant is outside bounded first-owner rerun'),
        f"select test.ok((select count(*)=1 from public.tenant_members where user_id='{other}' and role='member' and active and access_allowed and access_end_date='2026-01-07'), 'shared-tenant rejection leaves unrelated member unchanged');",
        "select test.ok((select count(*)=0 from public.assets) and (select count(*)=0 from public.asset_versions) and (select count(*)=0 from public.version_approvals), 'first-owner setup creates no media or approval fixtures');",
        "rollback;",
        "\\echo 'First-owner administrator SQL regression passed.'",
    ]
    result = subprocess.run(
        ['psql', '-X', '--set=ON_ERROR_STOP=1', '--host=127.0.0.1', '--port=5432', '--dbname=staycut_test'],
        input='\n'.join(statements), text=True, capture_output=True, check=False,
    )
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
