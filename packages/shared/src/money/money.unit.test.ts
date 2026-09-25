import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { add, applyBp, CurrencyMismatchError, divRoundHalfUp, formatMoney, money, parseMoney, sum, timesQtyMilli } from ".";

describe("money", () => {
  it("adds same-currency amounts exactly", () => {
    expect(add(money(10, "USD"), money(5, "USD")).amountMinor).toBe(15n);
  });

  it("[INV-15] refuses to combine USD and KHR", () => {
    expect(() => add(money(1, "USD"), money(1, "KHR"))).toThrow(CurrencyMismatchError);
    expect(() => sum([money(1, "USD"), money(1, "KHR")], "USD")).toThrow(CurrencyMismatchError);
  });

  it("rejects non-integer minor units", () => {
    expect(() => money(1.5, "USD")).toThrow(RangeError);
  });

  it("rounds half away from zero (ADR-0007)", () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(-5n, 2n)).toBe(-3n);
    expect(divRoundHalfUp(4n, 3n)).toBe(1n);
    expect(applyBp(money(1005, "USD"), 5000).amountMinor).toBe(503n);
    expect(timesQtyMilli(money(333, "USD"), 1500).amountMinor).toBe(500n);
  });

  it("parses typed amounts without floats", () => {
    expect(parseMoney("1,234.50", "USD").amountMinor).toBe(123450n);
    expect(parseMoney("$0.1", "USD").amountMinor).toBe(10n);
    expect(parseMoney("40000", "KHR").amountMinor).toBe(40000n);
    expect(() => parseMoney("1.5", "KHR")).toThrow(RangeError);
    expect(() => parseMoney("12.345", "USD")).toThrow(RangeError);
    expect(() => parseMoney("abc", "USD")).toThrow(RangeError);
  });

  it("formats USD and KHR in both locales", () => {
    expect(formatMoney(money(123450, "USD"))).toBe("$1,234.50");
    expect(formatMoney(money(-5, "USD"))).toBe("-$0.05");
    expect(formatMoney(money(40000, "KHR"), "en")).toBe("KHR 40,000");
    expect(formatMoney(money(40000, "KHR"), "km")).toBe("40,000៛");
  });

  it("parse ∘ format round-trips for any USD amount (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 14n }), (n) => {
        const s = formatMoney(money(n, "USD"));
        expect(parseMoney(s, "USD").amountMinor).toBe(n);
      }),
    );
  });

  it("addition is associative and commutative (property)", () => {
    const amt = fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }).map((n) => money(n, "USD"));
    fc.assert(
      fc.property(amt, amt, amt, (a, b, c) => {
        expect(add(add(a, b), c).amountMinor).toBe(add(a, add(b, c)).amountMinor);
        expect(add(a, b).amountMinor).toBe(add(b, a).amountMinor);
      }),
    );
  });

  it("half-up rounding is never off by more than half a unit (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), fc.bigInt({ min: 1n, max: 10n ** 6n }), (n, d) => {
        const q = divRoundHalfUp(n, d);
        const err = q * d - n;
        expect(2n * (err < 0n ? -err : err) <= d).toBe(true);
      }),
    );
  });
});
