import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "./types";

// int8 → bigint (money in minor units, audit ids). Never parse money as a JS number.
pg.types.setTypeParser(20, (v) => BigInt(v));
// date → plain 'YYYY-MM-DD' string; business dates are calendar dates in Asia/Phnom_Penh, not instants.
pg.types.setTypeParser(1082, (v) => v);

export type Database = Kysely<DB>;

export function createDb(connectionString: string, max = 10): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString, max });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}
