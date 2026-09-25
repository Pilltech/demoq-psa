// KER-09 / KER-10: the permission matrix in code must equal the signed CSV, and every
// operation must reference a permission that exists, have a summary and at least one channel.
// `pnpm matrix:check --print` prints the CSV the code implies (paste into a PR for the PO to sign).
import { readFileSync } from "node:fs";
import path from "node:path";
import { matrixRows, PERMISSIONS, registry } from "@demoq/core";

const CSV = path.resolve(import.meta.dirname, "../docs/permission-matrix.signed.csv");
const HEADER = "permission,role,scope,since";

export function codeCsv(): string {
  return [HEADER, ...matrixRows().map((r) => [r.permission, r.role, r.scope, r.since].join(","))].join("\n") + "\n";
}

export function check(): string[] {
  const problems: string[] = [];
  const signed = readFileSync(CSV, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (signed[0] !== HEADER) problems.push(`CSV header must be "${HEADER}"`);
  const want = new Set(signed.slice(1));
  const have = new Set(codeCsv().trim().split("\n").slice(1));
  for (const r of have) if (!want.has(r)) problems.push(`In code, not signed: ${r}`);
  for (const r of want) if (!have.has(r)) problems.push(`Signed, not in code: ${r}`);
  for (const op of registry) {
    if (!(op.permission in PERMISSIONS)) problems.push(`${op.name}: unknown permission ${op.permission}`);
    if (!op.summary?.trim()) problems.push(`${op.name}: missing summary`);
    if (!op.exposeTo.length) problems.push(`${op.name}: exposed on no channel`);
    if (!/^[a-z_]+(\.[a-z_]+)+$/.test(op.name)) problems.push(`${op.name}: name must be resource.action`);
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--print")) {
    process.stdout.write(codeCsv());
  } else {
    const problems = check();
    if (problems.length) {
      console.error(`matrix:check failed:\n  ${problems.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`matrix:check ok (${matrixRows().length} grants, ${registry.length} operations)`);
  }
}
