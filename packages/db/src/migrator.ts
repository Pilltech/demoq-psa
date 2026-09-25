// Migration runner, ported from dina-pos/src/migrate.ts with three changes (ADR-0014):
//  1. runs as the migrator role (MIGRATOR_DATABASE_URL), never the app role;
//  2. holds a Postgres advisory lock so two deploys cannot migrate at once;
//  3. stores a checksum and refuses to run if an applied file was edited.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../migrations");
const LOCK_KEY = 72_410_001; // arbitrary, stable

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(connectionString: string, log: (line: string) => void = () => {}): Promise<MigrateResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const result: MigrateResult = { applied: [], skipped: [] };
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const applied = new Map(
      (await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows.map((r) => [
        r.name,
        r.checksum,
      ]),
    );
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = applied.get(file);
      if (prior) {
        if (prior !== checksum) {
          throw new Error(`MIGRATION_EDITED: ${file} was changed after it was applied. Write a new migration instead.`);
        }
        result.skipped.push(file);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(file);
      log(`apply  ${file}`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
  return result;
}
