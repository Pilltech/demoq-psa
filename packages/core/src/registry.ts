// Every command and query, in one list. Adapters (REST now; Telegram and MCP from S2)
// are generated from this registry filtered by each op's exposeTo.
import type { OpDef } from "./kernel";
import * as audit from "./audit";
import * as approvals from "./approvals";
import * as commercial from "./commercial";
import * as crm from "./crm";
import * as identity from "./identity/commands";
import * as influencers from "./influencers";
import * as mcp from "./mcp/commands";
import * as profile from "./profile/commands";
import * as projects from "./projects";
import * as tasks from "./tasks";
import * as time from "./time";

const isOp = (v: unknown): v is OpDef =>
  !!v && typeof v === "object" && "kind" in v && ((v as OpDef).kind === "command" || (v as OpDef).kind === "query");

export const registry: readonly OpDef[] = [
  identity,
  crm,
  audit,
  commercial,
  approvals,
  profile,
  projects,
  tasks,
  influencers,
  time,
  mcp,
]
  .flatMap((m) => Object.values(m))
  .filter(isOp)
  .sort((a, b) => a.name.localeCompare(b.name));

const byName = new Map(registry.map((op) => [op.name, op]));
if (byName.size !== registry.length) throw new Error("Duplicate operation names in registry");

export function getOp(name: string): OpDef | undefined {
  return byName.get(name);
}
