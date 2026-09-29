// The one pipeline every mutation goes through, on every channel (principle 3):
//   validate → open tx + actor context → load (FOR UPDATE) → authorize → run → audit → outbox → commit
// The command name is the permission-checked action, the audit action and the MCP tool source.
import { sql } from "kysely";
import type { z } from "zod";
import type { Database } from "@demoq/db";
import { DomainError } from "./errors";
import { assertCan, rowFilter, type ResourceScope } from "./policy";
import type { Permission } from "./permissions";
import type { Channel, Ctx, RequestMeta } from "./types";

export interface Subject {
  type: string;
  id: string;
}

interface OpBase<I extends z.ZodTypeAny, R, L> {
  name: string;
  /** One line; becomes the OpenAPI summary and the MCP tool description. */
  summary: string;
  permission: Permission;
  input: I;
  /** Channels this operation is exposed on. Adapters are generated from this. */
  exposeTo: readonly Channel[];
  /** Load the target record(s). Commands should lock with FOR UPDATE. */
  load?: (ctx: Ctx, input: z.output<I>) => Promise<L>;
  /** Relate the loaded record (or the input, for creates) to people, for own/team/assigned grants. */
  scope?: (loaded: L, input: z.output<I>, ctx: Ctx) => ResourceScope;
  run: (ctx: Ctx, input: z.output<I>, loaded: L) => Promise<R>;
  subject?: (input: z.output<I>, result: R, loaded: L) => Subject | undefined;
}

export interface CommandDef<I extends z.ZodTypeAny = z.ZodTypeAny, R = unknown, L = unknown> extends OpBase<I, R, L> {
  kind: "command";
  /** 'high' ⇒ step-up on web, two taps on Telegram, DECIDE_IN_APP on MCP (from S2). */
  risk: "normal" | "high";
}

export interface QueryDef<I extends z.ZodTypeAny = z.ZodTypeAny, R = unknown, L = unknown> extends OpBase<I, R, L> {
  kind: "query";
  /** Reads are audited on these channels ("every action audited by name" for MCP). */
  auditOn: readonly Channel[];
  /** Set when run() applies rowFilter() itself; otherwise unscoped queries need an `any` grant (KER-11). */
  rowFiltered?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry of ops
export type OpDef = CommandDef<any, any, any> | QueryDef<any, any, any>;

export function defineCommand<I extends z.ZodTypeAny, R, L = undefined>(
  def: Omit<CommandDef<I, R, L>, "kind" | "risk"> & { risk?: "normal" | "high" },
): CommandDef<I, R, L> {
  return { ...def, kind: "command", risk: def.risk ?? "normal" };
}

export function defineQuery<I extends z.ZodTypeAny, R, L = undefined>(
  def: Omit<QueryDef<I, R, L>, "kind" | "auditOn"> & { auditOn?: readonly Channel[] },
): QueryDef<I, R, L> {
  return { ...def, kind: "query", auditOn: def.auditOn ?? ["mcp"] };
}

export interface Kernel {
  db: Database;
  clock: () => Date;
}

// Postgres constraint name → domain error. Keeps DB backstop failures readable.
const CONSTRAINT_ERRORS: Record<string, DomainError["code"]> = {
  deals_close_reason_required: "CLOSE_REASON_REQUIRED",
  deals_close_reason_code_close_reason_kind_fkey: "CLOSE_REASON_INVALID",
  quotes_locked: "QUOTE_LOCKED",
  approvals_no_self_approval: "SELF_APPROVAL",
  quotes_floor_backstop: "MARGIN_BELOW_FLOOR",
  tasks_scope_link: "OUT_OF_SCOPE_REQUIRED",
  tasks_gate_blocked: "GATE_BLOCKED",
  project_gates_exemption_required: "GATE_EXEMPTION_REQUIRED",
  gate_bypasses_reason: "BYPASS_INVALID",
  gate_bypasses_expiry: "BYPASS_INVALID",
  gate_bypasses_approved_by_human: "BYPASS_INVALID",
  change_order_lines_additive_qty: "CHANGE_ORDER_NOT_ADDITIVE",
  change_order_lines_additive_price: "CHANGE_ORDER_NOT_ADDITIVE",
  task_dependencies_not_self: "DEPENDENCY_CYCLE",
  // S4 delivery (INV-09, INV-10)
  tasks_revision_round_max: "REVISION_HARD_STOP",
  tasks_revision_round_absorb: "OOS_DECISION_REQUIRED",
  tasks_qc_required: "QC_REQUIRED",
  tasks_revision_step: "INVALID_TRANSITION",
  tasks_client_states: "INVALID_TRANSITION",
  // S4 influencers (INF-*)
  influencer_assignments_scope_item: "VALIDATION",
  work_log_links_gate_blocked: "GATE_BLOCKED",
  work_log_links_terminal: "INVALID_TRANSITION",
  influencer_work_logs_gate_blocked: "GATE_BLOCKED",
  influencer_work_logs_link_inactive: "LINK_EXPIRED",
  influencer_work_logs_own_assignment: "NOT_FOUND",
  influencer_work_logs_immutable: "INVALID_TRANSITION",
  influencer_work_logs_approval_required: "INVALID_TRANSITION",
  // S4 time (specs/time/*)
  attendance_sessions_one_open: "CLOCK_RUNNING",
  attendance_sessions_no_overlap: "TIME_OVERLAP",
  timesheet_week_confirmed: "TIMESHEET_CONFIRMED",
  time_allocations_gate_blocked: "GATE_BLOCKED",
  time_allocations_day_cap: "VALIDATION",
  time_allocations_target: "VALIDATION",
  timesheet_weeks_reopen_reason: "VALIDATION",
  leave_requests_no_overlap: "LEAVE_OVERLAP",
  leave_requests_approved_by_approval: "FORBIDDEN",
  leave_requests_fixed: "VALIDATION",
};

function translatePgError(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string };
  if (e && typeof e.code === "string") {
    if (e.constraint && CONSTRAINT_ERRORS[e.constraint]) {
      return new DomainError(CONSTRAINT_ERRORS[e.constraint]!, { constraint: e.constraint });
    }
    if (e.code === "23505") return new DomainError("CONFLICT", { constraint: e.constraint });
    // Deadlock / serialization failure: the other writer won; the client reloads and retries.
    if (e.code === "40P01" || e.code === "40001") return new DomainError("STALE_VERSION", { reason: e.code });
    if (e.code === "23503") return new DomainError("VALIDATION", { constraint: e.constraint });
    if (e.code === "22003") return new DomainError("VALIDATION", { reason: "out_of_range" }); // numeric overflow
  }
  return err;
}

