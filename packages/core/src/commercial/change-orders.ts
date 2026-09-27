// Change orders: additive changes to a project's scope. Spec: specs/commercial/change-orders.md (COM-CO-*)
import { createHash } from "node:crypto";
import { z } from "zod";
import { ByIdInput, expectedVersion, optionalText, priceQuote, requiredText, uuid } from "@demoq/shared";
import { createApproval, lockSubjectWith, onApprovalDecided, supersedePending } from "../approvals";
import {
  addDays,
  assertVersion,
  businessDate,
  can,
  defineCommand,
  defineQuery,
  DomainError,
  notFoundIfMissing,
  type Ctx,
  type ResourceScope,
} from "../kernel";
import { lockProject, projectScope } from "../projects";
import { recordDiscounts } from "../reporting";
import { insertScopeItems } from "./accept";

const EDITABLE = ["draft", "margin_review", "ready"] as const;
/** D-CO-1 */
export const CO_DEFAULT_ESTIMATE_MINUTES = 60;
export const CO_TASK_DUE_DAYS = 7;

// COM-CO-01: signed integers on the wire, so a reduction is refused with its own error, not a generic one.
const signedMinor = z
  .string()
  .regex(/^-?\d{1,12}$/, "Minor units as a whole-number string (max 12 digits)")
  .transform((s) => BigInt(s));
const CoLineInput = z.object({
  kind: z.enum(["fee", "pass_through"]),
  rateCardItemId: uuid.nullish(),
  descriptionEn: requiredText(500),
  descriptionKm: optionalText(500),
  qtyMilli: z.number().int().min(-10_000_000).max(10_000_000),
  unitPriceMinor: signedMinor,
  unitCostMinor: z
    .string()
    .regex(/^\d{1,12}$/)
    .transform((s) => BigInt(s))
    .nullish(),
  discountBp: z.number().int().min(0).max(10_000).default(0),
  quotedMinutes: z.number().int().min(0).max(1_000_000).nullish(),
});

/** Lock order: project → change order → approval. */
async function lockCo(ctx: Ctx, id: string) {
  const ref = notFoundIfMissing(
    await ctx.tx.selectFrom("change_orders").select("project_id").where("id", "=", id).executeTakeFirst(),
  );
  const p = await lockProject(ctx, ref.project_id);
  const co = notFoundIfMissing(
    await ctx.tx.selectFrom("change_orders").selectAll().where("id", "=", id).forUpdate().executeTakeFirst(),
  );
  return { p, co, scope: await projectScope(ctx, p) };
}
type CoRow = Awaited<ReturnType<typeof lockCo>>["co"];

/** Costs are visible to finance.view_costs holders; account leads see their own clients' (COM-QB-04). */
const costScope = (scope: ResourceScope): ResourceScope => ({ ownerIds: scope.ownerIds });

async function floorsFor(ctx: Ctx, projectId: string) {
  const e = await ctx.tx
    .selectFrom("projects as p")
    .innerJoin("engagement_types as e", "e.id", "p.engagement_type_id")
    .select(["e.fee_margin_floor_bp", "e.passthrough_markup_floor_bp", "e.passthrough_markup_warn_bp", "e.label_en"])
    .where("p.id", "=", projectId)
    .executeTakeFirstOrThrow();
  return {
    feeMarginFloorBp: e.fee_margin_floor_bp,
    passthroughMarkupFloorBp: e.passthrough_markup_floor_bp,
    passthroughMarkupWarnBp: e.passthrough_markup_warn_bp,
    label: e.label_en,
  };
}

const loadLines = (ctx: Ctx, coId: string) =>
  ctx.tx.selectFrom("change_order_lines").selectAll().where("change_order_id", "=", coId).orderBy("position").execute();

