// Pipeline and the close-reason rule — the GOLDEN SLICE every scaffold skill mirrors.
// Spec: specs/crm/close-reason.md (CRM-CR-*), invariant INV-01.
import { z } from "zod";
import {
  ByIdInput,
  DEAL_STAGES,
  DealCreateInput,
  DealListInput,
  DealMoveInput,
  DealReopenInput,
  type DealStage,
} from "@demoq/shared";
import {
  assertVersion,
  can,
  defineCommand,
  defineQuery,
  DomainError,
  notFoundIfMissing,
  rowFilter,
  type Ctx,
} from "../kernel";
import { dealMachine, isOpenStage } from "./deal-machine";

/** Reopen needs a real explanation, not "ok" (CRM-CR-04). */
export const REOPEN_REASON_MIN = 10;

async function lockDeal(ctx: Ctx, id: string) {
  return notFoundIfMissing(
    await ctx.tx
      .selectFrom("deals as d")
      .innerJoin("clients as c", "c.id", "d.client_id")
      .select(["d.id", "d.stage", "d.owner_id", "d.version", "d.client_id", "c.team_id"])
      .where("d.id", "=", id)
      .forUpdate("d")
      .executeTakeFirst(),
  );
}

type LockedDeal = Awaited<ReturnType<typeof lockDeal>>;
const dealScope = (d: LockedDeal) => ({ ownerIds: [d.owner_id], teamIds: [d.team_id] });

async function recordStage(ctx: Ctx, dealId: string, from: DealStage | null, to: DealStage, reason: string | null, note: string | null) {
  await ctx.tx
    .insertInto("deal_stage_history")
    .values({
      deal_id: dealId,
      from_stage: from,
      to_stage: to,
      close_reason_code: reason,
      note,
      changed_by: ctx.actor.type === "user" ? ctx.actor.id : null,
      changed_at: ctx.now,
    })
    .execute();
}

/** CRM-CR-02: the reason must exist, be active, match the outcome, and not be import-only. */
async function assertCloseReason(ctx: Ctx, code: string, kind: "won" | "lost") {
  const r = await ctx.tx.selectFrom("close_reasons").selectAll().where("code", "=", code).executeTakeFirst();
  if (!r || !r.active || r.kind !== kind || (r.legacy_only && ctx.channel !== "job")) {
    throw new DomainError("CLOSE_REASON_INVALID", { code, kind });
  }
}

export const dealCreate = defineCommand({
  name: "deal.create",
  summary: "Open a deal for a client (you own it unless another owner is named)",
  permission: "deal.manage",
  input: DealCreateInput,
  exposeTo: ["web", "mcp"],
  scope: (_l, input, ctx) => ({ ownerIds: [input.ownerId ?? (ctx.actor.type === "user" ? ctx.actor.id : undefined)] }),
  async run(ctx, input) {
    const ownerId = input.ownerId ?? (ctx.actor.type === "user" ? ctx.actor.id : null);
    if (!ownerId) throw new DomainError("VALIDATION", { issues: [{ path: "ownerId", message: "Required" }] });
    const client = await ctx.tx.selectFrom("clients").select(["id", "archived_at"]).where("id", "=", input.clientId).executeTakeFirst();
    if (!client || client.archived_at) {
      throw new DomainError("VALIDATION", { issues: [{ path: "clientId", message: "Unknown or archived client" }] });
    }
    const deal = await ctx.tx
      .insertInto("deals")
      .values({
        client_id: input.clientId,
        title: input.title,
        owner_id: ownerId,
        expected_value_minor: input.expectedValueMinor ?? null,
        currency: input.currency,
        expected_close_on: input.expectedCloseOn ?? null,
      })
      .returning(["id", "title", "stage", "version"])
      .executeTakeFirstOrThrow();
    await recordStage(ctx, deal.id, null, "lead", null, null);
    ctx.emit("deal.created", { dealId: deal.id });
    return deal;
  },
  subject: (_i, r) => ({ type: "deal", id: r.id }),
});

