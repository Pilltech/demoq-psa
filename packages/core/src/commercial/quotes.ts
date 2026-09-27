// Quotes: builder, margin floor, send and lock. Spec: specs/commercial/quote-builder.md (COM-QB-*)
import { createHash } from "node:crypto";
import {
  priceQuote,
  QuoteCreateInput,
  QuoteListInput,
  QuoteRejectInput,
  QuoteReviseInput,
  QuoteSaveInput,
  QuoteSendInput,
  QuoteSubmitInput,
  ByIdInput,
  type QuoteLineIn,
} from "@demoq/shared";
import { createApproval, lockSubjectWith, onApprovalDecided, supersedePending } from "../approvals";
import {
  assertVersion,
  businessDate,
  can,
  defineCommand,
  defineQuery,
  DomainError,
  notFoundIfMissing,
  type Ctx,
  type Kernel,
} from "../kernel";
import { currentFxRate } from "./config";

const EDITABLE = ["draft", "margin_review", "ready"] as const;
type QuoteStatus = "draft" | "margin_review" | "ready" | "sent" | "accepted" | "rejected" | "expired" | "superseded";

async function lockQuote(ctx: Ctx, id: string) {
  return notFoundIfMissing(await ctx.tx.selectFrom("quotes").selectAll().where("id", "=", id).forUpdate().executeTakeFirst());
}
type QuoteRow = Awaited<ReturnType<typeof lockQuote>>;

const quoteScope = (q: { owner_id: string }) => ({ ownerIds: [q.owner_id] });

async function floorsFor(ctx: Ctx, engagementTypeId: string) {
  const e = notFoundIfMissing(
    await ctx.tx.selectFrom("engagement_types").selectAll().where("id", "=", engagementTypeId).executeTakeFirst(),
  );
  return {
    feeMarginFloorBp: e.fee_margin_floor_bp,
    passthroughMarkupFloorBp: e.passthrough_markup_floor_bp,
    passthroughMarkupWarnBp: e.passthrough_markup_warn_bp,
    label: e.label_en,
  };
}

/**
 * One lock order for every quote change: deal → quote → approval (the approval engine follows the same order),
 * so concurrent save/submit/send/decide never deadlock. `requireOpen` refuses quotes on won/lost deals (COM-QB-01).
 */
export async function lockQuoteForChange(
  ctx: Ctx,
  quoteId: string,
  opts: { dealLock: "update" | "share"; requireOpen: boolean },
) {
  const ref = notFoundIfMissing(await ctx.tx.selectFrom("quotes").select("deal_id").where("id", "=", quoteId).executeTakeFirst());
  let dq = ctx.tx.selectFrom("deals").select(["id", "stage"]).where("id", "=", ref.deal_id);
  dq = opts.dealLock === "update" ? dq.forUpdate() : dq.forShare();
  const deal = notFoundIfMissing(await dq.executeTakeFirst());
  if (opts.requireOpen && (deal.stage === "won" || deal.stage === "lost")) {
    throw new DomainError("INVALID_TRANSITION", { reason: "deal_closed" });
  }
  return lockQuote(ctx, quoteId);
}

async function assertEngagementActive(ctx: Ctx, id: string) {
  const e = await ctx.tx.selectFrom("engagement_types").select("active").where("id", "=", id).executeTakeFirst();
  if (!e?.active)
    throw new DomainError("VALIDATION", {
      issues: [{ path: "engagementTypeId", message: "Unknown or inactive engagement type" }],
    });
}

async function loadLines(ctx: Ctx, quoteId: string) {
  return ctx.tx.selectFrom("quote_lines").selectAll().where("quote_id", "=", quoteId).orderBy("position").execute();
}

/** Canonical content → SHA-256. Any change a client would see changes the hash (COM-QB-07). */
function contentHash(
  q: Pick<QuoteRow, "currency" | "title" | "terms" | "billing_model" | "period_months" | "engagement_type_id" | "valid_until">,
  lines: Awaited<ReturnType<typeof loadLines>>,
) {
  const canon = JSON.stringify({
    c: q.currency,
    t: q.title,
    terms: q.terms,
    b: q.billing_model,
    p: q.period_months,
    e: q.engagement_type_id,
    v: q.valid_until,
    l: lines.map((l) => [
      l.kind,
      l.description_en,
      l.description_km,
      l.qty_milli,
      String(l.unit_price_minor),
      String(l.unit_cost_minor),
      l.discount_bp,
      l.per_period,
      l.quoted_minutes,
    ]),
  });
  return createHash("sha256").update(canon).digest("hex");
}

