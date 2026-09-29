// Pure pre-fill arithmetic (D-TM-2). Spec: specs/time/timesheets.md (TIM-TS-04). No I/O: unit-tested directly.
import { sha256 } from "../kernel";

export type TargetType = "task" | "project" | "deal" | "internal";

export interface TargetRef {
  targetType: TargetType;
  taskId: string | null;
  projectId: string | null;
  dealId: string | null;
  activityCode: string | null;
}

/** Same key as the DB's generated `time_allocations.target_key`. */
export const targetKey = (t: Pick<TargetRef, "taskId" | "projectId" | "dealId" | "activityCode">): string =>
  t.taskId ?? t.projectId ?? t.dealId ?? `code:${t.activityCode}`;

export const SLOT = 15;

/** Round to the nearest 15 minutes (half up). */
export const round15 = (minutes: number): number => Math.round(Math.max(0, minutes) / SLOT) * SLOT;

/**
 * Split `total` minutes (a multiple of 15) across weights in 15-minute slots, largest remainder first;
 * ties go to the larger weight, then the earlier one. The parts always add up to `total`.
 */
export function splitMinutes(total: number, weights: readonly number[]): number[] {
  const slots = Math.floor(total / SLOT);
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (!weights.length || sum <= 0 || slots <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (Math.max(0, w) * slots) / sum);
  const floors = exact.map(Math.floor);
  let left = slots - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, r: e - Math.floor(e), w: weights[i]! }))
    .sort((a, b) => b.r - a.r || b.w - a.w || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    floors[o.i]!++;
    left--;
  }
  return floors.map((f) => f * SLOT);
}

export interface DraftRow extends TargetRef {
  date: string;
  minutes: number;
  source: "prefill" | "manual" | "telegram" | "mcp";
}

/** Hash of a draft: what a Telegram Confirm button is bound to (stale-draft protection, TIM-TS-09). */
export function draftHash(weekStart: string, rows: readonly Pick<DraftRow, "date" | "minutes" | keyof TargetRef>[]): string {
  const canon = rows
    .map((r) => `${r.date}|${r.targetType}|${targetKey(r)}|${r.minutes}`)
    .sort()
    .join(";");
  return sha256(`${weekStart}#${canon}`).slice(0, 32);
}
