// Time-based jobs (S3): bypass sweep (hourly), retainer periods (daily), monthly bypass review (first working day).
// Each job is idempotent, so a restart or a second worker running the same tick is harmless.
import { randomUUID } from "node:crypto";
import { businessDate, commercial, execute, projects, type JobActor, type Kernel, type OpDef } from "@demoq/core";

const PROJECT_JOB: JobActor = { type: "job", name: "job:projects", grants: ["project.jobs"] };

/** First Monday–Friday of the month of a YYYY-MM-DD date (public holidays are not modelled yet). */
export function firstWorkingDay(date: string): string {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface ScheduleState {
  lastSweep: number;
  lastRetainerDay: string | null;
  /** Month (YYYY-MM-01) whose review was created; retried every tick until it succeeds. */
  lastReviewMonth: string | null;
}
export const newScheduleState = (): ScheduleState => ({ lastSweep: 0, lastRetainerDay: null, lastReviewMonth: null });

const runJob = (kernel: Kernel, op: OpDef, input: unknown) =>
  execute(kernel, { actor: PROJECT_JOB, channel: "job", requestId: `job_${randomUUID()}`, locale: "en" }, op, input);

export async function runSchedule(
  kernel: Kernel,
  state: ScheduleState,
  opts: { reviewRequesterId?: string; log?: (msg: string, extra?: Record<string, unknown>) => void } = {},
) {
  const now = kernel.clock();
  const today = businessDate(now);
  if (now.getTime() - state.lastSweep >= 3_600_000) {
    state.lastSweep = now.getTime();
    const r = await runJob(kernel, projects.bypassSweep, {});
    opts.log?.("bypass_sweep", r as Record<string, unknown>);
  }
  if (state.lastRetainerDay !== today) {
    state.lastRetainerDay = today;
    const r = await runJob(kernel, commercial.retainerTick, {});
    opts.log?.("retainer_tick", r as Record<string, unknown>);
  }
  // From the first working day on (a missed day or a failure is caught up later); the job itself is idempotent.
  const month = `${today.slice(0, 7)}-01`;
  if (opts.reviewRequesterId && state.lastReviewMonth !== month && today >= firstWorkingDay(today)) {
    const r = await runJob(kernel, projects.bypassMonthlyReview, { requesterId: opts.reviewRequesterId });
    state.lastReviewMonth = month;
    opts.log?.("bypass_monthly_review", r as Record<string, unknown>);
  }
}
