// My week (specs/time/timesheets.md): the pre-filled draft, days × targets, one-tap Confirm (TIM-TS-04/05/06/10), and
// the team view for leads (TIM-TS-07/08). Opening a week calls timesheet.open, so the time from opening to confirming
// is measured on the server (M2 #10). The server decides every number; the grid only edits minutes.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { ApiError, hasPerm, op, type Me } from "../api";
import { ErrorBanner, Field, Modal, Tabs } from "../components/ui";
import { addDaysIso, formatMinutes, minutesToCell, mondayOf, parseCell, phnomPenhToday } from "../format";
import { useI18n } from "../i18n";
import { useActivityCodes, useProjects } from "../queries";
import type { Deal, Task, TargetType, TeamWeek, WeekDay, WeekRowDto, WeekTarget, WeekView } from "../types";

/** Time sub-navigation: my week, leave and holidays, my team (leads). */
export function TimeTabs({ me }: { me: Me }) {
  const { t } = useI18n();
  const items = [
    ...(hasPerm(me, "time.allocate_own") ? [{ to: "/time", label: t("myWeek"), testId: "tab-week" }] : []),
    { to: "/time/leave", label: t("leaveAndHolidays"), testId: "tab-leave" },
    ...(hasPerm(me, "time.view_team") ? [{ to: "/time/team", label: t("teamTime"), testId: "tab-team" }] : []),
  ];
  return items.length > 1 ? <Tabs items={items} /> : null;
}

