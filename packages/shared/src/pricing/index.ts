// The ONE pricing function (INV-02, COM-QB-02/03). Runs in the browser (live margin as you type) and on the
// server (stored figures, which win). Pure and integer-only: bigint minor units, basis points, qty in thousandths.
import { divRoundHalfUp } from "../money";

export type LineKind = "fee" | "pass_through";

export interface PricingLineInput {
  kind: LineKind;
  qtyMilli: bigint | number;
  unitPriceMinor: bigint;
  unitCostMinor: bigint;
  discountBp?: number;
}

export interface PricedLine {
  grossMinor: bigint; // qty × unit price, rounded
  discountMinor: bigint;
  priceMinor: bigint; // gross − discount
  costMinor: bigint;
}

export interface Floors {
  feeMarginFloorBp: number;
  passthroughMarkupFloorBp: number | null;
  passthroughMarkupWarnBp: number;
}

export interface QuoteTotals {
  lines: PricedLine[];
  feePriceMinor: bigint;
  feeCostMinor: bigint;
  ptPriceMinor: bigint;
  ptCostMinor: bigint;
  discountMinor: bigint;
  totalMinor: bigint;
  /** (fee price − fee cost) / fee price, in bp; null without fee revenue. */
  feeMarginBp: number | null;
  /** (pt price − pt cost) / pt cost, in bp; null without pass-through cost. */
  ptMarkupBp: number | null;
  belowFeeFloor: boolean;
  belowMarkupFloor: boolean;
  markupWarning: boolean;
  belowFloor: boolean;
}

export function priceLine(l: PricingLineInput): PricedLine {
  const qty = BigInt(l.qtyMilli);
  const grossMinor = divRoundHalfUp(qty * l.unitPriceMinor, 1000n);
  const discountMinor = divRoundHalfUp(grossMinor * BigInt(l.discountBp ?? 0), 10_000n);
  const costMinor = divRoundHalfUp(qty * l.unitCostMinor, 1000n);
  return { grossMinor, discountMinor, priceMinor: grossMinor - discountMinor, costMinor };
}

/** Ratios are clamped to ±1,000,000 bp (±10,000%) so they always fit the int4 columns and stay meaningful. */
export const RATIO_CLAMP_BP = 1_000_000n;
const ratioBp = (num: bigint, den: bigint): number | null => {
  if (den === 0n) return null;
  const r = divRoundHalfUp(num * 10_000n, den);
  return Number(r > RATIO_CLAMP_BP ? RATIO_CLAMP_BP : r < -RATIO_CLAMP_BP ? -RATIO_CLAMP_BP : r);
};

export function priceQuote(lines: readonly PricingLineInput[], floors: Floors): QuoteTotals {
  const priced = lines.map(priceLine);
  let feePriceMinor = 0n,
    feeCostMinor = 0n,
    ptPriceMinor = 0n,
    ptCostMinor = 0n,
    discountMinor = 0n;
  priced.forEach((p, i) => {
    discountMinor += p.discountMinor;
    if (lines[i]!.kind === "fee") {
      feePriceMinor += p.priceMinor;
      feeCostMinor += p.costMinor;
    } else {
      ptPriceMinor += p.priceMinor;
      ptCostMinor += p.costMinor;
    }
  });
  const feeMarginBp = ratioBp(feePriceMinor - feeCostMinor, feePriceMinor);
  const ptMarkupBp = ratioBp(ptPriceMinor - ptCostMinor, ptCostMinor);
  const hasFees = lines.some((l) => l.kind === "fee");
  const hasPt = lines.some((l) => l.kind === "pass_through");
  // A fee line priced at zero is below any floor (margin undefined → treat as −∞).
  const belowFeeFloor =
    hasFees && (feeMarginBp === null ? feeCostMinor > 0n || floors.feeMarginFloorBp > 0 : feeMarginBp < floors.feeMarginFloorBp);
  const belowMarkupFloor =
    hasPt &&
    floors.passthroughMarkupFloorBp !== null &&
    (ptMarkupBp === null ? false : ptMarkupBp < floors.passthroughMarkupFloorBp);
  const markupWarning = hasPt && ptMarkupBp !== null && ptMarkupBp < floors.passthroughMarkupWarnBp;
  return {
    lines: priced,
    feePriceMinor,
    feeCostMinor,
    ptPriceMinor,
    ptCostMinor,
    discountMinor,
    totalMinor: feePriceMinor + ptPriceMinor,
    feeMarginBp,
    ptMarkupBp,
    belowFeeFloor,
    belowMarkupFloor,
    markupWarning,
    belowFloor: belowFeeFloor || belowMarkupFloor,
  };
}

/** Parse "1.5" (qty) into thousandths without floats. */
export function parseQtyMilli(input: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(input.trim());
  if (!m) throw new RangeError(`Not a quantity: "${input}"`);
  return BigInt(m[1]! + (m[2] ?? "").padEnd(3, "0"));
}

export function formatBp(bp: number | null): string {
  if (bp === null) return "—";
  const neg = bp < 0;
  const a = Math.abs(bp);
  return `${neg ? "-" : ""}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, "0")}%`;
}
