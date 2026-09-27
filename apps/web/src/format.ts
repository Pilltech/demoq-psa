// Text <-> integer helpers for inputs. No floats: money is minor units, qty is thousandths, percentages are basis points.
import { CURRENCIES, parseMoney, parseQtyMilli, type Currency } from "@demoq/shared";

/** Minor-unit digits → plain decimal text for an input ("123450" USD → "1234.50"). */
export function minorToInput(minor: string | null, currency: Currency): string {
  if (minor === null || minor === "") return "";
  const exp = CURRENCIES[currency].exponent;
  const neg = minor.startsWith("-");
  const digits = (neg ? minor.slice(1) : minor).padStart(exp + 1, "0");
  const whole = digits.slice(0, digits.length - exp);
  const frac = exp ? digits.slice(digits.length - exp) : "";
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Scaled integer → shortest decimal text (1500 / 3 places → "1.5"). */
function scaledToText(n: bigint, places: number): string {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(places + 1, "0");
  const whole = s.slice(0, s.length - places);
  const frac = s.slice(s.length - places).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export const qtyMilliToInput = (qtyMilli: number) => scaledToText(BigInt(qtyMilli), 3);
export const bpToPercentInput = (bp: number | null) => (bp === null ? "" : scaledToText(BigInt(bp), 2));
/** Riel per USD × 10⁶ → "4100" / "4102.5". */
export const microsToRate = (micros: string) => scaledToText(BigInt(micros), 6);

/** "18" / "18.5" / "18.25" percent → basis points (1800 / 1850 / 1825), 0–100%. */
export function parsePercentBp(input: string): number {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/%$/, ""));
  if (!m) throw new RangeError(`Not a percentage: "${input}"`);
  const bp = Number(m[1]!) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (bp > 10_000) throw new RangeError("At most 100%");
  return bp;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false };
const attempt = <T>(fn: () => T): Parsed<T> => {
  try {
    return { ok: true, value: fn() };
  } catch {
    return { ok: false };
  }
};

/** Non-negative money typed by a person ("1,250.50", "$80") → minor units. */
export const tryMoney = (input: string, currency: Currency): Parsed<bigint> =>
  attempt(() => {
    const v = parseMoney(input.replace(/៛/g, ""), currency).amountMinor;
    if (v < 0n || v > 999_999_999_999_999n) throw new RangeError("out of range");
    return v;
  });
/** Quantity ("1.5") → thousandths, 0.001 … 1,000,000. */
export const tryQty = (input: string): Parsed<bigint> =>
  attempt(() => {
    const v = parseQtyMilli(input);
    if (v < 1n || v > 1_000_000_000n) throw new RangeError("out of range");
    return v;
  });
export const tryPercent = (input: string): Parsed<number> => attempt(() => parsePercentBp(input === "" ? "0" : input));

/** Today's calendar date in Phnom Penh (YYYY-MM-DD). */
export const phnomPenhToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Phnom_Penh" }).format(new Date());
