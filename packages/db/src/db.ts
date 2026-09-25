import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "./types";

// int8 → bigint (money in minor units, audit ids). Never parse money as a JS number.
pg.types.setTypeParser(20, (v) => BigInt(v));
// date → plain 'YYYY-MM-DD' string; business dates are calendar dates in Asia/Phnom_Penh, not instants.
pg.types.setTypeParser(1082, (v) => v);

export type Database = Kysely<DB>;

export function createDb(connectionString: string, max = 10): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString,
    max,
    // Fail fast instead of hanging forever when the pool is exhausted or a lock is held too long.
    connectionTimeoutMillis: 5_000,
    options: "-c lock_timeout=5000 -c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000",
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}
