// Retainer periods: opened ahead of time, activated and closed by a daily job. Spec: specs/commercial/retainers.md (COM-RT-*)
import { z } from "zod";
import { addDays, businessDate, defineCommand } from "../kernel";
import { recordDiscounts } from "../reporting/giveaway";
import { insertScopeItems, retainerPeriod } from "./accept";

/** COM-RT-02: the next period opens this many days before it starts. */
export const PERIOD_LEAD_DAYS = 7;

export const retainerTick = defineCommand({
  name: "scope.retainer_tick",
  summary: "Open upcoming retainer periods (7 days ahead) and move periods to active/closed",
  permission: "project.jobs",
  input: z.object({}).default({}),
  exposeTo: ["job"],
  async run(ctx) {
    const today = businessDate(ctx.now);
    let opened = 0;
    const scopes = await ctx.tx
      .selectFrom("scopes as s")
      .innerJoin("projects as p", "p.scope_id", "s.id")
      .select(["s.id", "s.quote_id", "s.client_id", "s.currency", "s.fx_rate_micros", "s.period_months", "s.starts_on", "p.id as project_id"])
      .where("s.billing_model", "=", "retainer")
      .where("p.status", "in", ["gated", "active", "on_hold"])
      .execute();
    for (const s of scopes) {
      const have = await ctx.tx.selectFrom("scope_periods").select("period_no").where("scope_id", "=", s.id).execute();
      const haveNos = new Set(have.map((h) => h.period_no));
      for (let n = 2; n <= (s.period_months ?? 0); n++) {
        const p = retainerPeriod(s.starts_on, n);
        if (addDays(p.period_start, -PERIOD_LEAD_DAYS) > today) break;
        if (haveNos.has(n)) continue;
        // Idempotent: UNIQUE (scope_id, period_no) — a concurrent run's insert wins, this one skips.
        const row = await ctx.tx
          .insertInto("scope_periods")
          .values({ scope_id: s.id, ...p, status: "upcoming" })
          .onConflict((oc) => oc.doNothing())
          .returning("id")
          .executeTakeFirst();
        if (!row) continue;
        const lines = await ctx.tx.selectFrom("quote_lines").selectAll().where("quote_id", "=", s.quote_id).where("per_period", "=", true).orderBy("position").execute();
        await insertScopeItems(ctx, s.id, row.id, { type: "retainer_period", id: row.id }, lines);
        await recordDiscounts(ctx, {
          clientId: s.client_id,
          projectId: s.project_id,
          currency: s.currency,
          fxRateMicros: s.fx_rate_micros,
          occurredOn: p.period_start,
          sourceType: "scope_period",
          sourceId: row.id,
          lines: lines.map((l) => ({ kind: l.kind, qtyMilli: l.qty_milli, listPriceMinor: l.list_price_minor, linePriceMinor: l.line_price_minor })),
        });
        ctx.emit("scope.period_opened", { scopeId: s.id, periodNo: n, projectId: s.project_id });
        opened++;
      }
    }
    // COM-RT-03
    const activated = await ctx.tx
      .updateTable("scope_periods")
      .set({ status: "active" })
      .where("status", "=", "upcoming")
      .where("period_start", "<=", today)
      .where("period_end", ">=", today)
      .returning("id")
      .execute();
    const closed = await ctx.tx
      .updateTable("scope_periods")
      .set({ status: "closed" })
      .where("status", "in", ["upcoming", "active"])
      .where("period_end", "<", today)
      .returning("id")
      .execute();
    return { opened, activated: activated.length, closed: closed.length };
  },
});
