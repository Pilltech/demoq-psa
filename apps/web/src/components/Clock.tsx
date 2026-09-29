// Clock in / out from any page (specs/time/attendance.md, TIM-AT-01/02/06): the running session and today's total.
// Compact enough for the phone header. The server decides everything (one open session, ≥ 1 minute, auto-close).
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, op, type Me } from "../api";
import { formatMinutes } from "../format";
import { useI18n } from "../i18n";
import { useAttendance } from "../queries";

export function ClockControl({ me }: { me: Me }) {
  const { t, err } = useI18n();
  const qc = useQueryClient();
  const status = useAttendance(me);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);
  if (!status.data) return null;
  const s = status.data;
  const running = s.running;
  // Minutes since the server's answer, so the running time moves between refreshes.
  const drift = running ? Math.max(0, Math.floor((now - status.dataUpdatedAt) / 60_000)) : 0;
  const runningMinutes = running ? running.minutes + drift : 0;
  const todayMinutes = s.todayMinutes + drift;

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await op(running ? "attendance.clock_out" : "attendance.clock_in", {});
      setNow(Date.now());
    } catch (e) {
      if (e instanceof ApiError && e.code === "VALIDATION" && e.problem.params?.reason === "session_too_short")
        setError(t("clockTooShort"));
      else setError(e instanceof ApiError ? err(e.code) : err("INTERNAL"));
    } finally {
      await Promise.all([qc.invalidateQueries({ queryKey: ["attendance"] }), qc.invalidateQueries({ queryKey: ["week"] })]);
      setBusy(false);
    }
  };

  return (
    <div className={`clock${running ? " running" : ""}`} data-testid="clock" data-running={running ? "true" : "false"}>
      <button
        className={running ? "clock-btn stop" : "clock-btn"}
        onClick={toggle}
        disabled={busy}
        data-testid={running ? "clock-out" : "clock-in"}
        title={running ? t("clockOutHint") : t("clockInHint")}
      >
        <span className="dot" aria-hidden="true" />
        {running ? t("clockOut") : t("clockIn")}
      </button>
      <span className="clock-text">
        {running && (
          <span data-testid="clock-running" data-minutes={runningMinutes}>
            {formatMinutes(runningMinutes)}
          </span>
        )}
        <span className="clock-today" data-testid="clock-today" data-minutes={todayMinutes}>
          {t("todayTotal", { time: formatMinutes(todayMinutes) })}
        </span>
      </span>
      {error && (
        <span role="alert" className="clock-error" data-testid="clock-error" onClick={() => setError(null)}>
          {error}
        </span>
      )}
    </div>
  );
}
