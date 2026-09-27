import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatBp, parseQtyMilli, priceLine, priceQuote, type PricingLineInput } from ".";

const floors = { feeMarginFloorBp: 2500, passthroughMarkupFloorBp: null, passthroughMarkupWarnBp: 1000 };
const fee = (qty: number, price: bigint, cost: bigint, discountBp = 0): PricingLineInput => ({
  kind: "fee",
  qtyMilli: qty * 1000,
  unitPriceMinor: price,
  unitCostMinor: cost,
  discountBp,
});
const pt = (qty: number, price: bigint, cost: bigint): PricingLineInput => ({
  kind: "pass_through",
  qtyMilli: qty * 1000,
  unitPriceMinor: price,
  unitCostMinor: cost,
});

describe("shared/pricing", () => {
  it("[COM-QB-02] fee margin and pass-through markup are computed separately", () => {
    // Fees: 10 h × $50 price, $30 cost → margin 40%. PT: $1,000 cost sold at $1,100 → markup 10%.
    const q = priceQuote([fee(10, 5000n, 3000n), pt(1, 110_000n, 100_000n)], floors);
    expect(q.feeMarginBp).toBe(4000);
    expect(q.ptMarkupBp).toBe(1000);
    expect(q.totalMinor).toBe(50_000n + 110_000n);
    expect(q.belowFloor).toBe(false);
  });

  it("[COM-QB-02] an influencer quote dominated by pass-through is not flagged for its low blended margin", () => {
    const q = priceQuote([fee(1, 100_000n, 50_000n), pt(1, 1_050_000n, 1_000_000n)], floors);
    expect(q.feeMarginBp).toBe(5000);
    expect(q.belowFeeFloor).toBe(false);
    expect(q.markupWarning).toBe(true); // 5% < 10% warning
    expect(q.belowFloor).toBe(false); // no markup floor set (D3)
  });

  it("[COM-QB-02] below the fee floor, or below a set markup floor, is flagged", () => {
    expect(priceQuote([fee(10, 5000n, 4100n)], floors).belowFeeFloor).toBe(true); // 18%
    const withPtFloor = { ...floors, passthroughMarkupFloorBp: 800 };
    expect(priceQuote([pt(1, 105_000n, 100_000n)], withPtFloor).belowMarkupFloor).toBe(true);
    expect(priceQuote([fee(1, 0n, 1n)], floors).belowFeeFloor).toBe(true); // free work with cost
  });

  it("[COM-QB-03] each line rounds half-up; discounts come off the rounded gross; totals are sums of lines", () => {
    // 1.5 × 333 = 499.5 → 500; 12.5% discount of 500 = 62.5 → 63; price 437.
    const l = priceLine({ kind: "fee", qtyMilli: 1500, unitPriceMinor: 333n, unitCostMinor: 101n, discountBp: 1250 });
    expect(l).toEqual({ grossMinor: 500n, discountMinor: 63n, priceMinor: 437n, costMinor: 152n });
    const q = priceQuote(
      [l, l].map(() => ({ kind: "fee" as const, qtyMilli: 1500, unitPriceMinor: 333n, unitCostMinor: 101n, discountBp: 1250 })),
      floors,
    );
    expect(q.feePriceMinor).toBe(874n);
    expect(q.discountMinor).toBe(126n);
  });

  it("[COM-QB-03] totals always equal the sum of line prices, fees and pass-through never net (property)", () => {
    const line = fc.record({
      kind: fc.constantFrom<"fee" | "pass_through">("fee", "pass_through"),
      qtyMilli: fc.integer({ min: 1, max: 1_000_000 }),
      unitPriceMinor: fc.bigInt({ min: 0n, max: 10n ** 9n }),
      unitCostMinor: fc.bigInt({ min: 0n, max: 10n ** 9n }),
      discountBp: fc.integer({ min: 0, max: 10_000 }),
    });
    fc.assert(
      fc.property(fc.array(line, { maxLength: 30 }), (lines) => {
        const q = priceQuote(lines, floors);
        const sum = q.lines.reduce((a, l) => a + l.priceMinor, 0n);
        expect(q.totalMinor).toBe(sum);
        expect(q.feePriceMinor + q.ptPriceMinor).toBe(sum);
        expect(q.lines.every((l) => l.priceMinor >= 0n && l.priceMinor <= l.grossMinor)).toBe(true);
        if (q.feeMarginBp !== null) expect(q.feeMarginBp).toBeLessThanOrEqual(10_000);
      }),
    );
  });

  it("parses quantities and formats basis points without floats", () => {
    expect(parseQtyMilli("1.5")).toBe(1500n);
    expect(parseQtyMilli("12")).toBe(12000n);
    expect(() => parseQtyMilli("1.2345")).toThrow(RangeError);
    expect(formatBp(1875)).toBe("18.75%");
    expect(formatBp(-305)).toBe("-3.05%");
    expect(formatBp(null)).toBe("—");
  });
});
