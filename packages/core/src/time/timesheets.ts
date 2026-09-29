// Timesheet week: pre-filled draft, one-tap confirm, lock, reopen, team view, reminder and escalation jobs.
// INV-12, D-TM-2, D-TM-3, D15. Spec: specs/time/timesheets.md (TIM-TS-*)
import type { Kysely } from "kysely";
import { z } from "zod";
import type { DB } from "@demoq/db";
import { isoDate, optionalText, requiredText, uuid } from "@demoq/shared";
import {
  addDays,
  businessDate,
  defineCommand,
  defineQuery,
  DomainError,
  notFoundIfMissing,
  rowFilter,
  type Ctx,
} from "../kernel";
import { assertWorkAllowed } from "../projects";
import {
  canViewDeal,
  channelSource,
  DAY_LIMIT_MINUTES,
  inputKey,
  resolveTarget,
  TargetInput,
  WITHHELD_LABEL,
  type ResolvedTarget,
} from "./allocations";
import { lockWeek, minutesByDate, ownScope, selfId, sessionsBetween } from "./attendance";
import { loadCalendarUser, weekStartOf, workingCalendar, type CalendarDay } from "./calendar";
import { draftHash, round15, splitMinutes, targetKey, type DraftRow, type TargetRef, type TargetType } from "./prefill";

const WeekInput = z.object({
  /** Monday of the week; defaults to this week. */
  weekStart: isoDate.optional(),
});

function resolveWeekStart(ctx: Ctx, weekStart: string | undefined): string {
  const current = weekStartOf(businessDate(ctx.now));
  const ws = weekStart ?? current;
  if (weekStartOf(ws) !== ws) throw new DomainError("VALIDATION", { issues: [{ path: "weekStart", message: "A Monday" }] });
  if (ws > current) throw new DomainError("VALIDATION", { issues: [{ path: "weekStart", message: "Not a future week" }] });
  return ws;
}

async function workAllowed(ctx: Ctx, projectId: string): Promise<boolean> {
  try {
    await assertWorkAllowed(ctx, projectId);
    return true;
  } catch (e) {
    if (e instanceof DomainError) return false;
    throw e;
  }
}

type Basis = { kind: "last_week" | "open_tasks" | "admin" | "none"; targets: { ref: TargetRef; weight: number }[] };

const refOf = (r: {
  target_type: string;
  task_id: string | null;
  project_id: string | null;
  deal_id: string | null;
  activity_code: string | null;
}): TargetRef => ({
  targetType: r.target_type as TargetType,
  taskId: r.task_id,
  projectId: r.project_id,
  dealId: r.deal_id,
  activityCode: r.activity_code,
});

/** Is this target still a sensible place for new time? (Used to filter last week's pattern.) */
async function stillAllocatable(ctx: Ctx, t: TargetRef): Promise<boolean> {
  if (t.targetType === "internal") {
    const c = await ctx.tx.selectFrom("activity_codes").select("active").where("code", "=", t.activityCode!).executeTakeFirst();
    return !!c?.active;
  }
  if (t.targetType === "deal") {
    const d = await ctx.tx.selectFrom("deals").select(["stage", "owner_id"]).where("id", "=", t.dealId!).executeTakeFirst();
    return !!d && d.stage !== "won" && d.stage !== "lost" && canViewDeal(ctx, d.owner_id); // TIM-TS-13
  }
  if (t.targetType === "task") {
    const k = await ctx.tx.selectFrom("tasks").select("status").where("id", "=", t.taskId!).executeTakeFirst();
    if (!k || k.status === "done" || k.status === "cancelled") return false;
  }
  return workAllowed(ctx, t.projectId!);
}

/**
 * TIM-TS-04 (D-TM-2): last week's confirmed targets in the same proportions, else my open tasks evenly, else `admin`.
 */
