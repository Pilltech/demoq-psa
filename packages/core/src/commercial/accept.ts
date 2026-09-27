// Accepting a quote: scope, retainer first period, project, gates, template tasks, deal Won.
// Spec: specs/commercial/accept-scope.md (COM-AC-*), specs/commercial/retainers.md (COM-RT-01)
import { z } from "zod";
import { expectedVersion, isoDate, optionalText, requiredText, uuid } from "@demoq/shared";
import { supersedePending } from "../approvals";
import { assertCloseReason, recordStage } from "../crm/deals";
import { addMonths, assertVersion, businessDate, defineCommand, defineQuery, DomainError, monthEnd, notFoundIfMissing, type Ctx } from "../kernel";
import { createClientProject } from "../projects/projects";
import { recordDiscounts } from "../reporting/giveaway";
import { applyTemplate } from "../tasks/templates";
import { lockQuoteForChange } from "./quotes";

export const QuoteAcceptInput = z.object({
  id: uuid,
  expectedVersion,
  // Optional in the contract so a missing reason gets WIN_REASON_REQUIRED (COM-AC-01).
  winReasonCode: z.string().max(60).nullish(),
  plannedStart: isoDate,
  /** Default: the quote owner (D-AC-1). */
  projectManagerId: uuid.nullish(),
  /** Default: the quote's project type. */
  projectTypeId: uuid.nullish(),
  projectName: requiredText(200).optional(),
  note: optionalText(1000),
});

type QuoteLine = { id: string; kind: string; service_code: string | null; description_en: string; description_km: string | null; qty_milli: number; unit_price_minor: bigint; line_price_minor: bigint; quoted_minutes: number | null; per_period: boolean; list_price_minor: bigint | null };

/** Scope items from quote lines (COM-AC-03): insert-only rows. */
export async function insertScopeItems(
  ctx: Ctx,
  scopeId: string,
  periodId: string | null,
  source: { type: "quote" | "change_order" | "retainer_period"; id: string },
  lines: readonly Pick<QuoteLine, "kind" | "service_code" | "description_en" | "description_km" | "qty_milli" | "unit_price_minor" | "line_price_minor" | "quoted_minutes" | "per_period">[],
) {
  if (!lines.length) return [];
  return ctx.tx
    .insertInto("scope_items")
    .values(
      lines.map((l) => ({
        scope_id: scopeId,
        scope_period_id: periodId,
        source_type: source.type,
        source_id: source.id,
        kind: l.kind,
        service_code: l.service_code,
        description_en: l.description_en,
        description_km: l.description_km,
        qty_milli: l.qty_milli,
        unit_price_minor: l.unit_price_minor,
        line_price_minor: l.line_price_minor,
        quoted_minutes: l.quoted_minutes,
        per_period: l.per_period,
      })),
    )
    .returning(["id", "kind", "service_code"])
    .execute();
}

/** Monthly period n (1-based) of a retainer that starts in the month of `startsOn`. */
export function retainerPeriod(startsOn: string, n: number) {
  const start = addMonths(startsOn, n - 1);
  return { period_no: n, period_start: start, period_end: monthEnd(start) };
}

