// Value given away: insert-only ledger (S3 part). Spec: specs/reporting/giveaway.md (REP-GV-*)
import { divRoundHalfUp } from "@demoq/shared";
import { monthStart, type Ctx } from "../kernel";

export interface DiscountLine {
  kind: string;
  qtyMilli: number;
  listPriceMinor: bigint | null;
  linePriceMinor: bigint;
}

/** Minor units of `currency` → US cents at a frozen rate (riel per USD × 10⁶). USD passes through. */
export function toUsdMinor(amountMinor: bigint, currency: string, fxRateMicros: bigint): bigint {
  if (currency === "USD") return amountMinor;
  // KHR has no minor unit: riel × 100 cents / (riel per USD).
  return divRoundHalfUp(amountMinor * 100n * 1_000_000n, fxRateMicros);
}

/** List × qty − line price, for a fee line priced below its rate-card list price; 0 otherwise. */
export function discountVsRatecard(l: DiscountLine): bigint {
  if (l.kind !== "fee" || l.listPriceMinor === null) return 0n;
  const gross = divRoundHalfUp(l.listPriceMinor * BigInt(l.qtyMilli), 1000n);
  const d = gross - l.linePriceMinor;
  return d > 0n ? d : 0n;
}

/** REP-GV-02: one `discount_vs_ratecard` row per discounted fee line; nothing when there is no discount. */
export async function recordDiscounts(
  ctx: Ctx,
  a: {
    clientId: string;
    projectId: string | null;
    currency: string;
    fxRateMicros: bigint;
    occurredOn: string;
    sourceType: string;
    sourceId: string;
    lines: readonly DiscountLine[];
  },
): Promise<number> {
  const fx = a.currency === "USD" ? 1_000_000n : a.fxRateMicros;
  const rows = a.lines
    .map((l) => discountVsRatecard(l))
    .filter((d) => d > 0n)
    .map((d) => ({
      attributed_month: monthStart(a.occurredOn),
      occurred_on: a.occurredOn,
      client_id: a.clientId,
      project_id: a.projectId,
      kind: "discount_vs_ratecard",
      amount_usd_minor: toUsdMinor(d, a.currency, fx),
      fx_rate_micros: fx,
      source_type: a.sourceType,
      source_id: a.sourceId,
    }));
  if (rows.length) await ctx.tx.insertInto("giveaway_entries").values(rows).execute();
  return rows.length;
}

export interface AbsorbedValuation {
  minutes: number;
  unitPriceMinor: bigint;
  quotedMinutes: number | null;
  currency: string;
  fxRateMicros: bigint;
}

/**
 * D-RV-3: minutes × the scope item's implied rate (unit price ÷ quoted minutes), in US cents at the frozen FX,
 * rounded once (half up). Null when there are no quoted minutes to derive a rate from.
 */
export function absorbedValueUsdMinor(v: AbsorbedValuation): bigint | null {
  if (!v.quotedMinutes || v.quotedMinutes <= 0) return null;
  const num = BigInt(v.minutes) * v.unitPriceMinor;
  if (v.currency === "USD") return divRoundHalfUp(num, BigInt(v.quotedMinutes));
  return divRoundHalfUp(num * 100n * 1_000_000n, BigInt(v.quotedMinutes) * v.fxRateMicros);
}

export const VALUATION_PENDING = "valuation_pending";

/**
 * D10 `absorbed_out_of_scope` (TSK-DL-09): one row when an out-of-scope request is decided "absorb", attributed to the
 * month of the decision. Not derivable (no scope item or no quoted minutes) → amount 0 with note `valuation_pending`.
 */
export async function recordAbsorbedOutOfScope(
  ctx: Ctx,
  a: {
    clientId: string;
    projectId: string;
    scopeItemId: string | null;
    minutes: number;
    occurredOn: string;
    sourceType: string;
    sourceId: string;
  },
): Promise<{ amountUsdMinor: bigint; note: string | null }> {
  const item = a.scopeItemId
    ? await ctx.tx
        .selectFrom("scope_items as i")
        .innerJoin("scopes as s", "s.id", "i.scope_id")
        .select(["i.unit_price_minor", "i.quoted_minutes", "s.currency", "s.fx_rate_micros"])
        .where("i.id", "=", a.scopeItemId)
        .executeTakeFirst()
    : undefined;
  const fx = !item || item.currency === "USD" ? 1_000_000n : item.fx_rate_micros;
  const amount = item
    ? absorbedValueUsdMinor({
        minutes: a.minutes,
        unitPriceMinor: item.unit_price_minor,
        quotedMinutes: item.quoted_minutes,
        currency: item.currency,
        fxRateMicros: fx,
      })
    : null;
  const note = amount === null ? VALUATION_PENDING : null;
  await ctx.tx
    .insertInto("giveaway_entries")
    .values({
      attributed_month: monthStart(a.occurredOn),
      occurred_on: a.occurredOn,
      client_id: a.clientId,
      project_id: a.projectId,
      kind: "absorbed_out_of_scope",
      amount_usd_minor: amount ?? 0n,
      fx_rate_micros: fx,
      source_type: a.sourceType,
      source_id: a.sourceId,
      note,
    })
    .execute();
  return { amountUsdMinor: amount ?? 0n, note };
}