/**
 * Move a deal to another stage. This is what the Kanban drag calls.
 * CRM-CR-01 Lost needs a lost reason · CRM-CR-03 Won is refused (quote.accept, S3)
 * CRM-CR-04 closed deals do not move (reopen instead) · CRM-CR-09 open stages move freely.
 */
export const dealMove = defineCommand({
  name: "deal.move",
  summary: "Move a deal to another pipeline stage; Lost requires a close reason",
  permission: "deal.manage",
  input: DealMoveInput,
  exposeTo: ["web", "mcp"],
  load: (ctx, input) => lockDeal(ctx, input.id),
  scope: dealScope,
  async run(ctx, input, deal) {
    assertVersion(deal.version, input.expectedVersion);
    const from = deal.stage as DealStage;
    const to = input.toStage;
    if (from === to) throw new DomainError("INVALID_TRANSITION", { from, to });

    if (to === "won") {
      dealMachine.assert(from, "close_won");
      throw new DomainError("WIN_REQUIRES_QUOTE");
    }
    if (to === "lost") {
      dealMachine.assert(from, "close_lost");
      if (!input.closeReasonCode) throw new DomainError("CLOSE_REASON_REQUIRED", { stage: "lost" });
      await assertCloseReason(ctx, input.closeReasonCode, "lost");
    } else {
      dealMachine.assert(from, "move");
      if (!isOpenStage(to)) throw new DomainError("INVALID_TRANSITION", { from, to });
    }

    const closing = to === "lost";
    const row = await ctx.tx
      .updateTable("deals")
      .set((eb) => ({
        stage: to,
        version: eb("version", "+", 1),
        close_reason_code: closing ? input.closeReasonCode! : null,
        close_reason_kind: closing ? "lost" : null,
        close_note: closing ? (input.note ?? null) : null,
        closed_at: closing ? ctx.now : null,
      }))
      .where("id", "=", deal.id)
      .returning(["id", "stage", "version", "close_reason_code"])
      .executeTakeFirstOrThrow();
    await recordStage(ctx, deal.id, from, to, closing ? input.closeReasonCode! : null, input.note ?? null);
    ctx.emit(closing ? "deal.lost" : "deal.stage_changed", { dealId: deal.id, from, to });
    return row;
  },
  subject: (i) => ({ type: "deal", id: i.id }),
});

export const dealReopen = defineCommand({
  name: "deal.reopen",
  summary: "Reopen a Lost deal (back to Qualified) with a reason",
  permission: "deal.reopen",
  input: DealReopenInput,
  exposeTo: ["web", "mcp"],
  load: (ctx, input) => lockDeal(ctx, input.id),
  scope: dealScope,
  async run(ctx, input, deal) {
    assertVersion(deal.version, input.expectedVersion);
    const to = dealMachine.assert(deal.stage as DealStage, "reopen");
    if (input.reason.length < REOPEN_REASON_MIN) {
      throw new DomainError("REOPEN_REASON_REQUIRED", { min: REOPEN_REASON_MIN });
    }
    const row = await ctx.tx
      .updateTable("deals")
      .set((eb) => ({
        stage: to,
        version: eb("version", "+", 1),
        close_reason_code: null,
        close_reason_kind: null,
        close_note: null,
        closed_at: null,
      }))
      .where("id", "=", deal.id)
      .returning(["id", "stage", "version"])
      .executeTakeFirstOrThrow();
    await recordStage(ctx, deal.id, deal.stage as DealStage, to, null, input.reason);
    ctx.emit("deal.reopened", { dealId: deal.id });
    return row;
  },
  subject: (i) => ({ type: "deal", id: i.id }),
});

const dealColumns = [
  "d.id",
  "d.title",
  "d.stage",
  "d.client_id",
  "c.name as client_name",
  "c.name_km as client_name_km",
  "d.owner_id",
  "u.display_name as owner_name",
  "d.expected_value_minor",
  "d.currency",
  "d.expected_close_on",
  "d.close_reason_code",
  "d.close_note",
  "d.closed_at",
  "d.version",
  "d.updated_at",
] as const;