async function reprice(ctx: Ctx, co: CoRow) {
  const lines = await loadLines(ctx, co.id);
  const floors = await floorsFor(ctx, co.project_id);
  const t = priceQuote(
    lines.map((l) => ({
      kind: l.kind as "fee" | "pass_through",
      qtyMilli: l.qty_milli,
      unitPriceMinor: l.unit_price_minor,
      unitCostMinor: l.unit_cost_minor,
      discountBp: l.discount_bp,
    })),
    floors,
  );
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        t: co.title,
        c: co.currency,
        p: co.scope_period_id,
        l: lines.map((l) => [
          l.kind,
          l.description_en,
          l.description_km,
          l.qty_milli,
          String(l.unit_price_minor),
          String(l.unit_cost_minor),
          l.discount_bp,
          l.quoted_minutes,
        ]),
      }),
    )
    .digest("hex");
  const updated = await ctx.tx
    .updateTable("change_orders")
    .set({
      fee_price_minor: t.feePriceMinor,
      fee_cost_minor: t.feeCostMinor,
      pt_price_minor: t.ptPriceMinor,
      pt_cost_minor: t.ptCostMinor,
      discount_minor: t.discountMinor,
      total_minor: t.totalMinor,
      fee_margin_bp: t.feeMarginBp,
      pt_markup_bp: t.ptMarkupBp,
      below_floor: t.belowFloor,
      content_sha256: hash,
    })
    .where("id", "=", co.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  return { co: updated, totals: t, floors, lines };
}

