// Test databases: one migrated template (psa_template), cloned per test file in ~100 ms.
// Tests connect as the APP role, so grants and triggers are exercised exactly as in prod.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDb, runMigrations, type Database } from "@demoq/db";
import type { Kernel } from "@demoq/core";

export const TEMPLATE_DB = "psa_template";

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}
const adminUrl = () => env("TEST_ADMIN_URL", "postgres://demoq_migrator:demoq_migrator@localhost:5432/postgres");
const withDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};
const appUrlFor = (db: string) => withDb(env("TEST_APP_URL", "postgres://demoq_app:demoq_app@localhost:5432/postgres"), db);

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Build the template from migrations. Called once per test run (vitest globalSetup). */
export async function buildTemplate(): Promise<void> {
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  });
  await runMigrations(withDb(adminUrl(), TEMPLATE_DB));
}

export interface TestDb {
  name: string;
  kernel: Kernel;
  db: Database;
  /** Migrator-role connection, for asserting DB backstops and seeding reference data. */
  migrator: Database;
  clock: { now: Date; set(d: Date | string): void; advance(ms: number): void };
  destroy(): Promise<void>;
}

export async function createTestDb(start = "2026-10-19T02:00:00.000Z"): Promise<TestDb> {
  const name = `psa_test_${randomBytes(5).toString("hex")}`;
  await admin((c) => c.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`));
  const app = createDb(appUrlFor(name), 5);
  const mig = createDb(withDb(adminUrl(), name), 2);
  const clock = {
    now: new Date(start),
    set(d: Date | string) {
      this.now = new Date(d);
    },
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  return {
    name,
    db: app.db,
    migrator: mig.db,
    kernel: { db: app.db, clock: () => clock.now },
    clock,
    async destroy() {
      await app.db.destroy();
      await mig.db.destroy();
      await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}