const SECRET_KEY = /pass(word)?|secret|token|^code$|totp/i;
/** JSON-safe, secret-free copy of the input for the audit row. */
export function redact(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[redacted]" : redact(v)]));
  }
  return value;
}

function actorFields(meta: RequestMeta) {
  const a = meta.actor;
  return {
    actor_type: a.type,
    actor_id: a.type === "user" ? a.id : null,
    actor_name: a.name,
  };
}

export async function writeAudit(
  db: Database | Ctx["tx"],
  meta: RequestMeta,
  row: { action: string; subject?: Subject; input?: unknown; outcome?: "ok" | "denied"; errorCode?: string },
): Promise<void> {
  await db
    .insertInto("audit_events")
    .values({
      action: row.action,
      ...actorFields(meta),
      channel: meta.channel,
      subject_type: row.subject?.type ?? null,
      subject_id: row.subject?.id ?? null,
      request_id: meta.requestId,
      on_behalf_of: meta.onBehalfOf ?? null,
      mcp_client: meta.mcpClient ?? null,
      input: JSON.stringify(redact(row.input ?? {})),
      outcome: row.outcome ?? "ok",
      error_code: row.errorCode ?? null,
    })
    .execute();
}

/** Actor context for the row-change audit trigger (transaction-local). */
export async function setActorContext(tx: Ctx["tx"], meta: RequestMeta): Promise<void> {
  const a = meta.actor;
  await sql`SELECT
      set_config('app.actor_id', ${a.type === "user" ? a.id : ""}, true),
      set_config('app.actor_name', ${a.name}, true),
      set_config('app.channel', ${meta.channel}, true),
      set_config('app.request_id', ${meta.requestId}, true)`.execute(tx);
}

