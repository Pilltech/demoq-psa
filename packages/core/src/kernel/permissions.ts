// The permission matrix, as code. MUST equal docs/permission-matrix.signed.csv
// (`pnpm matrix:check` fails CI otherwise). Changing either needs the PO's approval on the PR.
//
// Scopes: any = every record; team = records of the actor's team; own = records the actor
// owns (client account lead, deal owner, task owner); assigned = records the actor is assigned to.
// Segregation-of-duties rules (no self-approval, admin makes no business approvals) live in
// the approval engine, not here.
import type { Role } from "@demoq/shared";

export type Scope = "any" | "team" | "own" | "assigned";
export type Sprint = "S1" | "S2" | "S3" | "S4" | "S5";

interface PermissionDef {
  since: Sprint;
  grants: Partial<Record<Role, Scope>>;
}

const ALL_STAFF: Partial<Record<Role, Scope>> = {
  ceo: "any",
  director: "any",
  ops_lead: "any",
  finance: "any",
  account_lead: "any",
  project_manager: "any",
  team_lead: "any",
  staff: "any",
  influencer_manager: "any",
  viewer: "any",
};

/** Everyone who does billable or internal work (viewers do not clock in). Admin clocks own time. */
const WORKERS: Partial<Record<Role, Scope>> = {
  ceo: "own",
  director: "own",
  ops_lead: "own",
  finance: "own",
  account_lead: "own",
  project_manager: "own",
  team_lead: "own",
  staff: "own",
  influencer_manager: "own",
  admin: "own",
};