export const quoteAccept = defineCommand({
  name: "quote.accept",
  summary: "Record the client's acceptance of a sent quote: deal Won, scope, project with gates, template tasks",
  permission: "quote.accept",
  input: QuoteAcceptInput,
  exposeTo: ["web", "mcp"],
  async load(ctx, i) {
    // Lock order deal → quote (as every quote change).
    const q = await lockQuoteForChange(ctx, i.id, { dealLock: "update", requireOpen: true });
    const deal = await ctx.tx.selectFrom("deals").select(["id", "stage", "owner_id", "title"]).where("id", "=", q.deal_id).executeTakeFirstOrThrow();
    return { q, deal };
  },
  // COM-AC-06: the deal owner (own) or ops_lead (any).
  scope: (l) => ({ ownerIds: [l.deal.owner_id] }),
  async run(ctx, i, { q, deal }) {
    assertVersion(q.version, i.expectedVersion);
    if (q.status !== "sent") throw new DomainError("INVALID_TRANSITION", { from: q.status, event: "accept" });
    if (!i.winReasonCode) throw new DomainError("WIN_REASON_REQUIRED");
    await assertCloseReason(ctx, i.winReasonCode, "won");
    const projectTypeId = i.projectTypeId ?? q.project_type_id;
    if (!projectTypeId) throw new DomainError("VALIDATION", { issues: [{ path: "projectTypeId", message: "Choose a project type" }] });
    const pt = await ctx.tx.selectFrom("project_types").select(["id", "active"]).where("id", "=", projectTypeId).executeTakeFirst();
    if (!pt?.active) throw new DomainError("VALIDATION", { issues: [{ path: "projectTypeId", message: "Unknown or inactive project type" }] });
    const today = businessDate(ctx.now);
    const who = ctx.actor.type === "user" ? ctx.actor.id : null;

    // COM-AC-02: quote accepted (final); other open versions superseded; deal Won with the reason.
    const accepted = await ctx.tx
      .updateTable("quotes")
      .set((eb) => ({ status: "accepted", win_reason_code: i.winReasonCode!, version: eb("version", "+", 1) }))
      .where("id", "=", q.id)
      .returning(["id", "status", "version"])
      .executeTakeFirstOrThrow();
    const others = await ctx.tx
      .updateTable("quotes")
      .set((eb) => ({ status: "superseded", version: eb("version", "+", 1) }))
      .where("deal_id", "=", q.deal_id)
      .where("id", "<>", q.id)
      .where("status", "in", ["draft", "margin_review", "ready", "sent"])
      .returning("id")
      .execute();
    for (const o of others) await supersedePending(ctx, "quote", o.id);
    await ctx.tx
      .updateTable("deals")
      .set((eb) => ({
        stage: "won",
        close_reason_code: i.winReasonCode!,
        close_reason_kind: "won",
        close_note: i.note ?? null,
        closed_at: ctx.now,
        version: eb("version", "+", 1),
      }))
      .where("id", "=", deal.id)
      .execute();
    await recordStage(ctx, deal.id, deal.stage as never, "won", i.winReasonCode, i.note ?? `Quote v${q.version_no} accepted`);

    // COM-AC-03 / COM-RT-01: scope, and for a retainer its first monthly period.
    const lines: QuoteLine[] = await ctx.tx.selectFrom("quote_lines").selectAll().where("quote_id", "=", q.id).orderBy("position").execute();
    const scope = await ctx.tx
      .insertInto("scopes")
      .values({
        quote_id: q.id,
        client_id: q.client_id,
        currency: q.currency,
        fx_rate_micros: q.fx_rate_micros ?? 1_000_000n,
        billing_model: q.billing_model,
        period_months: q.period_months,
        starts_on: i.plannedStart,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    let periodId: string | null = null;
    if (q.billing_model === "retainer") {
      const p1 = retainerPeriod(i.plannedStart, 1);
      const period = await ctx.tx
        .insertInto("scope_periods")
        .values({ scope_id: scope.id, ...p1, status: p1.period_start <= today ? "active" : "upcoming" })
        .returning("id")
        .executeTakeFirstOrThrow();
      periodId = period.id;
      await insertScopeItems(ctx, scope.id, null, { type: "quote", id: q.id }, lines.filter((l) => !l.per_period));
      await insertScopeItems(ctx, scope.id, periodId, { type: "quote", id: q.id }, lines.filter((l) => l.per_period));
    } else {
      await insertScopeItems(ctx, scope.id, null, { type: "quote", id: q.id }, lines);
    }

    // COM-AC-04: gated client project with five gates, then its template tasks (TSK-TP-02).
    const client = await ctx.tx.selectFrom("clients").select("name").where("id", "=", q.client_id).executeTakeFirstOrThrow();
    const project = await createClientProject(ctx, {
      name: i.projectName ?? `${client.name} — ${q.title}`,
      clientId: q.client_id,
      dealId: deal.id,
      quoteId: q.id,
      scopeId: scope.id,
      projectTypeId,
      engagementTypeId: q.engagement_type_id,
      plannedStart: i.plannedStart,
      pmId: i.projectManagerId ?? q.owner_id,
      acceptedRef: `Quote v${q.version_no} accepted ${today}`,
    });
    const tasks = await applyTemplate(ctx, project);

    // REP-GV-02: discounts against the rate card, at the frozen rate.
    await recordDiscounts(ctx, {
      clientId: q.client_id,
      projectId: project.id,
      currency: q.currency,
      fxRateMicros: q.fx_rate_micros ?? 1_000_000n,
      occurredOn: periodId ? retainerPeriod(i.plannedStart, 1).period_start : today,
      sourceType: "quote",
      sourceId: q.id,
      lines: lines.map((l) => ({ kind: l.kind, qtyMilli: l.qty_milli, listPriceMinor: l.list_price_minor, linePriceMinor: l.line_price_minor })),
    });

    ctx.emit("quote.accepted", { quoteId: q.id, dealId: deal.id, projectId: project.id, acceptedBy: who });
    return { id: q.id, status: accepted.status, version: accepted.version, projectId: project.id, scopeId: scope.id, tasksCreated: tasks };
  },
  subject: (i) => ({ type: "quote", id: i.id }),
});

/** Scope value = quote + accepted change orders (COM-CO-05), per item and period. */
export async function scopeValue(ctx: Ctx, scopeId: string): Promise<bigint> {
  const r = await ctx.tx
    .selectFrom("scope_items")
    .select((eb) => eb.fn.coalesce(eb.fn.sum<string>("line_price_minor"), eb.val("0")).as("v"))
    .where("scope_id", "=", scopeId)
    .executeTakeFirstOrThrow();
  return BigInt(r.v);
}

export const scopeGet = defineQuery({
  name: "scope.get",
  summary: "A project's scope: items from the quote and change orders, retainer periods and total value",
  permission: "project.view",
  input: z.object({ projectId: uuid }),
  exposeTo: ["web", "mcp"],
  async run(ctx, i) {
    const p = notFoundIfMissing(await ctx.tx.selectFrom("projects").select(["id", "scope_id"]).where("id", "=", i.projectId).executeTakeFirst());
    if (!p.scope_id) return null;
    const scope = await ctx.tx.selectFrom("scopes").selectAll().where("id", "=", p.scope_id).executeTakeFirstOrThrow();
    const periods = await ctx.tx.selectFrom("scope_periods").selectAll().where("scope_id", "=", scope.id).orderBy("period_no").execute();
    const items = await ctx.tx.selectFrom("scope_items").selectAll().where("scope_id", "=", scope.id).orderBy("created_at").execute();
    const s = (v: bigint) => v.toString();
    return {
      id: scope.id,
      currency: scope.currency,
      billingModel: scope.billing_model,
      periodMonths: scope.period_months,
      startsOn: scope.starts_on,
      fxRateMicros: s(scope.fx_rate_micros),
      valueMinor: s(await scopeValue(ctx, scope.id)),
      periods,
      items: items.map((it) => ({ ...it, unit_price_minor: s(it.unit_price_minor), line_price_minor: s(it.line_price_minor) })),
    };
  },
  subject: (i) => ({ type: "project", id: i.projectId }),
});