export const changeOrderCreate = defineCommand({
  name: "change_order.create",
  summary: "Start a draft change order on a project (a retainer's CO targets one period)",
  permission: "change_order.manage",
  input: z.object({ projectId: uuid, title: requiredText(200), scopePeriodId: uuid.nullish() }),
  exposeTo: ["web", "mcp"],
  async load(ctx, i) {
    const p = await lockProject(ctx, i.projectId);
    return { p, scope: await projectScope(ctx, p) };
  },
  scope: (l) => l.scope,
  async run(ctx, i, { p }) {
    if (!p.scope_id) throw new DomainError("VALIDATION", { reason: "project_has_no_scope" });
    if (!["gated", "active", "on_hold"].includes(p.status))
      throw new DomainError("INVALID_TRANSITION", { reason: "project_closed", status: p.status });
    const scope = await ctx.tx
      .selectFrom("scopes")
      .select(["id", "currency", "billing_model"])
      .where("id", "=", p.scope_id)
      .executeTakeFirstOrThrow();
    // COM-CO-03: a retainer CO targets one (not closed) period; a one-off CO targets none.
    if (scope.billing_model === "retainer") {
      if (!i.scopePeriodId)
        throw new DomainError("VALIDATION", {
          issues: [{ path: "scopePeriodId", message: "Choose the month this change applies to" }],
        });
      const per = await ctx.tx
        .selectFrom("scope_periods")
        .select(["scope_id", "status"])
        .where("id", "=", i.scopePeriodId)
        .executeTakeFirst();
      if (!per || per.scope_id !== scope.id || per.status === "closed")
        throw new DomainError("VALIDATION", {
          issues: [{ path: "scopePeriodId", message: "Not an open period of this project" }],
        });
    } else if (i.scopePeriodId) {
      throw new DomainError("VALIDATION", { issues: [{ path: "scopePeriodId", message: "Only retainers have periods" }] });
    }
    const last = await ctx.tx
      .selectFrom("change_orders")
      .select((eb) => eb.fn.max("number").as("n"))
      .where("project_id", "=", p.id)
      .executeTakeFirst();
    const co = await ctx.tx
      .insertInto("change_orders")
      .values({
        project_id: p.id,
        scope_id: scope.id,
        scope_period_id: i.scopePeriodId ?? null,
        number: (last?.n ?? 0) + 1,
        title: i.title,
        currency: scope.currency,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const { co: priced } = await reprice(ctx, co);
    return { id: priced.id, number: priced.number, version: priced.version };
  },
  subject: (_i, r) => ({ type: "change_order", id: r.id }),
});

export const changeOrderSave = defineCommand({
  name: "change_order.save",
  summary: "Save a change order's title and lines (additive only); the server recomputes margin",
  permission: "change_order.manage",
  input: z.object({
    id: uuid,
    expectedVersion,
    title: requiredText(200).optional(),
    lines: z.array(CoLineInput).max(200).optional(),
  }),
  exposeTo: ["web", "mcp"],
  load: (ctx, i) => lockCo(ctx, i.id),
  scope: (l) => l.scope,
  async run(ctx, i, { p, co, scope }) {
    assertVersion(co.version, i.expectedVersion);
    if (!(EDITABLE as readonly string[]).includes(co.status)) throw new DomainError("QUOTE_LOCKED", { status: co.status });
    if (i.lines) {
      i.lines.forEach((l, n) => {
        if (l.qtyMilli <= 0 || l.unitPriceMinor < 0n) throw new DomainError("CHANGE_ORDER_NOT_ADDITIVE", { line: n });
      });
      await writeLines(ctx, p, co, scope, i.lines);
    }
    const base = await ctx.tx
      .updateTable("change_orders")
      .set((eb) => ({ version: eb("version", "+", 1), status: "draft", ...(i.title !== undefined && { title: i.title }) }))
      .where("id", "=", co.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const { co: priced, totals } = await reprice(ctx, base);
    if (priced.content_sha256 !== co.content_sha256 || co.status !== "draft") await supersedePending(ctx, "change_order", co.id);
    return { id: priced.id, version: priced.version, status: priced.status, totalMinor: totals.totalMinor.toString() };
  },
  subject: (i) => ({ type: "change_order", id: i.id }),
});

/**
 * Lines come from the quote's rate card or are custom. D-CO-2: someone who cannot see costs (e.g. a PM) may add only
 * rate-card lines, at the card's cost — a custom line needs a real cost, or the margin floor would see none.
 */
async function writeLines(
  ctx: Ctx,
  p: { quote_id: string | null },
  co: CoRow,
  scope: ResourceScope,
  lines: z.infer<typeof CoLineInput>[],
) {
  const seesCosts = can(ctx.actor, "finance.view_costs", costScope(scope));
  const card = p.quote_id
    ? (await ctx.tx.selectFrom("quotes").select("rate_card_id").where("id", "=", p.quote_id).executeTakeFirst())?.rate_card_id
    : null;
  const itemIds = lines.map((l) => l.rateCardItemId).filter((x): x is string => !!x);
  const items = new Map(
    itemIds.length
      ? (await ctx.tx.selectFrom("rate_card_items").selectAll().where("id", "in", itemIds).execute()).map((x) => [x.id, x])
      : [],
  );
  const rows = lines.map((l, position) => {
    const bad = (field: string, message: string) =>
      new DomainError("VALIDATION", { issues: [{ path: `lines.${position}.${field}`, message }] });
    const item = l.rateCardItemId ? items.get(l.rateCardItemId) : undefined;
    if (l.rateCardItemId && !item) throw bad("rateCardItemId", "Unknown rate-card item");
    if (item) {
      if (item.rate_card_id !== card) throw bad("rateCardItemId", "Item is not on this project's rate card");
      if (!item.active) throw bad("rateCardItemId", "Item is no longer active");
      if (item.kind !== l.kind) throw bad("kind", "Line kind differs from the rate-card item");
    }
    if (!seesCosts && (!item || (l.unitCostMinor !== null && l.unitCostMinor !== undefined)))
      throw new DomainError("FORBIDDEN", { reason: "costs_hidden" });
    if (item && l.unitCostMinor !== null && l.unitCostMinor !== undefined && l.unitCostMinor < item.unit_cost_minor)
      throw bad("unitCostMinor", "Cost cannot be below the rate-card cost");
    const unitCost = l.unitCostMinor ?? item?.unit_cost_minor ?? 0n;
    const priced = priceQuote(
      [
        {
          kind: l.kind,
          qtyMilli: l.qtyMilli,
          unitPriceMinor: l.unitPriceMinor,
          unitCostMinor: unitCost,
          discountBp: l.discountBp,
        },
      ],
      { feeMarginFloorBp: 0, passthroughMarkupFloorBp: null, passthroughMarkupWarnBp: 0 },
    ).lines[0]!;
    return {
      change_order_id: co.id,
      position,
      kind: l.kind,
      description_en: l.descriptionEn,
      description_km: l.descriptionKm ?? null,
      qty_milli: l.qtyMilli,
      unit_price_minor: l.unitPriceMinor,
      unit_cost_minor: unitCost,
      list_price_minor: item?.unit_price_minor ?? null,
      discount_bp: l.discountBp,
      line_price_minor: priced.priceMinor,
      line_cost_minor: priced.costMinor,
      quoted_minutes: l.quotedMinutes ?? null,
      service_code: item?.service_code ?? null,
    };
  });
  await ctx.tx.deleteFrom("change_order_lines").where("change_order_id", "=", co.id).execute();
  if (rows.length) await ctx.tx.insertInto("change_order_lines").values(rows).execute();
}

export const changeOrderSubmit = defineCommand({
  name: "change_order.submit",
  summary: "Submit a draft change order: at or above floor → ready; below → Finance/Ops approval",
  permission: "change_order.manage",
  input: z.object({ id: uuid, expectedVersion }),
  exposeTo: ["web", "mcp"],
  load: (ctx, i) => lockCo(ctx, i.id),
  scope: (l) => l.scope,
  async run(ctx, i, { p, co: co0 }) {
    assertVersion(co0.version, i.expectedVersion);
    if (co0.status !== "draft") throw new DomainError("INVALID_TRANSITION", { from: co0.status, event: "submit" });
    const { co, totals, floors, lines } = await reprice(ctx, co0);
    if (!lines.length) throw new DomainError("QUOTE_EMPTY");
    const next = totals.belowFloor ? "margin_review" : "ready";
    const updated = await ctx.tx
      .updateTable("change_orders")
      .set((eb) => ({
        status: next,
        submitted_by: ctx.actor.type === "user" ? ctx.actor.id : null,
        submitted_at: ctx.now,
        version: eb("version", "+", 1),
      }))
      .where("id", "=", co.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    let approvalId: string | null = null;
    if (totals.belowFloor) {
      // COM-CO-02 (D23): the floor applies to the CO's own lines.
      const feeGap = totals.belowFeeFloor
        ? totals.feeMarginBp === null
          ? 10_000
          : floors.feeMarginFloorBp - totals.feeMarginBp
        : 0;
      const ptGap =
        totals.belowMarkupFloor && floors.passthroughMarkupFloorBp !== null && totals.ptMarkupBp !== null
          ? floors.passthroughMarkupFloorBp - totals.ptMarkupBp
          : 0;
      const a = await createApproval(ctx, {
        kind: "margin_floor",
        subject: { type: "change_order", id: co.id, version: updated.version, hash: updated.content_sha256 },
        snapshot: {
          title: `${p.name} — CO #${co.number}: ${co.title}`,
          scope: {},
          facts: {
            currency: co.currency,
            totalMinor: totals.totalMinor.toString(),
            engagementType: floors.label,
            changeOrder: co.number,
          },
          costs: {
            feeMarginBp: totals.feeMarginBp,
            feeFloorBp: floors.feeMarginFloorBp,
            ptMarkupBp: totals.ptMarkupBp,
            ptFloorBp: floors.passthroughMarkupFloorBp,
          },
          floorGapBp: Math.max(feeGap, ptGap),
        },
      });
      approvalId = a.id;
    }
    return { id: co.id, status: next, version: updated.version, approvalId };
  },
  subject: (i) => ({ type: "change_order", id: i.id }),
});

lockSubjectWith("margin_floor", "change_order", async (ctx, id) => (await lockCo(ctx, id)).co);

onApprovalDecided("margin_floor", "change_order", async (ctx, a, decision) => {
  const co = notFoundIfMissing(
    await ctx.tx.selectFrom("change_orders").selectAll().where("id", "=", a.subject_id).executeTakeFirst(),
  );
  if (co.status !== "margin_review" || co.content_sha256 !== a.subject_hash) return; // stale
  await ctx.tx
    .updateTable("change_orders")
    .set((eb) => ({ status: decision === "approve" ? "ready" : "draft", version: eb("version", "+", 1) }))
    .where("id", "=", co.id)
    .execute();
});

const simpleTransition = (name: string, summary: string, from: readonly string[], to: "sent" | "rejected" | "void") =>
  defineCommand({
    name,
    summary,
    permission: "change_order.manage",
    input: z.object({ id: uuid, expectedVersion }),
    exposeTo: ["web"],
    load: (ctx, i) => lockCo(ctx, i.id),
    scope: (l) => l.scope,
    async run(ctx, i, { co: co0 }) {
      assertVersion(co0.version, i.expectedVersion);
      if (!from.includes(co0.status)) throw new DomainError("INVALID_TRANSITION", { from: co0.status, event: to });
      let co = co0;
      if (to === "sent") {
        const r = await reprice(ctx, co0); // the hash must still match what was approved
        co = r.co;
        if (!r.lines.length) throw new DomainError("QUOTE_EMPTY");
        if (co.below_floor) {
          const ok = await ctx.tx
            .selectFrom("approvals")
            .select("id")
            .where("kind", "=", "margin_floor")
            .where("subject_type", "=", "change_order")
            .where("subject_id", "=", co.id)
            .where("subject_hash", "=", co.content_sha256)
            .where("status", "=", "approved")
            .whereRef("decided_by", "<>", "requested_by")
            .executeTakeFirst();
          if (!ok) throw new DomainError("MARGIN_BELOW_FLOOR");
        }
      }
      if (to === "void") await supersedePending(ctx, "change_order", co.id);
      const who = ctx.actor.type === "user" ? ctx.actor.id : null;
      const r = await ctx.tx
        .updateTable("change_orders")
        .set((eb) => ({ status: to, version: eb("version", "+", 1), ...(to === "sent" && { sent_by: who, sent_at: ctx.now }) }))
        .where("id", "=", co.id)
        .returning(["id", "status", "version"])
        .executeTakeFirstOrThrow();
      ctx.emit(`change_order.${to}`, { changeOrderId: co.id, projectId: co.project_id });
      return r;
    },
    subject: (i) => ({ type: "change_order", id: i.id }),
  });

export const changeOrderSend = simpleTransition(
  "change_order.send",
  "Send a ready change order to the client (locks it)",
  ["ready"],
  "sent",
);
export const changeOrderReject = simpleTransition(
  "change_order.reject",
  "Record that the client rejected a sent change order",
  ["sent"],
  "rejected",
);
export const changeOrderVoid = simpleTransition("change_order.void", "Void a change order that was never sent", EDITABLE, "void");

/** COM-CO-04: accepted lines are appended to the scope; one task per fee line (D-CO-1). */
export const changeOrderAccept = defineCommand({
  name: "change_order.accept",
  summary: "Record the client's acceptance: lines join the scope and fee lines become tasks",
  permission: "change_order.manage",
  input: z.object({ id: uuid, expectedVersion }),
  exposeTo: ["web", "mcp"],
  load: (ctx, i) => lockCo(ctx, i.id),
  scope: (l) => l.scope,
  async run(ctx, i, { p, co }) {
    assertVersion(co.version, i.expectedVersion);
    if (co.status !== "sent") throw new DomainError("INVALID_TRANSITION", { from: co.status, event: "accept" });
    if (!["gated", "active", "on_hold"].includes(p.status))
      throw new DomainError("INVALID_TRANSITION", { reason: "project_closed", status: p.status });
    const today = businessDate(ctx.now);
    const lines = await loadLines(ctx, co.id);
    const r = await ctx.tx
      .updateTable("change_orders")
      .set((eb) => ({
        status: "accepted",
        accepted_by: ctx.actor.type === "user" ? ctx.actor.id : null,
        accepted_at: ctx.now,
        version: eb("version", "+", 1),
      }))
      .where("id", "=", co.id)
      .returning(["id", "status", "version"])
      .executeTakeFirstOrThrow();
    const items = await insertScopeItems(
      ctx,
      co.scope_id,
      co.scope_period_id,
      { type: "change_order", id: co.id },
      lines.map((l) => ({ ...l, per_period: false })),
    );
    let tasks = 0;
    for (const [n, l] of lines.entries()) {
      if (l.kind !== "fee") continue;
      await ctx.tx
        .insertInto("tasks")
        .values({
          project_id: p.id,
          title: l.description_en,
          owner_id: p.pm_id,
          estimate_minutes: l.quoted_minutes && l.quoted_minutes > 0 ? l.quoted_minutes : CO_DEFAULT_ESTIMATE_MINUTES,
          estimate_source: "change_order",
          due_date: addDays(today, CO_TASK_DUE_DAYS),
          scope_item_id: items[n]!.id,
        })
        .execute();
      tasks++;
    }
    const scope = await ctx.tx
      .selectFrom("scopes")
      .select(["client_id", "fx_rate_micros"])
      .where("id", "=", co.scope_id)
      .executeTakeFirstOrThrow();
    await recordDiscounts(ctx, {
      clientId: scope.client_id,
      projectId: p.id,
      currency: co.currency,
      fxRateMicros: scope.fx_rate_micros,
      occurredOn: today,
      sourceType: "change_order",
      sourceId: co.id,
      lines: lines.map((l) => ({
        kind: l.kind,
        qtyMilli: l.qty_milli,
        listPriceMinor: l.list_price_minor,
        linePriceMinor: l.line_price_minor,
      })),
    });
    ctx.emit("change_order.accepted", { changeOrderId: co.id, projectId: p.id });
    return { ...r, scopeItems: items.length, tasksCreated: tasks };
  },
  subject: (i) => ({ type: "change_order", id: i.id }),
});

function coDto(co: CoRow, showCosts: boolean, lines?: Awaited<ReturnType<typeof loadLines>>) {
  const s = (v: bigint | null) => (v === null ? null : v.toString());
  return {
    id: co.id,
    projectId: co.project_id,
    number: co.number,
    title: co.title,
    currency: co.currency,
    scopePeriodId: co.scope_period_id,
    // As for quotes (COM-QB-04): margin_review vs ready would reveal the below-floor flag.
    status: showCosts || (co.status !== "margin_review" && co.status !== "ready") ? co.status : "submitted",
    feePriceMinor: s(co.fee_price_minor),
    ptPriceMinor: s(co.pt_price_minor),
    discountMinor: s(co.discount_minor),
    totalMinor: s(co.total_minor),
    sentAt: co.sent_at,
    acceptedAt: co.accepted_at,
    version: co.version,
    costs: showCosts
      ? {
          feeCostMinor: s(co.fee_cost_minor),
          ptCostMinor: s(co.pt_cost_minor),
          feeMarginBp: co.fee_margin_bp,
          ptMarkupBp: co.pt_markup_bp,
          belowFloor: co.below_floor,
        }
      : null,
    lines: lines?.map((l) => ({
      kind: l.kind,
      descriptionEn: l.description_en,
      descriptionKm: l.description_km,
      serviceCode: l.service_code,
      qtyMilli: l.qty_milli,
      unitPriceMinor: s(l.unit_price_minor),
      listPriceMinor: s(l.list_price_minor),
      discountBp: l.discount_bp,
      linePriceMinor: s(l.line_price_minor),
      quotedMinutes: l.quoted_minutes,
      unitCostMinor: showCosts ? s(l.unit_cost_minor) : null,
      lineCostMinor: showCosts ? s(l.line_cost_minor) : null,
    })),
  };
}

export const changeOrderGet = defineQuery({
  name: "change_order.get",
  summary: "One change order with lines (costs only for finance.view_costs holders)",
  permission: "project.view",
  input: ByIdInput,
  exposeTo: ["web", "mcp"],
  async run(ctx, i) {
    const co = notFoundIfMissing(await ctx.tx.selectFrom("change_orders").selectAll().where("id", "=", i.id).executeTakeFirst());
    const p = await ctx.tx
      .selectFrom("projects")
      .select(["id", "pm_id", "client_id"])
      .where("id", "=", co.project_id)
      .executeTakeFirstOrThrow();
    const scope = await projectScope(ctx, p);
    return {
      ...coDto(co, can(ctx.actor, "finance.view_costs", costScope(scope)), await loadLines(ctx, co.id)),
      canEdit: (EDITABLE as readonly string[]).includes(co.status) && can(ctx.actor, "change_order.manage", scope),
      canManage: can(ctx.actor, "change_order.manage", scope),
    };
  },
  subject: (i) => ({ type: "change_order", id: i.id }),
});

export const changeOrderList = defineQuery({
  name: "change_order.list",
  summary: "A project's change orders",
  permission: "project.view",
  input: z.object({ projectId: uuid }),
  exposeTo: ["web", "mcp"],
  async run(ctx, i) {
    const p = notFoundIfMissing(
      await ctx.tx.selectFrom("projects").select(["id", "pm_id", "client_id"]).where("id", "=", i.projectId).executeTakeFirst(),
    );
    const show = can(ctx.actor, "finance.view_costs", costScope(await projectScope(ctx, p)));
    const rows = await ctx.tx.selectFrom("change_orders").selectAll().where("project_id", "=", p.id).orderBy("number").execute();
    return rows.map((co) => coDto(co, show));
  },
  subject: (i) => ({ type: "project", id: i.projectId }),
});
