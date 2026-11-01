#!/usr/bin/env bash
# Rebuilds a throwaway local database, applies every migration, then runs the test suite.
# Needs a local Postgres. Never points at the real project.
set -u
DB=${1:-rt}
export PGHOST=${PGHOST:-/tmp/pgdata} PGPORT=${PGPORT:-5544} PGUSER=${PGUSER:-pgtest}
cd "$(dirname "$0")/.."
dropdb --if-exists "$DB" && createdb "$DB"
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/00_supabase_stub.sql >/dev/null || { echo "STUB FAILED"; exit 1; }
for f in migrations/*.sql; do
  psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f" >/dev/null || { echo "MIGRATION FAILED: $f"; exit 1; }
done
psql -q -d "$DB" -f tests/01_rls_and_rules.sql 2>&1 | sed -n '/^ result/,$p'