export const PERMISSIONS = {
  // --- S1: identity, admin, audit ---------------------------------------------
  "user.directory": { since: "S1", grants: { ...ALL_STAFF, admin: "any" } },
  "user.manage": { since: "S1", grants: { admin: "any" } },
  "team.manage": { since: "S1", grants: { admin: "any" } },
  "audit.view": { since: "S1", grants: { ceo: "any", director: "any", ops_lead: "any", admin: "any" } },
  "admin.config": { since: "S1", grants: { admin: "any" } },
  // --- S1: CRM -----------------------------------------------------------------
  "client.view": { since: "S1", grants: ALL_STAFF },
  "client.manage": { since: "S1", grants: { account_lead: "own", ops_lead: "any", director: "any", ceo: "any" } },
  "deal.view": {
    since: "S1",
    grants: { account_lead: "any", ops_lead: "any", director: "any", ceo: "any", finance: "any", viewer: "any" },
  },
  "deal.manage": { since: "S1", grants: { account_lead: "own", ops_lead: "any", director: "any", ceo: "any" } },
  "deal.reopen": { since: "S1", grants: { ops_lead: "any", director: "any", ceo: "any" } },
  "close_reason.view": { since: "S1", grants: { ...ALL_STAFF, admin: "any" } },
  "close_reason.manage": { since: "S1", grants: { admin: "any" } },
  // --- S2: quotes and approvals ---------------------------------------------------
  "quote.edit": { since: "S2", grants: { account_lead: "own", ops_lead: "any" } },
  "quote.submit": { since: "S2", grants: { account_lead: "own", ops_lead: "any" } },
  "quote.send": { since: "S2", grants: { account_lead: "own", ops_lead: "any", director: "any" } },
  // CEO only if decision D24 says the CEO counts as Ops. Never the requester (approval engine).
  "quote.approve_below_floor": { since: "S2", grants: { finance: "any", ops_lead: "any" } },
  "finance.view_costs": {
    since: "S2",
    grants: { finance: "any", ops_lead: "any", director: "any", ceo: "any", account_lead: "own" },
  },
  "approval.override": { since: "S2", grants: { director: "any", ceo: "any" } },
  // Everyone sees their own inbox; what they may DECIDE is each approval's required_permission.
  "approval.view": { since: "S2", grants: { ...ALL_STAFF, admin: "any" } },
  // Jobs only (no role holds it): the escalation job runs with this explicit grant (KER-12).
  "approval.escalate": { since: "S2", grants: {} },
  "pricing.view": {
    since: "S2",
    grants: { ceo: "any", director: "any", ops_lead: "any", finance: "any", account_lead: "any", viewer: "any", admin: "any" },
  },
  "fx.manage": { since: "S2", grants: { finance: "any" } },
  // Link my Telegram, issue my own MCP tokens.
  "profile.manage": { since: "S2", grants: { ...ALL_STAFF, admin: "any" } },
  // --- S3: scope, projects, gates, tasks -----------------------------------------
  "quote.accept": { since: "S3", grants: { account_lead: "own", ops_lead: "any" } },
  "change_order.manage": { since: "S3", grants: { account_lead: "own", ops_lead: "any", project_manager: "assigned" } },
  "client.gate_exemption": { since: "S3", grants: { finance: "any", ops_lead: "any" } },
  "project.activate": { since: "S3", grants: { project_manager: "assigned", ops_lead: "any" } },
  "gate.satisfy": { since: "S3", grants: { project_manager: "assigned", ops_lead: "any" } },
  "project.bypass.request": { since: "S3", grants: { project_manager: "assigned", account_lead: "own" } },
  "project.bypass.approve": { since: "S3", grants: { ops_lead: "any", director: "any" } },
  "project.bypass.review": { since: "S3", grants: { director: "any", ceo: "any" } },
  "project.view": { since: "S3", grants: ALL_STAFF },
  "project.manage": { since: "S3", grants: { project_manager: "assigned", ops_lead: "any" } },
  // Jobs only: retainer periods, bypass expiry and monthly review (KER-12).
  "project.jobs": { since: "S3", grants: {} },
  "task.manage": { since: "S3", grants: { project_manager: "assigned", team_lead: "team" } },
  // Out-of-scope task requests are decided from S3 (TSK-TK-02); absorbed-value reporting follows in S4.
  "scope.oos.decide": { since: "S3", grants: { account_lead: "own", ops_lead: "any", director: "any" } },
  "task.move_own": { since: "S3", grants: { staff: "own", team_lead: "own", project_manager: "own" } },
  // --- S4: delivery, time, influencers -----------------------------------------
  "task.quality_approve": { since: "S4", grants: { team_lead: "team", project_manager: "assigned", ops_lead: "any" } },
  "attendance.clock_own": { since: "S4", grants: WORKERS },
  "time.allocate_own": { since: "S4", grants: WORKERS },
  "time.reopen": { since: "S4", grants: { team_lead: "team", ops_lead: "any" } },
  "leave.approve": { since: "S4", grants: { team_lead: "team", ops_lead: "any", director: "any" } },
  "influencer.link.issue": { since: "S4", grants: { influencer_manager: "any", project_manager: "assigned" } },
  "influencer.work.approve": { since: "S4", grants: { influencer_manager: "any", project_manager: "assigned" } },
  // Added with the S4 defaults (PO to countersign): who requests leave, sees a team's time, keeps the influencer
  // roster; job-only grants for attendance auto-close / timesheet reminders and link expiry (KER-12).
  "leave.request_own": { since: "S4", grants: WORKERS },
  "time.view_team": { since: "S4", grants: { team_lead: "team", ops_lead: "any", director: "any" } },
  "influencer.manage": { since: "S4", grants: { influencer_manager: "any", ops_lead: "any" } },
  "time.jobs": { since: "S4", grants: {} },
  "influencer.jobs": { since: "S4", grants: {} },
  // --- S5: reporting and billing import ------------------------------------------
  "billing.import": { since: "S5", grants: { finance: "any" } },
  "report.ceo": { since: "S5", grants: { ceo: "any", director: "any" } },
  "report.finance": { since: "S5", grants: { finance: "any", director: "any", ceo: "any" } },
} as const satisfies Record<string, PermissionDef>;

export type Permission = keyof typeof PERMISSIONS;

/** Flattened rows, sorted — the shape of the signed CSV. */
export function matrixRows(): { permission: string; role: Role; scope: Scope; since: Sprint }[] {
  const rows: { permission: string; role: Role; scope: Scope; since: Sprint }[] = [];
  for (const [permission, def] of Object.entries(PERMISSIONS) as [string, PermissionDef][]) {
    for (const [role, scope] of Object.entries(def.grants) as [Role, Scope | undefined][]) {
      if (scope) rows.push({ permission, role, scope, since: def.since });
    }
  }
  return rows.sort((a, b) => a.permission.localeCompare(b.permission) || a.role.localeCompare(b.role));
}
