// Time-based jobs (S3): bypass sweep (hourly), retainer periods (daily), monthly bypass review (first working day).
// S4: influencer link expiry (hourly; logged only when it expired something); time jobs every 5 minutes (attendance
// auto-close, timesheet reminder, overdue escalation).
// Each job is idempotent, so a restart or a second worker running the same tick is harmless.
import { randomUUID } from "node:crypto";
import {
  businessDate,
  commercial,
  execute,
  influencers,
  projects,
  time,
  type JobActor,
  type Kernel,
  type OpDef,
} from "@demoq/core";

const PROJECT_JOB: JobActor = { type: "job", name: "job:projects", grants: ["project.jobs"] };
const INFLUENCER_JOB: JobActor = { type: "job", name: "job:influencers", grants: ["influencer.jobs"] };
const TIME_JOB: JobActor = { type: "job", name: "job:time", grants: ["time.jobs"] };
export const TIME_JOBS_EVERY_MS = 5 * 60_000;

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
  /** INF-LK-05: last hourly influencer link expiry run. */
  lastLinkExpiry?: number;
  /** Last run of the S4 time jobs (attendance.autoclose, timesheet.remind, timesheet.due_escalate). */
  lastTimeJobs?: number;
}
export const newScheduleState = (): ScheduleState => ({
  lastSweep: 0,
  lastRetainerDay: null,
  lastReviewMonth: null,
  lastLinkExpiry: 0,
  lastTimeJobs: 0,
});

const runJob = (kernel: Kernel, op: OpDef, input: unknown, actor: JobActor = PROJECT_JOB) =>
  execute(kernel, { actor, channel: "job", requestId: `job_${randomUUID()}`, locale: "en" }, op, input);

export async function runSchedule(
  kernel: Kernel,
  state: ScheduleState,
  opts: {
    reviewRequesterId?: string;
    log?: (msg: string, extra?: Record<string, unknown>) => void;
    /** What the S4 time jobs did on a tick where any of them did something. */
    onTimeJobs?: (r: { autoclosed: number; reminded: number; escalated: number }) => void;
  } = {},
) {
  const now = kernel.clock();
  const today = businessDate(now);
  if (now.getTime() - state.lastSweep >= 3_600_000) {
    state.lastSweep = now.getTime();
    const r = await runJob(kernel, projects.bypassSweep, {});
    opts.log?.("bypass_sweep", r as Record<string, unknown>);
  }
  if (now.getTime() - (state.lastLinkExpiry ?? 0) >= 3_600_000) {
    state.lastLinkExpiry = now.getTime();
    const r = (await runJob(kernel, influencers.linkExpireDue, {}, INFLUENCER_JOB)) as { expired: number };
    if (r.expired) opts.log?.("influencer_link_expiry", r);
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
  // TIM-AT-05 / TIM-TS-11 / TIM-TS-12: each job decides for itself whether it is due (23:59 or 12 h; 14:00 on the
  // last working day; 12:00 on the first working day) and records what it did, so a frequent tick is safe.
  if (now.getTime() - (state.lastTimeJobs ?? 0) >= TIME_JOBS_EVERY_MS) {
    state.lastTimeJobs = now.getTime();
    const closed = (await runJob(kernel, time.attendanceAutoclose, {}, TIME_JOB)) as { closed: number };
    const reminded = (await runJob(kernel, time.timesheetRemind, {}, TIME_JOB)) as { reminded: number };
    const escalated = (await runJob(kernel, time.timesheetDueEscalate, {}, TIME_JOB)) as { escalated: number };
    const r = { autoclosed: closed.closed, reminded: reminded.reminded, escalated: escalated.escalated };
    if (r.autoclosed || r.reminded || r.escalated) opts.onTimeJobs?.(r);
  }
}