export async function execute<I extends z.ZodTypeAny, R, L>(
  kernel: Kernel,
  meta: RequestMeta,
  op: CommandDef<I, R, L> | QueryDef<I, R, L>,
  rawInput: unknown,
): Promise<R> {
  if (!op.exposeTo.includes(meta.channel)) {
    await auditDenied(kernel, meta, op, rawInput); // KER-05: channel refusals are audited too
    throw new DomainError("FORBIDDEN", { reason: "channel", channel: meta.channel });
  }
  const parsed = op.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw new DomainError("VALIDATION", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const input = parsed.data as z.output<I>;
  // Fail fast (and without a transaction) when the actor holds no grant at all.
  const filter = rowFilter(meta.actor, op.permission);
  if (!filter) {
    await auditDenied(kernel, meta, op, input);
    throw new DomainError("FORBIDDEN", { permission: op.permission });
  }
  // KER-11: a query with no `scope` must either be readable with an `any` grant, or declare that it
  // filters rows itself (`rowFiltered`). Otherwise an own/team-scoped actor would see every row.
  if (op.kind === "query" && !op.scope && !op.rowFiltered && filter.kind !== "any") {
    await auditDenied(kernel, meta, op, input);
    throw new DomainError("FORBIDDEN", { permission: op.permission, reason: "unscoped_query" });
  }

  const builder = kernel.db.transaction();
  try {
    return await (op.kind === "query" ? builder.setAccessMode("read only") : builder)
      .execute(async (tx) => {
        const events: { event: string; payload: Record<string, unknown> }[] = [];
        const ctx: Ctx = { ...meta, tx, now: kernel.clock(), emit: (event, payload) => events.push({ event, payload }) };
        if (op.kind === "command") await setActorContext(tx, meta);
        const loaded = (op.load ? await op.load(ctx, input) : undefined) as L;
        if (op.scope) assertCan(meta.actor, op.permission, op.scope(loaded, input, ctx));
        else if (op.kind === "command") assertCan(meta.actor, op.permission);
        const result = await op.run(ctx, input, loaded);
        const subject = op.subject?.(input, result, loaded);
        if (op.kind === "command") {
          await writeAudit(tx, meta, { action: op.name, subject, input });
          if (events.length) {
            await tx
              .insertInto("outbox")
              .values(
                events.map((e) => ({ event: e.event, payload: JSON.stringify(redact(e.payload)), request_id: meta.requestId })),
              )
              .execute();
          }
        }
        return result;
      })
      .then(async (result) => {
        // Audited reads run outside the read-only transaction.
        if (op.kind === "query" && op.auditOn.includes(meta.channel)) {
          await writeAudit(kernel.db, meta, { action: op.name, input, subject: op.subject?.(input, result, undefined as L) });
        }
        return result;
      });
  } catch (err) {
    const translated = translatePgError(err);
    if (translated instanceof DomainError && translated.code === "FORBIDDEN") {
      await auditDenied(kernel, meta, op, input);
    }
    throw translated;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Best-effort subject for a refused op, so a record's timeline shows attempts on it (AUD-04). */
function deniedSubject(op: OpDef, input: unknown): Subject | undefined {
  const id = (input as { id?: unknown } | null)?.id;
  return typeof id === "string" && UUID.test(id) ? { type: op.name.split(".")[0]!, id } : undefined;
}

async function auditDenied(kernel: Kernel, meta: RequestMeta, op: OpDef, input: unknown): Promise<void> {
  // Denials are security-relevant; they are recorded even though the action rolled back.
  try {
    await writeAudit(kernel.db, meta, {
      action: op.name,
      input,
      subject: deniedSubject(op, input),
      outcome: "denied",
      errorCode: "FORBIDDEN",
    });
  } catch (err) {
    // Never mask the FORBIDDEN, but never swallow an audit failure silently either.
    console.error(
      JSON.stringify({
        level: "error",
        msg: "audit_denied_write_failed",
        action: op.name,
        requestId: meta.requestId,
        err: String(err),
      }),
    );
  }
}

/** Optimistic concurrency: REST sends If-Match / body expectedVersion, MCP sends expectedVersion. */
export function assertVersion(current: number, expected: number): void {
  if (current !== expected) throw new DomainError("STALE_VERSION", { current, expected });
}

export function notFoundIfMissing<T>(row: T | undefined): T {
  if (row === undefined) throw new DomainError("NOT_FOUND");
  return row;
}