async function prefillBasis(ctx: Ctx, userId: string, weekStart: string): Promise<Basis> {
  const prev = await ctx.tx
    .selectFrom("time_allocations")
    .select(["target_type", "task_id", "project_id", "deal_id", "activity_code", "minutes"])
    .where("user_id", "=", userId)
    .where("status", "=", "confirmed")
    .where("work_date", ">=", addDays(weekStart, -7))
    .where("work_date", "<", weekStart)
    .orderBy("work_date")
    .orderBy("target_key")
    .execute();
  const agg = new Map<string, { ref: TargetRef; weight: number }>();
  for (const r of prev) {
    const ref = refOf(r);
    const k = `${ref.targetType}|${targetKey(ref)}`;
    const cur = agg.get(k) ?? { ref, weight: 0 };
    cur.weight += r.minutes;
    agg.set(k, cur);
  }
  const last: Basis["targets"] = [];
  for (const t of agg.values()) if (await stillAllocatable(ctx, t.ref)) last.push(t);
  if (last.length) return { kind: "last_week", targets: last };
  // "Open" = started and not finished (todo tasks have no work yet).
  const tasks = await ctx.tx
    .selectFrom("tasks")
    .select(["id", "project_id"])
    .where("owner_id", "=", userId)
    .where("status", "not in", ["todo", "done", "cancelled"])
    .orderBy("started_at")
    .orderBy("id")
    .execute();
  const open: Basis["targets"] = [];
  for (const k of tasks) {
    if (await workAllowed(ctx, k.project_id))
      open.push({
        ref: { targetType: "task", taskId: k.id, projectId: k.project_id, dealId: null, activityCode: null },
        weight: 1,
      });
  }
  if (open.length) return { kind: "open_tasks", targets: open };
  const admin = await ctx.tx.selectFrom("activity_codes").select("active").where("code", "=", "admin").executeTakeFirst();
  if (admin?.active)
    return {
      kind: "admin",
      targets: [
        { ref: { targetType: "internal", taskId: null, projectId: null, dealId: null, activityCode: "admin" }, weight: 1 },
      ],
    };
  return { kind: "none", targets: [] };
}

export interface WeekRow extends DraftRow {
  key: string;
  status: "draft" | "confirmed" | "proposed";
}

async function labelsFor(ctx: Ctx, rows: readonly TargetRef[]) {
  const ids = (f: (r: TargetRef) => string | null) => [...new Set(rows.map(f).filter((x): x is string => !!x))];
  const taskIds = ids((r) => r.taskId);
  const projectIds = ids((r) => r.projectId);
  const dealIds = ids((r) => r.dealId);
  const codes = ids((r) => r.activityCode);
  const tasks = taskIds.length
    ? await ctx.tx.selectFrom("tasks").select(["id", "title", "status"]).where("id", "in", taskIds).execute()
    : [];
  const projects = projectIds.length
    ? await ctx.tx.selectFrom("projects").select(["id", "name", "kind"]).where("id", "in", projectIds).execute()
    : [];
  const deals = dealIds.length
    ? await ctx.tx.selectFrom("deals").select(["id", "title", "owner_id"]).where("id", "in", dealIds).execute()
    : [];
  const acts = codes.length
    ? await ctx.tx.selectFrom("activity_codes").select(["code", "label_en", "label_km"]).where("code", "in", codes).execute()
    : [];
  const t = new Map(tasks.map((x) => [x.id, x]));
  const p = new Map(projects.map((x) => [x.id, x]));
  // TIM-TS-13: the title of a deal I may not see is withheld (time stored before I lost access still shows).
  const d = new Map(deals.map((x) => [x.id, canViewDeal(ctx, x.owner_id) ? x.title : WITHHELD_LABEL]));
  const a = new Map(acts.map((x) => [x.code, x]));
  return (r: TargetRef) => {
    const project = r.projectId ? p.get(r.projectId) : undefined;
    const label =
      r.targetType === "task"
        ? (t.get(r.taskId!)?.title ?? "—")
        : r.targetType === "project"
          ? (project?.name ?? "—")
          : r.targetType === "deal"
            ? (d.get(r.dealId!) ?? "—")
            : (a.get(r.activityCode!)?.label_en ?? r.activityCode!);
    return {
      label,
      labelKm: r.targetType === "internal" ? (a.get(r.activityCode!)?.label_km ?? null) : null,
      projectName: project?.name ?? null,
      projectKind: project?.kind ?? null,
    };
  };
}

/**
 * The week view (TIM-TS-04/05): days × targets with attendance, holidays and leave per day, the stored rows and — for an
 * open week — the pre-filled rows for each working day's remaining minutes. Deterministic, so its hash binds a confirm.
 */