/** Recompute everything from the stored lines with the shared function (COM-QB-02: server figures win). */
async function reprice(ctx: Ctx, q: QuoteRow) {
  const lines = await loadLines(ctx, q.id);
  const floors = await floorsFor(ctx, q.engagement_type_id);
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
  const hash = contentHash(q, lines);
  const updated = await ctx.tx
    .updateTable("quotes")
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
    .where("id", "=", q.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  return { quote: updated, totals: t, floors, lines };
}

async function writeLines(ctx: Ctx, q: QuoteRow, lines: QuoteLineIn[]) {
  await ctx.tx.deleteFrom("quote_lines").where("quote_id", "=", q.id).execute();
  if (!lines.length) return;
  const itemIds = lines.map((l) => l.rateCardItemId).filter((x): x is string => !!x);
  const items = itemIds.length
    ? new Map((await ctx.tx.selectFrom("rate_card_items").selectAll().where("id", "in", itemIds).execute()).map((i) => [i.id, i]))
    : new Map();
  const rows = lines.map((l, position) => {
    const item = l.rateCardItemId ? items.get(l.rateCardItemId) : undefined;
    const bad = (field: string, message: string) =>
      new DomainError("VALIDATION", { issues: [{ path: `lines.${position}.${field}`, message }] });
    if (l.rateCardItemId && !item) throw bad("rateCardItemId", "Unknown rate-card item");
    if (item) {
      // COM-QB-13: the item must come from this quote's own card (same currency), be active and of the same kind.
      if (item.rate_card_id !== q.rate_card_id) throw bad("rateCardItemId", "Item is not on this quote's rate card");
      if (!item.active) throw bad("rateCardItemId", "Item is no longer active");
      if (item.kind !== l.kind) throw bad("kind", "Line kind differs from the rate-card item");
      // D-QB-2: costs may be raised above the card, never lowered below it (the floor must see real cost).
      if (l.unitCostMinor !== null && l.unitCostMinor !== undefined && l.unitCostMinor < item.unit_cost_minor)
        throw bad("unitCostMinor", "Cost cannot be below the rate-card cost");
    }
    const unitCost = l.unitCostMinor ?? item?.unit_cost_minor ?? 0n; // COM-QB-13
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
      {
        feeMarginFloorBp: 0,
        passthroughMarkupFloorBp: null,
        passthroughMarkupWarnBp: 0,
      },
    ).lines[0]!;
    return {
      quote_id: q.id,
      position,
      kind: l.kind,
      rate_card_item_id: item?.id ?? null,
      service_code: item?.service_code ?? null,
      description_en: l.descriptionEn,
      description_km: l.descriptionKm ?? null,
      qty_milli: l.qtyMilli,
      unit_price_minor: l.unitPriceMinor,
      unit_cost_minor: unitCost,
      list_price_minor: item?.unit_price_minor ?? null,
      discount_bp: l.discountBp,
      line_price_minor: priced.priceMinor,
      line_cost_minor: priced.costMinor,
      per_period: l.perPeriod,
      quoted_minutes: l.quotedMinutes ?? null,
    };
  });
  await ctx.tx.insertInto("quote_lines").values(rows).execute();
}

