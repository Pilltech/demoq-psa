// Business time is Asia/Phnom_Penh (UTC+7, no daylight saving). Core never reads the wall clock (ctx.now).
const PHNOM_PENH_OFFSET_MS = 7 * 3600_000;

/** Calendar date (YYYY-MM-DD) in Phnom Penh for an instant. */
export function businessDate(at: Date): string {
  return new Date(at.getTime() + PHNOM_PENH_OFFSET_MS).toISOString().slice(0, 10);
}

/** Add whole calendar days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** First day of the month of a YYYY-MM-DD date. */
export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** First day of the month `months` after the month of `date`. */
export function addMonths(date: string, months: number): string {
  const d = new Date(`${monthStart(date)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** Last day of the month of a YYYY-MM-DD date. */
export function monthEnd(date: string): string {
  return addDays(addMonths(date, 1), -1);
}
