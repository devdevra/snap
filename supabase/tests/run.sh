#!/usr/bin/env bash
set -euo pipefail

# Only run on a fresh, throwaway local CI database. Never accept a remote URI.
if [[ "${CI:-}" != "true" || "${PGDATABASE:-}" != "staycut_test" || "${PGHOST:-}" != "127.0.0.1" || "${PGPORT:-5432}" != "5432" ]]; then
  echo 'Refusing: requires CI=true, PGHOST=127.0.0.1, PGPORT=5432, PGDATABASE=staycut_test.' >&2
  exit 1
fi
if [[ -n "${DATABASE_URL:-}" || -n "${PGSERVICE:-}" || -n "${PGSERVICEFILE:-}" ]]; then
  echo 'Refusing: DATABASE_URL/PGSERVICE overrides are not allowed.' >&2
  exit 1
fi
cd "$(dirname "$0")/../.."
PSQL=(psql -X --set=ON_ERROR_STOP=1 --host=127.0.0.1 --port=5432 --dbname=staycut_test)
schema_count="$("${PSQL[@]}" -Atc "select count(*) from pg_namespace where nspname in ('auth', 'storage', 'staycut_private', 'test')")"
if [[ "$schema_count" != "0" ]]; then
  echo 'Refusing: test database must be empty; no existing auth/storage/application schemas.' >&2
  exit 1
fi
"${PSQL[@]}" --file=supabase/tests/bootstrap.sql
python3 supabase/scripts/build_setup.py --check
"${PSQL[@]}" --file=supabase/setup.sql
"${PSQL[@]}" --file=supabase/tests/regression.sql
python3 supabase/tests/admin_assignment.py