/** Previous / next week (never a future week: the server refuses them). */
function WeekNav({ weekStart, onChange }: { weekStart: string; onChange: (ws: string) => void }) {
  const { t, locale } = useI18n();
  const current = mondayOf(phnomPenhToday());
  const fmt = new Intl.DateTimeFormat(locale === "km" ? "km-KH" : "en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const d = (iso: string) => fmt.format(new Date(`${iso}T00:00:00Z`));
  return (
    <div className="week-nav">
      <button onClick={() => onChange(addDaysIso(weekStart, -7))} data-testid="week-prev" aria-label={t("previousWeek")}>
        ‹
      </button>
      <strong data-testid="week-title" data-week={weekStart}>
        {t("weekOf", { from: d(weekStart), to: d(addDaysIso(weekStart, 6)) })}
      </strong>
      <button
        onClick={() => onChange(addDaysIso(weekStart, 7))}
        disabled={weekStart >= current}
        data-testid="week-next"
        aria-label={t("nextWeek")}
      >
        ›
      </button>
      {weekStart !== current && (
        <button className="link small" onClick={() => onChange(current)} data-testid="week-current">
          {t("thisWeek")}
        </button>
      )}
    </div>
  );
}

// ---- My week ----------------------------------------------------------------------------------

type GridTarget = Pick<
  WeekTarget,
  "targetType" | "taskId" | "projectId" | "dealId" | "activityCode" | "key" | "label" | "labelKm" | "projectName"
> & { minutesByDate: Record<string, number>; added?: boolean };

const tkey = (x: { targetType: TargetType; key: string }) => `${x.targetType}|${x.key}`;
const targetIdOf = (x: GridTarget | WeekRowDto) =>
  x.targetType === "internal" ? null : x.targetType === "task" ? x.taskId : x.targetType === "project" ? x.projectId : x.dealId;

export function MyWeek({ me }: { me: Me }) {
  const [weekStart, setWeekStart] = useState(() => mondayOf(phnomPenhToday()));
  const { t } = useI18n();
  return (
    <section data-testid="my-week">
      <h1>{t("time")}</h1>
      <TimeTabs me={me} />
      <WeekNav weekStart={weekStart} onChange={setWeekStart} />
      <WeekEditor key={weekStart} weekStart={weekStart} me={me} />
    </section>
  );
}

function WeekEditor({ weekStart, me }: { weekStart: string; me: Me }) {
  const { t, label, date } = useI18n();
  const qc = useQueryClient();
  // TIM-TS-10: opening the week (not just reading it) records when the pre-filled draft was first seen.
  const week = useQuery({
    queryKey: ["week", weekStart],
    queryFn: () => op<WeekView>("timesheet.open", { weekStart }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<GridTarget[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const today = phnomPenhToday();

  const v = week.data;
  const targets: GridTarget[] = useMemo(() => {
    if (!v) return [];
    const seen = new Set(v.targets.map(tkey));
    return [...v.targets, ...added.filter((a) => !seen.has(tkey(a)))];
  }, [v, added]);
  if (week.error) return <ErrorBanner error={week.error} />;
  if (!v) return <p>{t("loading")}</p>;

  const confirmed = v.status === "confirmed";
  const cell = (g: GridTarget, d: string) => `${tkey(g)}|${d}`;
  const minutesOf = (g: GridTarget, d: string): number | null => {
    const r = raw[cell(g, d)];
    return r === undefined ? (g.minutesByDate[d] ?? 0) : parseCell(r);
  };
  const edited =
    Object.entries(raw).some(([k, r]) => {
      const [type, key, d] = k.split("|");
      const g = targets.find((x) => x.targetType === type && x.key === key);
      return parseCell(r) !== (g?.minutesByDate[d!] ?? 0);
    }) || false;
  const invalid = Object.values(raw).some((r) => parseCell(r) === null);
  const dayTotal = (d: string) => targets.reduce((s, g) => s + (minutesOf(g, d) ?? 0), 0);
  // Days after today cannot be confirmed yet (TIM-TS-01): the total is what a confirmation would record.
  const total = v.days.filter((d) => d.date <= today).reduce((s, d) => s + dayTotal(d.date), 0);
  const futureRows = v.rows.filter((r) => r.date > today);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      let rows:
        | { date: string; targetType: TargetType; targetId: string | null; activityCode: string | null; minutes: number }[]
        | undefined;
      if (edited) {
        rows = targets.flatMap((g) =>
          v.days
            .filter((d) => d.date <= today)
            .map((d) => ({ date: d.date, minutes: minutesOf(g, d.date) ?? 0 }))
            .filter((c) => c.minutes > 0)
            .map((c) => ({ ...c, targetType: g.targetType, targetId: targetIdOf(g), activityCode: g.activityCode })),
        );
      } else if (futureRows.length) {
        // Days after today cannot hold time yet (TIM-TS-01): confirm the days that have happened.
        rows = v.rows
          .filter((r) => r.date <= today)
          .map((r) => ({
            date: r.date,
            targetType: r.targetType,
            targetId: targetIdOf(r),
            activityCode: r.activityCode,
            minutes: r.minutes,
          }));
      }
      await op("timesheet.confirm", { weekStart, draftHash: v.draftHash, ...(rows ? { rows } : {}) });
      setRaw({});
      setAdded([]);
      await Promise.all([["week", weekStart], ["team-week"], ["attendance"]].map((k) => qc.invalidateQueries({ queryKey: k })));
    } catch (e) {
      setError(e);
      if (e instanceof ApiError && e.code === "STALE_VERSION") await qc.invalidateQueries({ queryKey: ["week", weekStart] });
    } finally {
      setBusy(false);
    }
  };

  const confirmSeconds =
    v.openedAt && v.confirmedAt ? Math.max(0, Math.round((Date.parse(v.confirmedAt) - Date.parse(v.openedAt)) / 1000)) : null;

  return (
    <div className="week" data-testid="week" data-status={v.status} data-week={v.weekStart}>
      <div className="week-summary card">
        <div className="week-summary-main">
          <span className={`badge week-${v.status}`} data-testid="week-status" data-status={v.status}>
            {t(`weekStatus.${v.status}`)}
          </span>
          <span data-testid="week-total" data-minutes={total}>
            {t("weekTotal", { time: formatMinutes(total) })}
          </span>
          <span className="muted small">{t("attendedTotal", { time: formatMinutes(v.totals.attendedMinutes) })}</span>
          {v.totals.flaggedSessions > 0 && (
            <span className="tag danger" data-testid="week-flagged">
              {t("flaggedSessions", { n: String(v.totals.flaggedSessions) })}
            </span>
          )}
        </div>
        {confirmed ? (
          <p className="ok" data-testid="week-locked">
            {t("weekConfirmedOn", { when: v.confirmedAt ? date(v.confirmedAt) : "" })}
            {confirmSeconds !== null && (
              <span data-testid="week-confirm-seconds" data-seconds={confirmSeconds}>
                {" "}
                · {t("confirmedInSeconds", { s: String(confirmSeconds) })}
              </span>
            )}
          </p>
        ) : (
          <>
            {v.reopenReason && (
              <p className="notice" data-testid="week-reopened">
                {t("weekReopened", { reason: v.reopenReason })}
              </p>
            )}
            <p className="muted small" data-testid="week-basis" data-basis={v.prefillBasis}>
              {t(`prefillBasis.${v.prefillBasis}`)}
            </p>
            {futureRows.length > 0 && <p className="muted small">{t("weekNotOver")}</p>}
            <ErrorBanner error={error} />
            <div className="actions start">
              <button
                className="primary big"
                onClick={confirm}
                disabled={busy || invalid}
                data-testid="week-confirm"
                data-edited={edited ? "true" : "false"}
              >
                {edited ? t("confirmWithEdits") : t("confirmWeek")}
              </button>
              {edited && (
                <button
                  onClick={() => {
                    setRaw({});
                    setAdded([]);
                  }}
                  data-testid="week-reset"
                >
                  {t("undoEdits")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
      <div className="table-scroll week-scroll">
        <table className="table week-grid" data-testid="week-grid">
          <thead>
            <tr>
              <th className="target-col">{t("workedOn")}</th>
              {v.days.map((d) => (
                <DayHead key={d.date} d={d} future={d.date > today} />
              ))}
              <th className="num">{t("totalShort")}</th>
            </tr>
          </thead>
          <tbody>
            {targets.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  {t("noTimeYet")}
                </td>
              </tr>
            )}
            {targets.map((g, i) => (
              <tr key={tkey(g)} data-testid={`week-row-${i}`} data-target={tkey(g)} data-label={g.label}>
                <th className="target-col" scope="row">
                  <span className="target-type">{t(`targetType.${g.targetType}`)}</span>
                  <span className="target-label">{g.targetType === "internal" ? label(g.label, g.labelKm) : g.label}</span>
                  {g.projectName && g.targetType === "task" && <span className="muted small"> · {g.projectName}</span>}
                </th>
                {v.days.map((d) => {
                  const m = minutesOf(g, d.date);
                  const k = cell(g, d.date);
                  const off = !d.workingDay;
                  const future = d.date > today;
                  const row = v.rows.find((r) => r.date === d.date && tkey(r) === tkey(g));
                  return (
                    <td
                      key={d.date}
                      className={`num${off ? " off" : ""}${future ? " future" : ""}${row?.source === "prefill" ? " prefill" : ""}`}
                      data-testid={`week-cell-${i}-${d.date}`}
                      data-minutes={m ?? ""}
                    >
                      {confirmed || future ? (
                        <span>{m ? formatMinutes(m) : ""}</span>
                      ) : (
                        <input
                          className="cell"
                          inputMode="decimal"
                          value={raw[k] ?? minutesToCell(g.minutesByDate[d.date] ?? 0)}
                          onChange={(e) => setRaw({ ...raw, [k]: e.target.value })}
                          aria-invalid={m === null}
                          aria-label={`${g.label} ${d.date}`}
                          placeholder="0"
                          data-testid={`week-input-${i}-${d.date}`}
                        />
                      )}
                    </td>
                  );
                })}
                <td className="num">{formatMinutes(v.days.reduce((s, d) => s + (minutesOf(g, d.date) ?? 0), 0))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th className="target-col">{t("dayTotal")}</th>
              {v.days.map((d) => {
                const m = dayTotal(d.date);
                return (
                  <td
                    key={d.date}
                    className={`num${m > 1440 ? " bad" : ""}`}
                    data-testid={`week-day-total-${d.date}`}
                    data-minutes={m}
                  >
                    {m ? formatMinutes(m) : "—"}
                  </td>
                );
              })}
              <td className="num">
                <strong>{formatMinutes(total)}</strong>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {!confirmed && <AddRow me={me} existing={targets} onAdd={(g) => setAdded([...added, g])} />}
      <p className="muted small">{t("weekHelp")}</p>
    </div>
  );
}

function DayHead({ d, future }: { d: WeekDay; future: boolean }) {
  const { t, label, locale } = useI18n();
  const wd = new Intl.DateTimeFormat(locale === "km" ? "km-KH" : "en-GB", { weekday: "short", timeZone: "UTC" }).format(
    new Date(`${d.date}T00:00:00Z`),
  );
  return (
    <th
      className={`day-head${d.workingDay ? "" : " off"}${future ? " future" : ""}`}
      data-testid={`week-day-${d.date}`}
      data-working={d.workingDay ? "true" : "false"}
    >
      <div>
        {wd} {d.date.slice(8)}/{d.date.slice(5, 7)}
      </div>
      {d.attendedMinutes > 0 && (
        <div className="small muted" data-testid={`week-attended-${d.date}`}>
          {t("attendedShort", { time: formatMinutes(d.attendedMinutes) })}
          {d.runningSession && " ●"}
        </div>
      )}
      {d.workingDay && d.attendedMinutes === 0 && d.baseMinutes ? (
        <div className="small muted">{t("capacityShort", { time: formatMinutes(d.baseMinutes) })}</div>
      ) : null}
      {d.holiday && (
        <div className="small holiday" data-testid={`week-holiday-${d.date}`}>
          {label(d.holiday.nameEn, d.holiday.nameKm)}
          {!d.holiday.verified && <span className="tag">{t("unverified")}</span>}
        </div>
      )}
      {d.leave && (
        <div className="small leave">
          {t("onLeave")}
          {d.leave.halfDay ? ` (${t(`halfDay.${d.leave.halfDay}`)})` : ""}
        </div>
      )}
      {!d.scheduled && !d.holiday && <div className="small muted">{t("notWorking")}</div>}
      {d.flaggedSessions > 0 && (
        <div className="small flagged" title={t("flaggedHint")}>
          ⚑ {d.flaggedSessions}
        </div>
      )}
    </th>
  );
}

/** Add a row: one of my tasks, a project, a deal (for those who see deals) or an internal activity code. */
function AddRow({ me, existing, onAdd }: { me: Me; existing: GridTarget[]; onAdd: (g: GridTarget) => void }) {
  const { t, label } = useI18n();
  const tasks = useQuery({ queryKey: ["my-tasks", me.id, "open"], queryFn: () => op<Task[]>("task.mine", {}) });
  const projects = useProjects(me, false);
  const deals = useQuery({
    queryKey: ["deals"],
    enabled: hasPerm(me, "deal.view"),
    queryFn: () => op<Deal[]>("deal.list", {}),
  });
  const codes = useActivityCodes();
  const taken = new Set(existing.map(tkey));
  const options: { value: string; group: string; g: GridTarget }[] = [];
  const base = {
    taskId: null,
    projectId: null,
    dealId: null,
    activityCode: null,
    labelKm: null,
    projectName: null,
    minutesByDate: {},
    added: true,
  };
  for (const k of tasks.data ?? [])
    options.push({
      value: `task|${k.id}`,
      group: t("myTasks"),
      g: {
        ...base,
        targetType: "task",
        taskId: k.id,
        projectId: k.project_id,
        key: k.id,
        label: k.title,
        projectName: k.project_name,
      },
    });
  for (const p of (projects.data ?? []).filter((p) => p.status !== "cancelled" && p.status !== "completed"))
    options.push({
      value: `project|${p.id}`,
      group: t("projects"),
      g: { ...base, targetType: "project", projectId: p.id, key: p.id, label: p.name, projectName: p.name },
    });
  for (const d of (deals.data ?? []).filter((d) => d.stage !== "won" && d.stage !== "lost"))
    options.push({
      value: `deal|${d.id}`,
      group: t("deals"),
      g: { ...base, targetType: "deal", dealId: d.id, key: d.id, label: d.title },
    });
  for (const c of codes.data ?? [])
    options.push({
      value: `internal|code:${c.code}`,
      group: t("internalTime"),
      g: { ...base, targetType: "internal", activityCode: c.code, key: `code:${c.code}`, label: c.labelEn, labelKm: c.labelKm },
    });
  const free = options.filter((o) => !taken.has(o.value));
  const groups = [...new Set(free.map((o) => o.group))];
  return (
    <div className="add-row">
      <select
        value=""
        onChange={(e) => {
          const o = free.find((x) => x.value === e.target.value);
          if (o) onAdd(o.g);
        }}
        aria-label={t("addTimeRow")}
        data-testid="week-add-row"
      >
        <option value="">{t("addTimeRow")}</option>
        {groups.map((gr) => (
          <optgroup key={gr} label={gr}>
            {free
              .filter((o) => o.group === gr)
              .map((o) => (
                <option key={o.value} value={o.value}>
                  {o.g.targetType === "internal" ? label(o.g.label, o.g.labelKm) : o.g.label}
                  {o.g.targetType === "task" && o.g.projectName ? ` · ${o.g.projectName}` : ""}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

// ---- Team time (TIM-TS-07/08) -----------------------------------------------------------------

export function TeamTime({ me }: { me: Me }) {
  const { t, date } = useI18n();
  const [weekStart, setWeekStart] = useState(() => mondayOf(phnomPenhToday()));
  const team = useQuery({
    queryKey: ["team-week", weekStart],
    queryFn: () => op<TeamWeek>("timesheet.team", { weekStart }),
  });
  const [reopening, setReopening] = useState<{ userId: string; name: string } | null>(null);
  const mayReopen = hasPerm(me, "time.reopen");
  const m = team.data?.metrics;
  return (
    <section data-testid="team-time">
      <h1>{t("time")}</h1>
      <TimeTabs me={me} />
      <WeekNav weekStart={weekStart} onChange={setWeekStart} />
      <ErrorBanner error={team.error} />
      {team.isLoading && <p>{t("loading")}</p>}
      {team.data && (
        <>
          <dl className="figures">
            <div>
              <dt>{t("confirmedCount")}</dt>
              <dd data-testid="team-confirmed">
                {team.data.confirmedCount} / {team.data.people.length}
              </dd>
            </div>
            <div>
              <dt>{t("prefillKept")}</dt>
              <dd>{m?.prefillKeptRatio === null || !m ? "—" : `${Math.round(m.prefillKeptRatio * 100)}%`}</dd>
            </div>
            <div>
              <dt>{t("medianConfirm")}</dt>
              <dd>
                {m?.medianConfirmSeconds === null || !m ? "—" : t("seconds", { s: String(Math.round(m.medianConfirmSeconds)) })}
              </dd>
            </div>
          </dl>
          <div className="table-scroll">
            <table className="table" data-testid="team-table">
              <thead>
                <tr>
                  <th>{t("person")}</th>
                  <th>{t("weekStatusLabel")}</th>
                  <th className="num">{t("attended")}</th>
                  <th className="num">{t("allocated")}</th>
                  <th>{t("flagged")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {team.data.people.map((p) => (
                  <tr key={p.userId} data-testid={`team-row-${p.name}`} data-status={p.status}>
                    <td>{p.name}</td>
                    <td>
                      <span className={`badge week-${p.status}`}>{t(`weekStatus.${p.status}`)}</span>
                      <div className="muted small">
                        {p.confirmedAt
                          ? t("confirmedAtShort", { when: date(p.confirmedAt) })
                          : p.openedAt
                            ? t("openedAtShort", { when: date(p.openedAt) })
                            : t("notOpened")}
                        {p.reopenCount > 0 ? ` · ${t("reopenedTimes", { n: String(p.reopenCount) })}` : ""}
                      </div>
                    </td>
                    <td className="num">{formatMinutes(p.attendedMinutes)}</td>
                    <td className="num">{formatMinutes(p.allocatedMinutes)}</td>
                    <td>{p.flaggedSessions > 0 ? <span className="tag danger">⚑ {p.flaggedSessions}</span> : ""}</td>
                    <td>
                      {mayReopen && p.status === "confirmed" && p.userId !== me.id && (
                        <button onClick={() => setReopening({ userId: p.userId, name: p.name })} data-testid="team-reopen">
                          {t("reopenWeek")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {reopening && <ReopenModal weekStart={weekStart} who={reopening} onClose={() => setReopening(null)} />}
    </section>
  );
}

function ReopenModal({
  weekStart,
  who,
  onClose,
}: {
  weekStart: string;
  who: { userId: string; name: string };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await op("timesheet.reopen", { userId: who.userId, weekStart, reason: reason.trim() });
      await qc.invalidateQueries({ queryKey: ["team-week"] });
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t("reopenWeekOf", { who: who.name })} onClose={onClose} testId="reopen-modal">
      <form onSubmit={submit}>
        <p className="muted small">{t("reopenHelp")}</p>
        <ErrorBanner error={error} />
        <Field label={t("reasonMin", { n: "3" })}>
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            data-testid="reopen-reason"
          />
        </Field>
        <div className="actions">
          <button type="button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary" disabled={busy || reason.trim().length < 3} data-testid="reopen-submit">
            {t("reopenWeek")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
