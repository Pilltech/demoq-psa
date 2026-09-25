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
};

function translatePgError(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string };
  if (e && typeof e.code === "string") {
    if (e.constraint && CONSTRAINT_ERRORS[e.constraint]) {
      return new DomainError(CONSTRAINT_ERRORS[e.constraint]!, { constraint: e.constraint });
    }
    if (e.code === "23505") return new DomainError("CONFLICT", { constraint: e.constraint });
    if (e.code === "23503") return new DomainError("VALIDATION", { constraint: e.constraint });
  }
  return err;
}

const SECRET_KEY = /pass(word)?|secret|token|^code$|totp/i;
/** JSON-safe, secret-free copy of the input for the audit row. */
export function redact(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[redacted]" : redact(v)]),
    );
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

export async function execute<I extends z.ZodTypeAny, R, L>(
  kernel: Kernel,
  meta: RequestMeta,
  op: CommandDef<I, R, L> | QueryDef<I, R, L>,
  rawInput: unknown,
): Promise<R> {
  if (!op.exposeTo.includes(meta.channel)) {
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
  if (!rowFilter(meta.actor, op.permission)) {
    await auditDenied(kernel, meta, op, input);
    throw new DomainError("FORBIDDEN", { permission: op.permission });
  }

  const builder = kernel.db.transaction();
  try {
    return await (op.kind === "query" ? builder.setAccessMode("read only") : builder).execute(async (tx) => {
      const events: { event: string; payload: Record<string, unknown> }[] = [];
      const ctx: Ctx = { ...meta, tx, now: kernel.clock(), emit: (event, payload) => events.push({ event, payload }) };
      if (op.kind === "command") {
        const a = meta.actor;
        await sql`SELECT
            set_config('app.actor_id', ${a.type === "user" ? a.id : ""}, true),
            set_config('app.actor_name', ${a.name}, true),
            set_config('app.channel', ${meta.channel}, true),
            set_config('app.request_id', ${meta.requestId}, true)`.execute(tx);
      }
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
            .values(events.map((e) => ({ event: e.event, payload: JSON.stringify(redact(e.payload)), request_id: meta.requestId })))
            .execute();
        }
      }
      return result;
    }).then(async (result) => {
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

async function auditDenied(kernel: Kernel, meta: RequestMeta, op: OpDef, input: unknown): Promise<void> {
  // Denials are security-relevant; they are recorded even though the action rolled back.
  await writeAudit(kernel.db, meta, { action: op.name, input, outcome: "denied", errorCode: "FORBIDDEN" }).catch(
    () => {},
  );
}

/** Optimistic concurrency: REST sends If-Match / body expectedVersion, MCP sends expectedVersion. */
export function assertVersion(current: number, expected: number): void {
  if (current !== expected) throw new DomainError("STALE_VERSION", { current, expected });
}

export function notFoundIfMissing<T>(row: T | undefined): T {
  if (row === undefined) throw new DomainError("NOT_FOUND");
  return row;
}