export async function buildWeek(ctx: Ctx, userId: string, weekStart: string) {
  const u = notFoundIfMissing(await loadCalendarUser(ctx.tx, userId));
  const weekEnd = addDays(weekStart, 6);
  const days = await workingCalendar(ctx.tx, u, weekStart, weekEnd);
  const week = await ctx.tx
    .selectFrom("timesheet_weeks")
    .selectAll()
    .where("user_id", "=", userId)
    .where("week_start", "=", weekStart)
    .executeTakeFirst();
  const sessions = await sessionsBetween(ctx, userId, weekStart, weekEnd);
  const attended = minutesByDate(sessions, ctx.now);
  // TIM-TS-04: the pre-fill counts closed sessions only. A running session grows every minute, which would change the
  // draft (and its hash) while I am clocked in and make a Confirm button stale before I press it (TIM-TS-09).
  const closedAttended = minutesByDate(
    sessions.filter((s) => s.ended_at),
    ctx.now,
  );
  const stored = await ctx.tx
    .selectFrom("time_allocations")
    .select([
      "id",
      "work_date",
      "minutes",
      "target_type",
      "task_id",
      "project_id",
      "deal_id",
      "activity_code",
      "source",
      "status",
    ])
    .where("user_id", "=", userId)
    .where("work_date", ">=", weekStart)
    .where("work_date", "<=", weekEnd)
    .orderBy("work_date")
    .orderBy("target_key")
    .execute();
  const rows: WeekRow[] = stored.map((s) => {
    const ref = refOf(s);
    return {
      ...ref,
      key: targetKey(ref),
      date: s.work_date,
      minutes: s.minutes,
      source: s.source as DraftRow["source"],
      status: s.status as WeekRow["status"],
    };
  });
  const confirmed = week?.status === "confirmed";
  let basis: Basis = { kind: "none", targets: [] };
  const dayBase = (d: CalendarDay) => {
    const a = closedAttended.get(d.date) ?? 0;
    return d.workingDay ? round15(a > 0 ? a : d.capacityMinutes) : 0;
  };
  if (!confirmed) {
    basis = await prefillBasis(ctx, userId, weekStart);
    for (const d of days) {
      if (!d.workingDay) continue; // TIM-TS-04: holidays, full-day leave and non-working days are skipped
      const already = rows.filter((r) => r.date === d.date);
      const remaining = round15(dayBase(d) - already.reduce((s, r) => s + r.minutes, 0));
      if (remaining <= 0) continue;
      const taken = new Set(already.map((r) => `${r.targetType}|${r.key}`));
      let targets = basis.targets.filter((t) => !taken.has(`${t.ref.targetType}|${targetKey(t.ref)}`));
      if (!targets.length && !taken.has("internal|code:admin") && basis.kind !== "none")
        targets = [
          { ref: { targetType: "internal", taskId: null, projectId: null, dealId: null, activityCode: "admin" }, weight: 1 },
        ];
      const parts = splitMinutes(
        remaining,
        targets.map((t) => t.weight),
      );
      targets.forEach((t, idx) => {
        if (parts[idx]! > 0)
          rows.push({
            ...t.ref,
            key: targetKey(t.ref),
            date: d.date,
            minutes: parts[idx]!,
            source: "prefill",
            status: "proposed",
          });
      });
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.targetType.localeCompare(b.targetType) || a.key.localeCompare(b.key));
  const label = await labelsFor(ctx, rows);
  const targetMap = new Map<
    string,
    ReturnType<typeof label> & TargetRef & { key: string; minutesByDate: Record<string, number>; totalMinutes: number }
  >();
  for (const r of rows) {
    const k = `${r.targetType}|${r.key}`;
    const t = targetMap.get(k) ?? {
      targetType: r.targetType,
      taskId: r.taskId,
      projectId: r.projectId,
      dealId: r.dealId,
      activityCode: r.activityCode,
      key: r.key,
      ...label(r),
      minutesByDate: {},
      totalMinutes: 0,
    };
    t.minutesByDate[r.date] = (t.minutesByDate[r.date] ?? 0) + r.minutes;
    t.totalMinutes += r.minutes;
    targetMap.set(k, t);
  }
  const total = (f: (r: WeekRow) => boolean) => rows.filter(f).reduce((s, r) => s + r.minutes, 0);
  return {
    userId,
    weekStart,
    weekEnd,
    status: (week?.status ?? "open") as "open" | "confirmed",
    version: week?.version ?? 0,
    openedAt: week?.opened_at ?? null,
    confirmedAt: week?.confirmed_at ?? null,
    reopenedAt: week?.reopened_at ?? null,
    reopenReason: week?.reopen_reason ?? null,
    prefillBasis: basis.kind,
    days: days.map((d) => ({
      ...d,
      attendedMinutes: attended.get(d.date) ?? 0,
      baseMinutes: confirmed ? null : dayBase(d),
      allocatedMinutes: total((r) => r.date === d.date),
      flaggedSessions: sessions.filter((s) => s.flagged && businessDate(s.started_at) === d.date).length,
      runningSession: sessions.some((s) => !s.ended_at && businessDate(s.started_at) === d.date),
    })),
    targets: [...targetMap.values()],
    rows: rows.map((r) => ({
      date: r.date,
      targetType: r.targetType,
      targetId: r.taskId ?? r.projectId ?? r.dealId,
      taskId: r.taskId,
      projectId: r.projectId,
      dealId: r.dealId,
      activityCode: r.activityCode,
      key: r.key,
      minutes: r.minutes,
      source: r.source,
      status: r.status,
    })),
    totals: {
      attendedMinutes: [...attended.values()].reduce((a, b) => a + b, 0),
      allocatedMinutes: total(() => true),
      prefillMinutes: total((r) => r.source === "prefill"),
      flaggedSessions: sessions.filter((s) => s.flagged).length,
    },
    draftHash: draftHash(weekStart, rows),
  };
}
export type WeekView = Awaited<ReturnType<typeof buildWeek>>;

/** TIM-TS-05: my week with its pre-filled draft (read-only). */
export const timesheetWeek = defineQuery({
  name: "timesheet.week",
  summary: "My timesheet week: days, attendance, holidays and leave, and the pre-filled draft to confirm",
  permission: "time.allocate_own",
  input: WeekInput,
  exposeTo: ["web", "telegram", "mcp"],
  scope: ownScope,
  async run(ctx, i) {
    return buildWeek(ctx, selfId(ctx), resolveWeekStart(ctx, i.weekStart));
  },
});

/** TIM-TS-10: opening the week records when I first saw the draft (for the confirmation-time metric, M2 #10). */
export const timesheetOpen = defineCommand({
  name: "timesheet.open",
  summary: "Open my timesheet week (records when I first saw the pre-filled draft)",
  permission: "time.allocate_own",
  input: WeekInput,
  exposeTo: ["web", "telegram"],
  scope: ownScope,
  async run(ctx, i) {
    const me = selfId(ctx);
    const ws = resolveWeekStart(ctx, i.weekStart);
    const w = await lockWeek(ctx, me, ws);
    if (!w.opened_at && w.status === "open") {
      await ctx.tx
        .updateTable("timesheet_weeks")
        .set((eb) => ({ opened_at: ctx.now, version: eb("version", "+", 1) }))
        .where("id", "=", w.id)
        .execute();
    }
    return { ...(await buildWeek(ctx, me, ws)), id: w.id };
  },
  subject: (_i, r) => ({ type: "timesheet_week", id: r.id }),
});

const ConfirmRow = TargetInput.extend({
  date: isoDate,
  minutes: z.number().int().min(1).max(DAY_LIMIT_MINUTES),
  note: optionalText(500),
});

/**
 * TIM-TS-05/06: confirm the week — as pre-filled (one tap) or with edits. Rows the user left untouched keep their
 * source (`prefill`), edited or added rows are `manual`/`telegram`. Confirming locks allocations and sessions.
 */
export const timesheetConfirm = defineCommand({
  name: "timesheet.confirm",
  summary: "Confirm my week's time, as pre-filled or with my edits (locks the week)",
  permission: "time.allocate_own",
  input: WeekInput.extend({
    /** The draft the user saw; a different current draft is refused (STALE_VERSION). */
    draftHash: z.string().max(64).optional(),
    /** The full week as the user wants it; omit to accept the draft as-is. */
    rows: z.array(ConfirmRow).max(500).optional(),
  }),
  exposeTo: ["web", "telegram"],
  scope: ownScope,
  async run(ctx, i) {
    const me = selfId(ctx);
    const ws = resolveWeekStart(ctx, i.weekStart);
    const week = await lockWeek(ctx, me, ws);
    if (week.status === "confirmed") throw new DomainError("TIMESHEET_CONFIRMED", { weekStart: ws });
    const view = await buildWeek(ctx, me, ws);
    if (i.draftHash && i.draftHash !== view.draftHash)
      throw new DomainError("STALE_VERSION", { reason: "draft_changed", draftHash: view.draftHash });
    const draftByKey = new Map(view.rows.map((r) => [`${r.date}|${r.targetType}|${r.key}`, r]));
    const stored = await ctx.tx
      .selectFrom("time_allocations")
      .select(["id", "work_date", "target_type", "target_key", "minutes"])
      .where("user_id", "=", me)
      .where("work_date", ">=", ws)
      .where("work_date", "<=", view.weekEnd)
      .execute();
    const storedByKey = new Map(stored.map((r) => [`${r.work_date}|${r.target_type}|${r.target_key}`, r]));
    const cache = new Map<string, ResolvedTarget>();
    // TIM-TS-14: only new or increased time is checked (workable project, open task, active code, visible deal); a
    // row equal to or lower than what is already stored is kept even if its target has since closed.
    const resolve = async (t: z.output<typeof TargetInput>, newTime: boolean) => {
      const k = `${t.targetType}|${t.targetId ?? ""}|${t.activityCode ?? ""}|${newTime}`;
      if (!cache.has(k)) cache.set(k, await resolveTarget(ctx, t, { newTime }));
      return cache.get(k)!;
    };
    const final: (DraftRow & { note: string | null; storedId: string | null; storedMinutes: number })[] = [];
    const seen = new Set<string>();
    const input =
      i.rows ??
      view.rows.map((r) => ({
        date: r.date,
        targetType: r.targetType,
        targetId: r.targetType === "internal" ? null : r.targetType === "task" ? r.taskId : (r.projectId ?? r.dealId),
        activityCode: r.activityCode,
        minutes: r.minutes,
        note: null,
      }));
    for (const r of input) {
      if (r.date < ws || r.date > view.weekEnd)
        throw new DomainError("VALIDATION", { issues: [{ path: "rows.date", message: "Inside the week" }] });
      if (r.date > businessDate(ctx.now))
        throw new DomainError("VALIDATION", { issues: [{ path: "rows.date", message: "Not in the future" }] });
      const was = storedByKey.get(`${r.date}|${r.targetType}|${inputKey(r)}`);
      const t = await resolve(r, r.minutes > (was?.minutes ?? 0));
      const k = `${r.date}|${t.targetType}|${targetKey(t)}`;
      if (seen.has(k)) throw new DomainError("VALIDATION", { reason: "duplicate_row", date: r.date, target: targetKey(t) });
      seen.add(k);
      const drafted = draftByKey.get(k);
      const source = drafted && drafted.minutes === r.minutes ? drafted.source : channelSource(ctx);
      final.push({
        ...t,
        date: r.date,
        minutes: r.minutes,
        source,
        note: r.note ?? null,
        storedId: was?.id ?? null,
        storedMinutes: was?.minutes ?? 0,
      });
    }
    const perDay = new Map<string, number>();
    for (const r of final) perDay.set(r.date, (perDay.get(r.date) ?? 0) + r.minutes);
    for (const [date, m] of perDay)
      if (m > DAY_LIMIT_MINUTES) throw new DomainError("VALIDATION", { reason: "day_over_24h", date, limit: DAY_LIMIT_MINUTES });
    // Rows left out are removed; stored rows are updated in place (so time kept as it was is not re-inserted and
    // re-checked by the gate trigger), lowered ones first so a day never passes 24 h on the way; new rows are added.
    const keep = new Set(final.map((r) => r.storedId).filter(Boolean));
    const removed = stored.filter((r) => !keep.has(r.id)).map((r) => r.id);
    if (removed.length) await ctx.tx.deleteFrom("time_allocations").where("id", "in", removed).execute();
    const updates = final.filter((r) => r.storedId).sort((a, b) => a.minutes - a.storedMinutes - (b.minutes - b.storedMinutes));
    for (const r of updates) {
      await ctx.tx
        .updateTable("time_allocations")
        .set((eb) => ({
          minutes: r.minutes,
          source: r.source,
          status: "confirmed",
          note: r.note,
          version: eb("version", "+", 1),
        }))
        .where("id", "=", r.storedId!)
        .execute();
    }
    const added = final.filter((r) => !r.storedId);
    if (added.length) {
      await ctx.tx
        .insertInto("time_allocations")
        .values(
          added.map((r) => ({
            user_id: me,
            work_date: r.date,
            minutes: r.minutes,
            target_type: r.targetType,
            task_id: r.taskId,
            project_id: r.projectId,
            deal_id: r.dealId,
            activity_code: r.activityCode,
            source: r.source,
            status: "confirmed",
            note: r.note,
          })),
        )
        .execute();
    }
    const confirmedMinutes = final.reduce((s, r) => s + r.minutes, 0);
    const keptPrefill = final.filter((r) => r.source === "prefill").reduce((s, r) => s + r.minutes, 0);
    const w = await ctx.tx
      .updateTable("timesheet_weeks")
      .set((eb) => ({
        status: "confirmed",
        confirmed_at: ctx.now,
        first_confirmed_at: eb.fn.coalesce("first_confirmed_at", eb.val(ctx.now)),
        confirmed_channel: ctx.channel === "job" || ctx.channel === "link" ? null : ctx.channel,
        draft_hash: view.draftHash,
        prefill_minutes: view.totals.prefillMinutes,
        version: eb("version", "+", 1),
      }))
      .where("id", "=", week.id)
      .returning(["id", "status", "confirmed_at", "version"])
      .executeTakeFirstOrThrow();
    ctx.emit("timesheet.confirmed", { userId: me, weekStart: ws, minutes: confirmedMinutes });
    return {
      id: w.id,
      weekStart: ws,
      status: w.status,
      confirmedAt: w.confirmed_at,
      version: w.version,
      confirmedMinutes,
      prefillKeptMinutes: keptPrefill,
    };
  },
  subject: (_i, r) => ({ type: "timesheet_week", id: r.id }),
});

/** TIM-TS-07: a team lead (for their team) or ops_lead reopens a confirmed week with a reason. */
export const timesheetReopen = defineCommand({
  name: "timesheet.reopen",
  summary: "Reopen someone's confirmed week so they can correct it (needs a reason)",
  permission: "time.reopen",
  input: z.object({ userId: uuid, weekStart: isoDate, reason: requiredText(500) }),
  exposeTo: ["web"],
  async load(ctx, i) {
    const w = notFoundIfMissing(
      await ctx.tx
        .selectFrom("timesheet_weeks")
        .selectAll()
        .where("user_id", "=", i.userId)
        .where("week_start", "=", i.weekStart)
        .forUpdate()
        .executeTakeFirst(),
    );
    const u = await ctx.tx.selectFrom("users").select("team_id").where("id", "=", i.userId).executeTakeFirst();
    return { w, teamId: u?.team_id ?? null };
  },
  scope: (l) => ({ teamIds: [l.teamId] }),
  async run(ctx, i, { w }) {
    const me = selfId(ctx);
    if (me === w.user_id) throw new DomainError("FORBIDDEN", { reason: "own_week" });
    if (i.reason.length < 3)
      throw new DomainError("VALIDATION", { issues: [{ path: "reason", message: "At least 3 characters" }] });
    if (w.status !== "confirmed") throw new DomainError("INVALID_TRANSITION", { from: w.status, to: "open" });
    const r = await ctx.tx
      .updateTable("timesheet_weeks")
      .set((eb) => ({
        status: "open",
        confirmed_at: null,
        reopened_at: ctx.now,
        reopened_by: me,
        reopen_reason: i.reason,
        reopen_count: eb("reopen_count", "+", 1),
        version: eb("version", "+", 1),
      }))
      .where("id", "=", w.id)
      .returning(["id", "status", "version"])
      .executeTakeFirstOrThrow();
    await ctx.tx
      .updateTable("time_allocations")
      .set((eb) => ({ status: "draft", version: eb("version", "+", 1) }))
      .where("user_id", "=", w.user_id)
      .where("work_date", ">=", w.week_start)
      .where("work_date", "<=", addDays(w.week_start, 6))
      .execute();
    ctx.emit("timesheet.reopened", { userId: w.user_id, weekStart: w.week_start, by: me, reason: i.reason });
    return { id: r.id, userId: w.user_id, weekStart: w.week_start, status: r.status, version: r.version };
  },
  subject: (_i, r) => ({ type: "timesheet_week", id: r.id }),
});

/** Median of a list (M2 #10). */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * TIM-TS-10: the pilot metrics for a week — share of confirmed minutes that came from the pre-fill unchanged (M2 #9)
 * and the median seconds from first opening the week to first confirming it (M2 #10).
 */
export async function weekMetrics(db: Kysely<DB>, weekStart: string, userIds: readonly string[]) {
  if (!userIds.length) return { confirmedMinutes: 0, prefillKeptMinutes: 0, prefillKeptRatio: null, medianConfirmSeconds: null };
  const a = await db
    .selectFrom("time_allocations")
    .select(["source", "minutes"])
    .where("user_id", "in", userIds)
    .where("status", "=", "confirmed")
    .where("work_date", ">=", weekStart)
    .where("work_date", "<=", addDays(weekStart, 6))
    .execute();
  const confirmedMinutes = a.reduce((s, r) => s + r.minutes, 0);
  const prefillKeptMinutes = a.filter((r) => r.source === "prefill").reduce((s, r) => s + r.minutes, 0);
  const weeks = await db
    .selectFrom("timesheet_weeks")
    .select(["opened_at", "first_confirmed_at"])
    .where("user_id", "in", userIds)
    .where("week_start", "=", weekStart)
    .execute();
  const secs = weeks
    .filter((w) => w.opened_at && w.first_confirmed_at)
    .map((w) => (w.first_confirmed_at!.getTime() - w.opened_at!.getTime()) / 1000);
  return {
    confirmedMinutes,
    prefillKeptMinutes,
    prefillKeptRatio: confirmedMinutes ? prefillKeptMinutes / confirmedMinutes : null,
    medianConfirmSeconds: median(secs),
  };
}

/** Active people who keep time (anyone with a role other than viewer). */
async function timeKeepers(ctx: Ctx, teamId?: string | null) {
  return ctx.tx
    .selectFrom("users as u")
    .select(["u.id", "u.display_name", "u.team_id", "u.manager_id", "u.working_days", "u.weekly_capacity_minutes"])
    .where("u.active", "=", true)
    .where((eb) =>
      eb.exists(
        eb.selectFrom("user_roles as r").select("r.user_id").whereRef("r.user_id", "=", "u.id").where("r.role", "<>", "viewer"),
      ),
    )
    .$if(teamId !== undefined, (q) => q.where("u.team_id", "=", teamId!))
    .orderBy("u.display_name")
    .execute();
}

/** TIM-TS-08: who in my team (or everyone, for ops_lead/director) has confirmed a week. */
export const timesheetTeam = defineQuery({
  name: "timesheet.team",
  summary: "Team timesheet status for a week: who has confirmed, attendance and allocated totals",
  permission: "time.view_team",
  input: WeekInput.extend({ teamId: uuid.optional() }),
  exposeTo: ["web", "mcp"],
  rowFiltered: true,
  async run(ctx, i) {
    const ws = resolveWeekStart(ctx, i.weekStart);
    const f = rowFilter(ctx.actor, "time.view_team");
    const none = async () => ({ weekStart: ws, confirmedCount: 0, people: [], metrics: await weekMetrics(ctx.tx, ws, []) });
    if (!f) return none();
    let teamId: string | null | undefined = i.teamId;
    if (f.kind === "scoped") {
      if (!f.teamId || (i.teamId && i.teamId !== f.teamId)) return none();
      teamId = f.teamId;
    }
    const people = await timeKeepers(ctx, teamId);
    const ids = people.map((p) => p.id);
    const weeks = ids.length
      ? await ctx.tx.selectFrom("timesheet_weeks").selectAll().where("user_id", "in", ids).where("week_start", "=", ws).execute()
      : [];
    const byUser = new Map(weeks.map((w) => [w.user_id, w]));
    const out = [];
    for (const p of people) {
      const w = byUser.get(p.id);
      const sessions = await sessionsBetween(ctx, p.id, ws, addDays(ws, 6));
      const alloc = await ctx.tx
        .selectFrom("time_allocations")
        .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("minutes"), eb.lit(0)).as("m"))
        .where("user_id", "=", p.id)
        .where("work_date", ">=", ws)
        .where("work_date", "<=", addDays(ws, 6))
        .executeTakeFirstOrThrow();
      out.push({
        userId: p.id,
        name: p.display_name,
        teamId: p.team_id,
        status: (w?.status ?? "open") as "open" | "confirmed",
        openedAt: w?.opened_at ?? null,
        confirmedAt: w?.confirmed_at ?? null,
        remindedAt: w?.reminded_at ?? null,
        escalatedAt: w?.escalated_at ?? null,
        reopenCount: w?.reopen_count ?? 0,
        attendedMinutes: [...minutesByDate(sessions, ctx.now).values()].reduce((a, b) => a + b, 0),
        allocatedMinutes: Number(alloc.m),
        flaggedSessions: sessions.filter((s) => s.flagged).length,
      });
    }
    return {
      weekStart: ws,
      confirmedCount: out.filter((x) => x.status === "confirmed").length,
      people: out,
      metrics: await weekMetrics(ctx.tx, ws, ids),
    };
  },
});

const minutesOfDay = (at: Date) => {
  const local = new Date(at.getTime() + 7 * 3600_000);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
};

/** TIM-TS-11: 14:00 on each person's last working day of the week, a pre-filled summary with one-tap Confirm. */
export const timesheetRemind = defineCommand({
  name: "timesheet.remind",
  summary: "Remind people to confirm their week on their last working day (14:00)",
  permission: "time.jobs",
  input: z.object({}).default({}),
  exposeTo: ["job"],
  async run(ctx) {
    const today = businessDate(ctx.now);
    const ws = weekStartOf(today);
    let reminded = 0;
    for (const p of await timeKeepers(ctx)) {
      const cal = await workingCalendar(ctx.tx, { ...p }, ws, addDays(ws, 6));
      const last = cal.filter((d) => d.workingDay).at(-1)?.date;
      if (!last || today < last || (today === last && minutesOfDay(ctx.now) < 14 * 60)) continue;
      const r = await ctx.tx
        .insertInto("timesheet_weeks")
        .values({ user_id: p.id, week_start: ws, reminded_at: ctx.now })
        .onConflict((oc) =>
          oc
            .columns(["user_id", "week_start"])
            .doUpdateSet({ reminded_at: ctx.now })
            .where("timesheet_weeks.reminded_at", "is", null)
            .where("timesheet_weeks.status", "=", "open"),
        )
        .returning("id")
        .executeTakeFirst();
      if (!r) continue;
      ctx.emit("timesheet.reminder", { userId: p.id, weekStart: ws });
      reminded++;
    }
    return { weekStart: ws, reminded };
  },
});

/** TIM-TS-12: 12:00 on the first working day of the next week, unconfirmed weeks go to the team lead. */
export const timesheetDueEscalate = defineCommand({
  name: "timesheet.due_escalate",
  summary: "Tell team leads whose people have not confirmed last week (12:00, first working day)",
  permission: "time.jobs",
  input: z.object({}).default({}),
  exposeTo: ["job"],
  async run(ctx) {
    const today = businessDate(ctx.now);
    const ws = weekStartOf(today);
    const prev = addDays(ws, -7);
    let escalated = 0;
    for (const p of await timeKeepers(ctx)) {
      const cal = await workingCalendar(ctx.tx, { ...p }, ws, addDays(ws, 6));
      const first = cal.find((d) => d.workingDay)?.date;
      if (!first || today < first || (today === first && minutesOfDay(ctx.now) < 12 * 60)) continue;
      const prevCal = await workingCalendar(ctx.tx, { ...p }, prev, addDays(prev, 6));
      if (!prevCal.some((d) => d.workingDay)) continue; // nothing to confirm (holidays or leave all week)
      const r = await ctx.tx
        .insertInto("timesheet_weeks")
        .values({ user_id: p.id, week_start: prev, escalated_at: ctx.now })
        .onConflict((oc) =>
          oc
            .columns(["user_id", "week_start"])
            .doUpdateSet({ escalated_at: ctx.now })
            .where("timesheet_weeks.escalated_at", "is", null)
            .where("timesheet_weeks.status", "=", "open"),
        )
        .returning("id")
        .executeTakeFirst();
      if (!r) continue;
      const leads = p.team_id
        ? await ctx.tx
            .selectFrom("users as u")
            .innerJoin("user_roles as r", "r.user_id", "u.id")
            .select("u.id")
            .where("r.role", "=", "team_lead")
            .where("u.team_id", "=", p.team_id)
            .where("u.active", "=", true)
            .where("u.id", "<>", p.id)
            .execute()
        : [];
      const leadIds = leads.length ? leads.map((l) => l.id) : p.manager_id ? [p.manager_id] : [];
      ctx.emit("timesheet.overdue", { userId: p.id, name: p.display_name, weekStart: prev, leadIds });
      escalated++;
    }
    return { weekStart: prev, escalated };
  },
});
