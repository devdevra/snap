"""Package ordered migrations into the fresh-project SQL Editor script."""
from pathlib import Path
import argparse
import re

root = Path(__file__).resolve().parents[1]
parts = []
for path in sorted((root / 'migrations').glob('*.sql')):
    source = path.read_text()
    for marker in ('begin', 'commit'):
        if len(re.findall(rf'^{marker};$', source, re.M)) != 1:
            raise SystemExit(f'{path.name}: expected one outer {marker} statement')
        source = re.sub(rf'^{marker};\n?', '', source, count=1, flags=re.M)
    parts.append('-- SOURCE: ' + path.name + '\n' + source.strip())

header = """-- STAYCUT fresh-project setup. Generated from migrations; apply once in SQL Editor.
-- Target project: adyhefvhfabwkfdwwjiz. No users, memberships, payments, or sample data are created.
-- Existing installations must apply only missing migration files instead of this bundle.
begin;
do $setup$
begin
  if to_regclass('public.tenants') is not null then
    raise exception 'STAYCUT already exists. Apply only missing migrations instead of setup.sql.';
  end if;
end
$setup$;

"""
expected = header + '\n\n'.join(parts) + '\n\ncommit;\n'
parser = argparse.ArgumentParser()
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
target = root / 'setup.sql'
if args.check:
    if not target.exists() or target.read_text() != expected:
        raise SystemExit('setup.sql is stale: run python3 supabase/scripts/build_setup.py')
else:
    target.write_text(expected)
print(f'Setup bundle matches {len(parts)} migrations.')
