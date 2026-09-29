// Leave and public holidays (specs/time/leave-holidays.md): request leave (TIM-LV-03, TIM-LV-08), my requests with their
// status and cancel (TIM-LV-05), and the holiday list everyone can see, unverified entries marked (TIM-LV-01, D-HD-1).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { hasPerm, op, type Me } from "../api";
import { ErrorBanner, Field } from "../components/ui";
import { phnomPenhToday } from "../format";
import { useI18n } from "../i18n";
import { useHolidays, useLeaveTypes } from "../queries";
import type { LeaveRequest } from "../types";
import { TimeTabs } from "./Time";

export function LeavePage({ me }: { me: Me }) {
  const { t } = useI18n();
  const mine = hasPerm(me, "leave.request_own");
  return (
    <section data-testid="leave-page">
      <h1>{t("time")}</h1>
      <TimeTabs me={me} />
      <div className="grid2">
        {mine && <LeaveForm />}
        {mine && <MyLeave />}
        <HolidayList />
      </div>
    </section>
  );
}

function LeaveForm() {
  const { t, label } = useI18n();
  const qc = useQueryClient();
  const types = useLeaveTypes();
  const today = phnomPenhToday();
  const [leaveType, setLeaveType] = useState("");
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [half, setHalf] = useState<"" | "am" | "pm">("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);
  const type = types.data?.find((x) => x.code === leaveType);
  const oneDay = start === end;
  const halfAllowed = !!type?.halfDayAllowed && oneDay;
  const valid = !!leaveType && !!start && !!end && end >= start;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    setFlash(false);
    try {
      await op("leave.request", {
        leaveType,
        startDate: start,
        endDate: end,
        halfDay: halfAllowed && half ? half : null,
        reason: reason.trim() || null,
      });
      setReason("");
      setHalf("");
      setFlash(true);
      await qc.invalidateQueries({ queryKey: ["leave"] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card" onSubmit={submit} data-testid="leave-form">
      <h2>{t("requestLeave")}</h2>
      {flash && (
        <p className="ok" role="status" data-testid="leave-flash">
          {t("leaveRequested")}
        </p>
      )}
      <ErrorBanner error={error} />
      <Field label={t("leaveType")}>
        <select value={leaveType} onChange={(e) => setLeaveType(e.target.value)} required data-testid="leave-type">
          <option value="">{t("chooseLeaveType")}</option>
          {types.data?.map((x) => (
            <option key={x.code} value={x.code}>
              {label(x.labelEn, x.labelKm)}
              {x.paid ? "" : ` (${t("unpaid")})`}
            </option>
          ))}
        </select>
      </Field>
      <div className="row">
        <Field label={t("fromDate")}>
          <input
            type="date"
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              if (end < e.target.value) setEnd(e.target.value);
            }}
            required
            data-testid="leave-start"
          />
        </Field>
        <Field label={t("toDate")}>
          <input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} required data-testid="leave-end" />
        </Field>
      </div>
      {halfAllowed && (
        <fieldset className="roles" data-testid="leave-half">
          <legend>{t("halfDayQ")}</legend>
          {(["", "am", "pm"] as const).map((h) => (
            <label key={h || "full"} className="check">
              <input
                type="radio"
                name="half"
                checked={half === h}
                onChange={() => setHalf(h)}
                data-testid={`leave-half-${h || "full"}`}
              />
              {h ? t(`halfDay.${h}`) : t("fullDay")}
            </label>
          ))}
        </fieldset>
      )}
      <Field label={t("leaveReason")}>
        <textarea
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={1000}
          data-testid="leave-reason"
        />
      </Field>
      <p className="muted small">{t("leaveHelp")}</p>
      <div className="actions">
        <button className="primary" disabled={busy || !valid} data-testid="leave-submit">
          {t("sendRequest")}
        </button>
      </div>
    </form>
  );
}

function MyLeave() {
  const { t, label } = useI18n();
  const qc = useQueryClient();
  const types = useLeaveTypes();
  const leave = useQuery({ queryKey: ["leave"], queryFn: () => op<LeaveRequest[]>("leave.mine", {}) });
  const [error, setError] = useState<unknown>(null);
  const today = phnomPenhToday();
  const cancel = async (l: LeaveRequest) => {
    setError(null);
    try {
      await op("leave.cancel", { id: l.id, expectedVersion: l.version });
      await Promise.all([qc.invalidateQueries({ queryKey: ["leave"] }), qc.invalidateQueries({ queryKey: ["approvals"] })]);
    } catch (e) {
      setError(e);
    }
  };
  const typeName = (code: string) => {
    const x = types.data?.find((y) => y.code === code);
    return x ? label(x.labelEn, x.labelKm) : code;
  };
  return (
    <div className="card" data-testid="my-leave">
      <h2>{t("myLeave")}</h2>
      <ErrorBanner error={error ?? leave.error} />
      {leave.data && leave.data.length === 0 && <p className="muted">{t("noLeave")}</p>}
      <ul className="list">
        {leave.data?.map((l) => (
          <li key={l.id} className="leave-row" data-testid={`leave-${l.startDate}`} data-status={l.status}>
            <div>
              <strong>{typeName(l.leaveType)}</strong>{" "}
              <span className={`badge leave-${l.status}`}>{t(`leaveStatus.${l.status}`)}</span>
              <div className="muted small">
                {l.startDate === l.endDate ? l.startDate : `${l.startDate} → ${l.endDate}`}
                {l.halfDay ? ` · ${t(`halfDay.${l.halfDay}`)}` : ""}
                {l.reason ? ` · ${l.reason}` : ""}
              </div>
            </div>
            {(l.status === "requested" || (l.status === "approved" && l.startDate > today)) && (
              <button onClick={() => cancel(l)} data-testid="leave-cancel">
                {t("cancelLeave")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HolidayList() {
  const { t, label } = useI18n();
  const thisYear = Number(phnomPenhToday().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const holidays = useHolidays(year);
  return (
    <div className="card" data-testid="holiday-list">
      <div className="toolbar compact">
        <h2>{t("publicHolidays")}</h2>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="auto" data-testid="holiday-year">
          {[thisYear, thisYear + 1].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>
      <p className="muted small">{t("holidaysHelp")}</p>
      <ErrorBanner error={holidays.error} />
      <ul className="list">
        {holidays.data?.map((h) => (
          <li
            key={h.date}
            className="holiday-row"
            data-testid={`holiday-${h.date}`}
            data-verified={h.verified ? "true" : "false"}
          >
            <span className="keep-together">{h.date}</span> <span>{label(h.nameEn, h.nameKm)}</span>
            {!h.verified && <span className="tag">{t("unverified")}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