const toDealDto = <T extends { expected_value_minor: bigint | null }>(d: T) => ({
  ...d,
  expected_value_minor: d.expected_value_minor === null ? null : d.expected_value_minor.toString(),
});

export const dealList = defineQuery({
  name: "deal.list",
  summary: "The pipeline: deals with client, owner and stage",
  permission: "deal.view",
  input: DealListInput,
  exposeTo: ["web", "mcp"],
  async run(ctx, input) {
    const filter = rowFilter(ctx.actor, "deal.view")!;
    let q = ctx.tx
      .selectFrom("deals as d")
      .innerJoin("clients as c", "c.id", "d.client_id")
      .innerJoin("users as u", "u.id", "d.owner_id")
      .select(dealColumns);
    if (filter.kind === "scoped") q = q.where("d.owner_id", "=", filter.userId);
    if (input.clientId) q = q.where("d.client_id", "=", input.clientId);
    if (input.ownerId) q = q.where("d.owner_id", "=", input.ownerId);
    if (!input.includeClosed) q = q.where("d.stage", "not in", ["won", "lost"]);
    const rows = await q.orderBy("d.updated_at", "desc").limit(500).execute();
    return rows.map((d) => ({
      ...toDealDto(d),
      canManage: can(ctx.actor, "deal.manage", { ownerIds: [d.owner_id] }),
    }));
  },
});

export const dealGet = defineQuery({
  name: "deal.get",
  summary: "One deal with its stage history",
  permission: "deal.view",
  input: ByIdInput,
  exposeTo: ["web", "mcp"],
  async load(ctx, input) {
    return notFoundIfMissing(
      await ctx.tx
        .selectFrom("deals as d")
        .innerJoin("clients as c", "c.id", "d.client_id")
        .innerJoin("users as u", "u.id", "d.owner_id")
        .select(dealColumns)
        .where("d.id", "=", input.id)
        .executeTakeFirst(),
    );
  },
  scope: (d) => ({ ownerIds: [d.owner_id] }),
  async run(ctx, _input, deal) {
    const history = await ctx.tx
      .selectFrom("deal_stage_history as h")
      .leftJoin("users as u", "u.id", "h.changed_by")
      .select(["h.from_stage", "h.to_stage", "h.close_reason_code", "h.note", "h.changed_at", "u.display_name as changed_by_name"])
      .where("h.deal_id", "=", deal.id)
      .orderBy("h.seq")
      .execute();
    return {
      ...toDealDto(deal),
      history,
      canManage: can(ctx.actor, "deal.manage", { ownerIds: [deal.owner_id] }),
      canReopen: deal.stage === "lost" && can(ctx.actor, "deal.reopen", { ownerIds: [deal.owner_id] }),
    };
  },
  subject: (i) => ({ type: "deal", id: i.id }),
});

export const pipelineStages = defineQuery({
  name: "deal.stages",
  summary: "Pipeline columns, in order, with which ones are closes",
  permission: "deal.view",
  input: z.object({}).default({}),
  exposeTo: ["web", "mcp"],
  async run() {
    return DEAL_STAGES.map((s) => ({ stage: s, closed: s === "won" || s === "lost", needsReason: s === "lost" }));
  },
});

export const closeReasonList = defineQuery({
  name: "close_reason.list",
  summary: "Active close reasons (won and lost) in English and Khmer",
  permission: "close_reason.view",
  input: z.object({ kind: z.enum(["won", "lost"]).optional() }).default({}),
  exposeTo: ["web", "mcp"],
  async run(ctx, input) {
    let q = ctx.tx
      .selectFrom("close_reasons")
      .select(["code", "kind", "label_en", "label_km"])
      .where("active", "=", true)
      .where("legacy_only", "=", false);
    if (input.kind) q = q.where("kind", "=", input.kind);
    return q.orderBy("kind").orderBy("sort_order").execute();
  },
});

