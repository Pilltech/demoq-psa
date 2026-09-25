#!/usr/bin/env bash
# Local/CI one-time setup: creates the two roles and the dev database.
# Run as a Postgres superuser (e.g. `sudo -u postgres bash scripts/db-setup.sh`, or with PGUSER=postgres).
# The app role is NOT the owner and NOT a superuser: superusers bypass the grants that make audit append-only.
set -euo pipefail
DB="${1:-demoq_dev}"
psql -v ON_ERROR_STOP=1 -d postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demoq_migrator') THEN
    CREATE ROLE demoq_migrator LOGIN CREATEDB PASSWORD 'demoq_migrator';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demoq_app') THEN
    CREATE ROLE demoq_app LOGIN PASSWORD 'demoq_app';
  END IF;
END \$\$;
SQL
if ! psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB'" | grep -q 1; then
  psql -v ON_ERROR_STOP=1 -d postgres -c "CREATE DATABASE $DB OWNER demoq_migrator"
fi
# Extensions need superuser on some hosts; create them here once so migrations stay role-safe.
psql -v ON_ERROR_STOP=1 -d "$DB" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS btree_gist;"
psql -v ON_ERROR_STOP=1 -d template1 -c "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS btree_gist;"
echo "db-setup: roles demoq_migrator, demoq_app and database $DB ready"
