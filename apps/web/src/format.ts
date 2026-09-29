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

/** YYYY-MM-DD + n days (calendar arithmetic in UTC, no time-zone drift). */
export const addDaysIso = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Task estimates: 90 → "1h 30m". */
export const formatMinutes = (m: number) => {
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h && r ? `${h}h ${r}m` : h ? `${h}h` : `${r}m`;
};

/** Minutes → hours text for an input: 90 → "1.5", 120 → "2", 20 → "0.33". */
export const minutesToHoursInput = (m: number | null) =>
  m === null ? "" : m % 60 === 0 ? String(m / 60) : (m / 60).toFixed(2).replace(/0$/, "");

/** "4" / "1.5" / "0.25" hours → whole minutes (1 … 100,000), else null. Integer arithmetic on the digits. */
export function parseHours(input: string): number | null {
  const m = /^(\d{1,4})(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const hundredths = Number(m[1]!) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  const minutes = Math.round((hundredths * 60) / 100);
  return minutes > 0 && minutes <= 100_000 ? minutes : null;
}

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export const isoWeekday = (d: string) => {
  const w = new Date(`${d}T00:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
};
/** Monday of the week (Monday–Sunday, D-TM-3) that contains the date. */
export const mondayOf = (d: string) => addDaysIso(d, 1 - isoWeekday(d));

/** "1h 30m" / "7h 15m" as a short decimal-hours input for a timesheet cell (0 → ""). */
export const minutesToCell = (m: number) => (m ? minutesToHoursInput(m) : "");
/** A timesheet cell: "" or "0" → 0 minutes; "1.5" / "1,5" → 90; "1:30" → 90; else null (invalid). */
export function parseCell(input: string): number | null {
  const s = input.trim();
  if (s === "" || s === "0") return 0;
  const hm = /^(\d{1,2}):([0-5]\d)$/.exec(s);
  if (hm) {
    const m = Number(hm[1]!) * 60 + Number(hm[2]!);
    return m <= 1440 ? m : null;
  }
  const m = parseHours(s);
  return m !== null && m <= 1440 ? m : null;
}
