#!/usr/bin/env bash
# Fresh, seeded database + built PWA + API on :3100, for Playwright. Synthetic data only.
set -euo pipefail
cd "$(dirname "$0")/.."
DB=demoq_e2e
ADMIN="${TEST_ADMIN_URL:-postgres://demoq_migrator:demoq_migrator@localhost:5432/postgres}"
psql "$ADMIN" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
MIG="${ADMIN%/*}/$DB"
APP="$(echo "$MIG" | sed 's#demoq_migrator:demoq_migrator#demoq_app:demoq_app#')"
MIGRATOR_DATABASE_URL="$MIG" node --import tsx packages/db/src/migrate.ts >/dev/null
DATABASE_URL="$APP" node --import tsx packages/testkit/src/seed.ts >/dev/null
[ -f apps/web/dist/index.html ] || pnpm -s build:web >/dev/null
export DATABASE_URL="$APP" PORT=3100 HOST=127.0.0.1 NODE_ENV=test WEB_DIST="$PWD/apps/web/dist" \
  TOTP_ENC_KEY="${TOTP_ENC_KEY:-$(openssl rand -base64 32)}" LOGIN_RATE_PER_MIN=1000
# The worker drains the outbox (send-when-approved, Telegram cards) exactly as in production.
node --import tsx apps/api/src/worker.ts &
WORKER=$!
trap 'kill $WORKER 2>/dev/null' EXIT INT TERM
node --import tsx apps/api/src/server.ts
