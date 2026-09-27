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
