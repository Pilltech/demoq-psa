// Regenerates src/types.ts (Kysely) and ../schema.sql from the migrated dev DB.
// Run after every migration: `pnpm db:types`. Never edit types.ts by hand.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const url = process.env.MIGRATOR_DATABASE_URL;
if (!url) throw new Error("MIGRATOR_DATABASE_URL is not set");
const out = path.resolve(import.meta.dirname, "types.ts");

execFileSync(
  "npx",
  ["kysely-codegen", "--url", url, "--out-file", out, "--exclude-pattern", "schema_migrations", "--date-parser", "string"],
  {
    stdio: "inherit",
  },
);
// Money and ids stored as int8 are parsed as bigint (see db.ts); make the types say so.
const src = readFileSync(out, "utf8").replace(
  /export type Int8 = ColumnType<string, (.*)>;/,
  "export type Int8 = ColumnType<bigint, $1>;",
);
writeFileSync(out, src);

const schema = execFileSync("pg_dump", ["--schema-only", "--no-owner", "--no-privileges", url], { encoding: "utf8" })
  .split("\n")
  .filter((l) => !l.startsWith("-- Dumped") && !l.startsWith("\\restrict") && !l.startsWith("\\unrestrict"))
  .join("\n");
writeFileSync(path.resolve(import.meta.dirname, "../schema.sql"), schema);
console.log("db:types: types.ts and schema.sql regenerated");
