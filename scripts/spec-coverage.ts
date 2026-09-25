// Principle 8: every rule ID in specs/**/*.md must be cited by at least one test name, e.g.
//   it("[CRM-CR-01] moving to Lost without a reason is refused", …)
// Also reports test citations of IDs that no spec defines (typos).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const RULE_ROW = /^\|\s*([A-Z]{2,4}(?:-[A-Z]{2,4})?-\d{2})\s*\|/gm;
const CITED = /\[([A-Z]{2,4}(?:-[A-Z]{2,4})?-\d{2})\]/g;

function walk(dir: string, pred: (f: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".") || name === "dist") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}

export function coverage() {
  const rules = new Map<string, string>();
  for (const f of walk(path.join(ROOT, "specs"), (p) => p.endsWith(".md") && !p.endsWith("_template.md"))) {
    for (const m of readFileSync(f, "utf8").matchAll(RULE_ROW)) rules.set(m[1]!, path.relative(ROOT, f));
  }
  const cited = new Map<string, Set<string>>();
  const testFiles = walk(ROOT, (p) => /\.(test|spec)\.tsx?$/.test(p));
  for (const f of testFiles) {
    for (const m of readFileSync(f, "utf8").matchAll(CITED)) {
      if (!cited.has(m[1]!)) cited.set(m[1]!, new Set());
      cited.get(m[1]!)!.add(path.relative(ROOT, f));
    }
  }
  const uncovered = [...rules.keys()].filter((id) => !cited.has(id)).sort();
  // INV-* are plan-level invariants, cited by tests but defined in docs/plan; not typos.
  const unknown = [...cited.keys()].filter((id) => !rules.has(id) && !id.startsWith("INV-")).sort();
  return { rules, cited, uncovered, unknown };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { rules, uncovered, unknown } = coverage();
  if (unknown.length) console.error(`Tests cite IDs no spec defines: ${unknown.join(", ")}`);
  if (uncovered.length) {
    console.error(
      `trace:check failed — rules without a test:\n  ${uncovered.map((id) => `${id} (${rules.get(id)})`).join("\n  ")}`,
    );
    process.exit(1);
  }
  if (unknown.length) process.exit(1);
  console.log(`trace:check ok (${rules.size} rules, all cited by tests)`);
}