export const quoteCreate = defineCommand({
  name: "quote.create",
  summary: "Start a draft quote for an open deal",
  permission: "quote.edit",
  input: QuoteCreateInput,
  exposeTo: ["web", "mcp"],
  async load(ctx, i) {
    return notFoundIfMissing(
      await ctx.tx
        .selectFrom("deals")
        .select(["id", "client_id", "owner_id", "stage"])
        .where("id", "=", i.dealId)
        .forShare()
        .executeTakeFirst(),
    );
  },
  scope: (d) => ({ ownerIds: [d.owner_id] }),
  async run(ctx, i, deal) {
    if (deal.stage === "won" || deal.stage === "lost") throw new DomainError("INVALID_TRANSITION", { reason: "deal_closed" });
    if ((i.billingModel === "retainer") !== !!i.periodMonths) {
      throw new DomainError("VALIDATION", {
        issues: [{ path: "periodMonths", message: "Retainers need months; one-off quotes do not" }],
      });
    }
    await assertEngagementActive(ctx, i.engagementTypeId);
    if (i.rateCardId) {
      const card = await ctx.tx
        .selectFrom("rate_cards")
        .select(["currency", "active"])
        .where("id", "=", i.rateCardId)
        .executeTakeFirst();
      if (!card?.active || card.currency !== i.currency) {
        throw new DomainError("VALIDATION", {
          issues: [{ path: "rateCardId", message: "Rate card must be active and in the quote's currency" }],
        });
      }
    }
    const last = await ctx.tx
      .selectFrom("quotes")
      .select((eb) => eb.fn.max("version_no").as("v"))
      .where("deal_id", "=", deal.id)
      .executeTakeFirst();
    const q = await ctx.tx
      .insertInto("quotes")
      .values({
        deal_id: deal.id,
        client_id: deal.client_id,
        owner_id: deal.owner_id,
        engagement_type_id: i.engagementTypeId,
        project_type_id: i.projectTypeId ?? null,
        rate_card_id: i.rateCardId ?? null,
        version_no: (last?.v ?? 0) + 1,
        title: i.title,
        currency: i.currency,
        billing_model: i.billingModel,
        period_months: i.periodMonths ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const { quote } = await reprice(ctx, q);
    ctx.emit("quote.created", { quoteId: q.id, dealId: deal.id });
    return { id: quote.id, version: quote.version, versionNo: quote.version_no };
  },
  subject: (_i, r) => ({ type: "quote", id: r.id }),
});

export const quoteSave = defineCommand({
  name: "quote.save",
  summary: "Save a quote's lines and terms; the server recomputes margin (edits after submit return it to draft)",
  permission: "quote.edit",
  input: QuoteSaveInput,
  exposeTo: ["web", "mcp"],
  load: (ctx, i) => lockQuoteForChange(ctx, i.id, { dealLock: "share", requireOpen: true }),
  scope: quoteScope,
  async run(ctx, i, q) {
    assertVersion(q.version, i.expectedVersion);
    if (!(EDITABLE as readonly string[]).includes(q.status)) throw new DomainError("QUOTE_LOCKED", { status: q.status });
    // Editing lines re-states costs; only someone who can see them may do it (else costs would silently reset).
    if (i.lines && !can(ctx.actor, "finance.view_costs", quoteScope(q)))
      throw new DomainError("FORBIDDEN", { reason: "costs_hidden" });
    if (i.engagementTypeId !== undefined && i.engagementTypeId !== q.engagement_type_id)
      await assertEngagementActive(ctx, i.engagementTypeId);
    const billing = i.billingModel ?? q.billing_model;
    const months = i.periodMonths !== undefined ? i.periodMonths : q.period_months;
    if ((billing === "retainer") !== !!months) {
      throw new DomainError("VALIDATION", {
        issues: [{ path: "periodMonths", message: "Retainers need months; one-off quotes do not" }],
      });
    }
    const base = await ctx.tx
      .updateTable("quotes")
      .set((eb) => ({
        version: eb("version", "+", 1),
        status: "draft", // COM-QB-07: any edit after submit goes back to draft
        ...(i.title !== undefined && { title: i.title }),
        ...(i.engagementTypeId !== undefined && { engagement_type_id: i.engagementTypeId }),
        ...(i.projectTypeId !== undefined && { project_type_id: i.projectTypeId }),
        billing_model: billing,
        period_months: months ?? null,
        ...(i.validUntil !== undefined && { valid_until: i.validUntil }),
        ...(i.terms !== undefined && { terms: i.terms }),
      }))
      .where("id", "=", q.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (i.lines) await writeLines(ctx, base, i.lines);
    const { quote, totals } = await reprice(ctx, base);
    if (quote.content_sha256 !== q.content_sha256 || q.status !== "draft") await supersedePending(ctx, "quote", q.id);
    return {
      id: quote.id,
      version: quote.version,
      status: quote.status as QuoteStatus,
      totalMinor: totals.totalMinor.toString(),
    };
  },
  subject: (i) => ({ type: "quote", id: i.id }),
});

export const quoteSubmit = defineCommand({
  name: "quote.submit",
  summary: "Submit a draft: at or above floor → ready; below floor → Finance/Ops approval",
  permission: "quote.submit",
  input: QuoteSubmitInput,
  exposeTo: ["web", "mcp"],
  load: (ctx, i) => lockQuoteForChange(ctx, i.id, { dealLock: "share", requireOpen: true }),
  scope: quoteScope,
  async run(ctx, i, q0) {
    assertVersion(q0.version, i.expectedVersion);
    if (q0.status !== "draft") throw new DomainError("INVALID_TRANSITION", { from: q0.status, event: "submit" });
    const { quote: q, totals, floors, lines } = await reprice(ctx, q0);
    if (!lines.length) throw new DomainError("QUOTE_EMPTY");
    const who = ctx.actor.type === "user" ? ctx.actor.id : null;
    const next: QuoteStatus = totals.belowFloor ? "margin_review" : "ready";
    const updated = await ctx.tx
      .updateTable("quotes")
      .set((eb) => ({
        status: next,
        submitted_by: who,
        submitted_at: ctx.now,
        send_on_approval: i.sendOnApproval,
        version: eb("version", "+", 1),
      }))
      .where("id", "=", q.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    let approvalId: string | null = null;
    if (totals.belowFloor) {
      const client = await ctx.tx.selectFrom("clients").select("name").where("id", "=", q.client_id).executeTakeFirstOrThrow();
      // APR-EN-12: the worst of the two gaps; an undefined fee margin (priced at zero with cost) is the largest gap.
      const feeGap = totals.belowFeeFloor
        ? totals.feeMarginBp === null
          ? 10_000
          : floors.feeMarginFloorBp - totals.feeMarginBp
        : 0;
      const ptGap =
        totals.belowMarkupFloor && floors.passthroughMarkupFloorBp !== null && totals.ptMarkupBp !== null
          ? floors.passthroughMarkupFloorBp - totals.ptMarkupBp
          : 0;
      const gap = Math.max(feeGap, ptGap);
      const a = await createApproval(ctx, {
        kind: "margin_floor",
        subject: { type: "quote", id: q.id, version: updated.version, hash: updated.content_sha256 },
        snapshot: {
          title: `${client.name} — ${q.title} (v${q.version_no})`,
          scope: quoteScope(q),
          facts: { currency: q.currency, totalMinor: totals.totalMinor.toString(), engagementType: floors.label },
          costs: {
            feeMarginBp: totals.feeMarginBp,
            feeFloorBp: floors.feeMarginFloorBp,
            ptMarkupBp: totals.ptMarkupBp,
            ptFloorBp: floors.passthroughMarkupFloorBp,
          },
          floorGapBp: gap,
        },
        onApprove: { sendQuote: i.sendOnApproval },
      });
      approvalId = a.id;
    }
    ctx.emit("quote.submitted", { quoteId: q.id, status: next });
    return { id: q.id, status: next, version: updated.version, approvalId };
  },
  subject: (i) => ({ type: "quote", id: i.id }),
});

lockSubjectWith("margin_floor", "quote", (ctx, quoteId) =>
  lockQuoteForChange(ctx, quoteId, { dealLock: "share", requireOpen: false }),
);

/** APR-EN-10: a margin_floor decision moves the quote, and may send it as the requester. */
onApprovalDecided("margin_floor", "quote", async (ctx, a, decision) => {
  const q = await lockQuote(ctx, a.subject_id);
  if (q.status !== "margin_review" || q.content_sha256 !== a.subject_hash) return; // stale: superseded content
  const next = decision === "approve" ? "ready" : "draft";
  await ctx.tx
    .updateTable("quotes")
    .set((eb) => ({ status: next, version: eb("version", "+", 1) }))
    .where("id", "=", q.id)
    .execute();
  if (decision === "approve" && (a.on_approve as { sendQuote?: boolean }).sendQuote) {
    // COM-QB-08: the worker runs quote.send as the requester, on behalf of this approval.
    // The worker re-checks this hash before sending: a stale event never sends different content (COM-QB-08).
    ctx.emit("quote.send_requested", {
      quoteId: q.id,
      requesterId: a.requested_by,
      approvalId: a.id,
      subjectHash: a.subject_hash,
    });
  }
});

/** COM-QB-06: below floor needs an approved margin_floor for exactly this content. */
async function assertFloorCleared(ctx: Ctx, q: QuoteRow) {
  if (!q.below_floor) return;
  const ok = await ctx.tx
    .selectFrom("approvals")
    .select("id")
    .where("kind", "=", "margin_floor")
    .where("subject_type", "=", "quote")
    .where("subject_id", "=", q.id)
    .where("subject_hash", "=", q.content_sha256)
    .where("status", "=", "approved")
    .whereRef("decided_by", "<>", "requested_by")
    .executeTakeFirst();
  if (!ok) throw new DomainError("MARGIN_BELOW_FLOOR");
}

export const quoteSend = defineCommand({
  name: "quote.send",
  summary: "Send a ready quote: freezes FX and locks it",
  permission: "quote.send",
  input: QuoteSendInput,
  exposeTo: ["web", "job"],
  // Deal locked FOR UPDATE first: two versions of one deal can never be sent at once (COM-QB-09).
  load: (ctx, i) => lockQuoteForChange(ctx, i.id, { dealLock: "update", requireOpen: true }),
  scope: quoteScope,
  async run(ctx, i, q0) {
    assertVersion(q0.version, i.expectedVersion);
    if (q0.status !== "ready") throw new DomainError("INVALID_TRANSITION", { from: q0.status, event: "send" });
    const { quote: q, lines } = await reprice(ctx, q0); // the hash must still match what was approved
    if (!lines.length) throw new DomainError("QUOTE_EMPTY");
    await assertFloorCleared(ctx, q);
    let fxMicros = 1_000_000n;
    let fxDate = businessDate(ctx.now);
    if (q.currency === "KHR") {
      const fx = await currentFxRate(ctx);
      if (!fx) throw new DomainError("FX_RATE_MISSING");
      fxMicros = fx.rateMicros;
      fxDate = fx.rateDate;
    }
    const sender = ctx.actor.type === "user" ? ctx.actor.id : null;
    // Earlier sent versions of this deal are superseded (COM-QB-09).
    await ctx.tx
      .updateTable("quotes")
      .set((eb) => ({ status: "superseded", version: eb("version", "+", 1) }))
      .where("deal_id", "=", q.deal_id)
      .where("id", "<>", q.id)
      .where("status", "=", "sent")
      .execute();
    const sent = await ctx.tx
      .updateTable("quotes")
      .set((eb) => ({
        status: "sent",
        sent_by: sender,
        sent_at: ctx.now,
        fx_rate_micros: fxMicros,
        fx_rate_date: fxDate,
        pdf_status: "pending",
        version: eb("version", "+", 1),
      }))
      .where("id", "=", q.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const deal = await ctx.tx.selectFrom("deals").select(["id", "stage"]).where("id", "=", q.deal_id).executeTakeFirstOrThrow();
    if (deal.stage === "lead" || deal.stage === "qualified") {
      await ctx.tx
        .updateTable("deals")
        .set((eb) => ({ stage: "proposal", version: eb("version", "+", 1) }))
        .where("id", "=", deal.id)
        .execute();
      await ctx.tx
        .insertInto("deal_stage_history")
        .values({
          deal_id: deal.id,
          from_stage: deal.stage,
          to_stage: "proposal",
          note: `Quote v${q.version_no} sent`,
          changed_by: sender,
          changed_at: ctx.now,
        })
        .execute();
    }
    ctx.emit("quote.sent", { quoteId: q.id, dealId: q.deal_id });
    return { id: q.id, status: "sent" as const, version: sent.version, fxRateDate: fxDate };
  },
  subject: (i) => ({ type: "quote", id: i.id }),
});

export const quoteRevise = defineCommand({
  name: "quote.revise",
  summary: "Start the next version of a sent, rejected or expired quote",
  permission: "quote.edit",
  input: QuoteReviseInput,
  exposeTo: ["web", "mcp"],
  load: (ctx, i) => lockQuoteForChange(ctx, i.id, { dealLock: "update", requireOpen: true }),
  scope: quoteScope,
  async run(ctx, _i, q) {
    if (!["sent", "rejected", "expired"].includes(q.status))
      throw new DomainError("INVALID_TRANSITION", { from: q.status, event: "revise" });
    const last = await ctx.tx
      .selectFrom("quotes")
      .select((eb) => eb.fn.max("version_no").as("v"))
      .where("deal_id", "=", q.deal_id)
      .executeTakeFirstOrThrow();
    const copy = await ctx.tx
      .insertInto("quotes")
      .values({
        deal_id: q.deal_id,
        client_id: q.client_id,
        owner_id: q.owner_id,
        engagement_type_id: q.engagement_type_id,
        project_type_id: q.project_type_id,
        rate_card_id: q.rate_card_id,
        version_no: (last.v ?? q.version_no) + 1,
        supersedes_quote_id: q.id,
        title: q.title,
        currency: q.currency,
        billing_model: q.billing_model,
        period_months: q.period_months,
        valid_until: q.valid_until,
        terms: q.terms,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const lines = await loadLines(ctx, q.id);
    if (lines.length) {
      await ctx.tx
        .insertInto("quote_lines")
        .values(lines.map(({ id: _id, created_at: _c, updated_at: _u, quote_id: _q, ...l }) => ({ ...l, quote_id: copy.id })))
        .execute();
    }
    const { quote } = await reprice(ctx, copy);
    return { id: quote.id, version: quote.version, versionNo: quote.version_no };
  },
  subject: (_i, r) => ({ type: "quote", id: r.id }),
});

export const quoteMarkRejected = defineCommand({
  name: "quote.mark_rejected",
  summary: "Record that the client rejected a sent quote",
  permission: "quote.edit",
  input: QuoteRejectInput,
  exposeTo: ["web"],
  load: (ctx, i) => lockQuoteForChange(ctx, i.id, { dealLock: "share", requireOpen: false }),
  scope: quoteScope,
  async run(ctx, i, q) {
    assertVersion(q.version, i.expectedVersion);
    if (q.status !== "sent") throw new DomainError("INVALID_TRANSITION", { from: q.status, event: "reject" });
    const r = await ctx.tx
      .updateTable("quotes")
      .set((eb) => ({ status: "rejected", rejected_reason: i.reason, version: eb("version", "+", 1) }))
      .where("id", "=", q.id)
      .returning(["id", "status", "version"])
      .executeTakeFirstOrThrow();
    ctx.emit("quote.rejected", { quoteId: q.id, dealId: q.deal_id });
    return r;
  },
  subject: (i) => ({ type: "quote", id: i.id }),
});

// ---- Reads, with cost redaction (COM-QB-04 / INV-16) -------------------------------------------

type LineRow = Awaited<ReturnType<typeof loadLines>>[number];

export function quoteDto(ctx: Ctx, q: QuoteRow, lines?: LineRow[]) {
  const showCosts = can(ctx.actor, "finance.view_costs", quoteScope(q));
  const s = (v: bigint | null) => (v === null ? null : v.toString());
  return {
    id: q.id,
    dealId: q.deal_id,
    clientId: q.client_id,
    ownerId: q.owner_id,
    versionNo: q.version_no,
    title: q.title,
    // D-QB-3 / COM-QB-04: "margin_review" vs "ready" reveals the below-floor flag; non-cost-holders see "submitted".
    status: (showCosts || (q.status !== "margin_review" && q.status !== "ready") ? q.status : "submitted") as
      QuoteStatus | "submitted",
    currency: q.currency,
    billingModel: q.billing_model,
    periodMonths: q.period_months,
    engagementTypeId: q.engagement_type_id,
    projectTypeId: q.project_type_id,
    rateCardId: q.rate_card_id,
    validUntil: q.valid_until,
    terms: q.terms,
    feePriceMinor: s(q.fee_price_minor),
    ptPriceMinor: s(q.pt_price_minor),
    discountMinor: s(q.discount_minor),
    totalMinor: s(q.total_minor),
    sendOnApproval: q.send_on_approval,
    sentAt: q.sent_at,
    fxRateMicros: s(q.fx_rate_micros),
    fxRateDate: q.fx_rate_date,
    pdfStatus: q.pdf_status,
    rejectedReason: q.rejected_reason,
    version: q.version,
    canEdit: (EDITABLE as readonly string[]).includes(q.status) && can(ctx.actor, "quote.edit", quoteScope(q)),
    canSend: q.status === "ready" && can(ctx.actor, "quote.send", quoteScope(q)),
    costs: showCosts
      ? {
          feeCostMinor: s(q.fee_cost_minor),
          ptCostMinor: s(q.pt_cost_minor),
          feeMarginBp: q.fee_margin_bp,
          ptMarkupBp: q.pt_markup_bp,
          belowFloor: q.below_floor,
        }
      : null,
    lines: lines?.map((l) => ({
      kind: l.kind,
      rateCardItemId: l.rate_card_item_id,
      serviceCode: l.service_code,
      descriptionEn: l.description_en,
      descriptionKm: l.description_km,
      qtyMilli: l.qty_milli,
      unitPriceMinor: s(l.unit_price_minor),
      listPriceMinor: s(l.list_price_minor),
      discountBp: l.discount_bp,
      linePriceMinor: s(l.line_price_minor),
      perPeriod: l.per_period,
      quotedMinutes: l.quoted_minutes,
      unitCostMinor: showCosts ? s(l.unit_cost_minor) : null,
      lineCostMinor: showCosts ? s(l.line_cost_minor) : null,
    })),
  };
}

export const quoteGet = defineQuery({
  name: "quote.get",
  summary: "One quote with lines (costs and margin only for finance.view_costs holders)",
  permission: "deal.view",
  input: ByIdInput,
  exposeTo: ["web", "mcp"],
  async load(ctx, i) {
    return notFoundIfMissing(await ctx.tx.selectFrom("quotes").selectAll().where("id", "=", i.id).executeTakeFirst());
  },
  scope: quoteScope,
  async run(ctx, _i, q) {
    const floors = await floorsFor(ctx, q.engagement_type_id);
    const approval = await ctx.tx
      .selectFrom("approvals")
      .select(["id", "status", "assignee_id"])
      .where("subject_type", "=", "quote")
      .where("subject_id", "=", q.id)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    const dto = quoteDto(ctx, q, await loadLines(ctx, q.id));
    const names = await ctx.tx
      .selectFrom("deals as d")
      .innerJoin("clients as c", "c.id", "d.client_id")
      .select(["d.title as dealTitle", "c.name as clientName", "c.name_km as clientNameKm"])
      .where("d.id", "=", q.deal_id)
      .executeTakeFirstOrThrow();
    return {
      ...dto,
      ...names,
      // Floors are policy, not cost; but only cost-holders need them to interpret margin.
      floors: dto.costs ? floors : null,
      approval: approval && dto.costs ? { id: approval.id, status: approval.status } : null,
    };
  },
  subject: (i) => ({ type: "quote", id: i.id }),
});

export const quoteList = defineQuery({
  name: "quote.list",
  summary: "All versions of the quotes on a deal",
  permission: "deal.view",
  input: QuoteListInput,
  exposeTo: ["web", "mcp"],
  async load(ctx, i) {
    return notFoundIfMissing(
      await ctx.tx.selectFrom("deals").select(["id", "owner_id"]).where("id", "=", i.dealId).executeTakeFirst(),
    );
  },
  scope: (d) => ({ ownerIds: [d.owner_id] }),
  async run(ctx, i) {
    const rows = await ctx.tx
      .selectFrom("quotes")
      .selectAll()
      .where("deal_id", "=", i.dealId)
      .orderBy("version_no", "desc")
      .execute();
    return rows.map((q) => quoteDto(ctx, q));
  },
});

/** Status and version of a quote, for the worker (no actor needed to peek; the send itself is authorised). */
export async function quoteState(kernel: Kernel, id: string) {
  return kernel.db
    .selectFrom("quotes")
    .select(["status", "version", "content_sha256", "send_on_approval"])
    .where("id", "=", id)
    .executeTakeFirst();
}
