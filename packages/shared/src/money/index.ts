// Money is integer minor units + ISO currency. No floats, anywhere (principle 5).
// KHR has exponent 0 (whole riel, ADR-0006); USD has exponent 2.

export const CURRENCIES = { USD: { exponent: 2 }, KHR: { exponent: 0 } } as const;
export type Currency = keyof typeof CURRENCIES;

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: Currency;
}

export class CurrencyMismatchError extends Error {
  readonly code = "CURRENCY_MISMATCH";
  constructor(a: Currency, b: Currency) {
    super(`Cannot combine ${a} and ${b} without a stored FX rate (INV-15)`);
  }
}

export function isCurrency(v: unknown): v is Currency {
  return typeof v === "string" && Object.hasOwn(CURRENCIES, v);
}

export function money(amountMinor: bigint | number, currency: Currency): Money {
  if (typeof amountMinor === "number" && !Number.isSafeInteger(amountMinor)) {
    throw new RangeError(`Money amounts must be integers in minor units, got ${amountMinor}`);
  }
  return { amountMinor: BigInt(amountMinor), currency };
}

function same(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  same(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function sub(a: Money, b: Money): Money {
  same(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function sum(items: readonly Money[], currency: Currency): Money {
  return items.reduce((acc, m) => add(acc, m), money(0n, currency));
}

/** Integer division rounding half away from zero (ADR-0007: half-up per line). */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError("Division by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return negative ? -q : q;
}

/** Multiply by basis points (1 bp = 0.01%), rounding half-up. */
export function applyBp(m: Money, bp: bigint | number): Money {
  return { amountMinor: divRoundHalfUp(m.amountMinor * BigInt(bp), 10_000n), currency: m.currency };
}

/** Multiply by a quantity in thousandths (qty_milli), rounding half-up. */
export function timesQtyMilli(unit: Money, qtyMilli: bigint | number): Money {
  return { amountMinor: divRoundHalfUp(unit.amountMinor * BigInt(qtyMilli), 1000n), currency: unit.currency };
}

/** Parse a user-typed decimal string ("1,234.50") into minor units without floats. */
export function parseMoney(input: string, currency: Currency): Money {
  const s = input.replace(/[,\s]/g, "").replace(/^\$/, "");
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError(`Not a money amount: "${input}"`);
  const [, sign, whole = "0", frac = ""] = m;
  const exp = CURRENCIES[currency].exponent;
  if (frac.length > exp) throw new RangeError(`${currency} allows at most ${exp} decimal places`);
  const minor = BigInt(whole + frac.padEnd(exp, "0"));
  return money(sign ? -minor : minor, currency);
}

/** Format for display. Locale-aware grouping, no floating point. */
export function formatMoney(m: Money, locale: "en" | "km" = "en"): string {
  const exp = CURRENCIES[m.currency].exponent;
  const neg = m.amountMinor < 0n;
  const abs = neg ? -m.amountMinor : m.amountMinor;
  const s = abs.toString().padStart(exp + 1, "0");
  const whole = s.slice(0, s.length - exp) || "0";
  const frac = exp ? s.slice(s.length - exp) : "";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const num = frac ? `${grouped}.${frac}` : grouped;
  const body = m.currency === "USD" ? `$${num}` : locale === "km" ? `${num}៛` : `KHR ${num}`;
  return neg ? `-${body}` : body;
}
