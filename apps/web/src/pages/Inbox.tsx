// The one approval inbox (specs/approvals/engine.md). What I may decide comes first; costs appear only when the
// server sends them (APR-EN-11). Far-below-floor approvals need a fresh TOTP (APR-EN-12, STEP_UP_REQUIRED).
// Out-of-scope requests are decided with an outcome: Absorb, Change order or Reject (APR-EN-13, TSK-DL-08, INF-LK-11).
// Influencer-supplied text and links are shown as plain text and plain links, never as HTML.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { formatBp } from "@demoq/shared";
import { formatMinutes } from "../format";
import { ApiError, auth, op, type Me } from "../api";
import { ErrorBanner, Field, Modal } from "../components/ui";
import { useI18n } from "../i18n";
import { useInbox, useLeaveTypes } from "../queries";
import { Link } from "../router";
import type { Approval, Gate, OosOutcome } from "../types";

type Decision = "approve" | "reject";
/** APR-EN-13: absorb is the only approving outcome. */
const OUTCOMES: { outcome: OosOutcome; decision: Decision; className: string }[] = [
  { outcome: "absorb", decision: "approve", className: "primary" },
  { outcome: "change_order", decision: "reject", className: "" },
  { outcome: "reject", decision: "reject", className: "danger" },
];
const KINDS = [
  "margin_floor",
  "out_of_scope",
  "quality_check",
  "gate_bypass",
  "bypass_review",
  "influencer_work",
  "leave",
] as const;
const isKind = (k: string): k is (typeof KINDS)[number] => (KINDS as readonly string[]).includes(k);

export function Inbox({ me }: { me: Me }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [include, setInclude] = useState<"pending" | "recent">("pending");
  const inbox = useInbox(me, include);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<{ a: Approval; decision: Decision; note: string; outcome?: OosOutcome } | null>(null);

  const refresh = () =>
    Promise.all(
      [
        ["approvals"],
        ["quote"],
        ["project"],
        ["change-order"],
        ["task-board"],
        ["my-tasks"],
        ["task"],
        ["leave"],
        ["influencer-work"],
        ["influencer-summary"],
      ].map((k) => qc.invalidateQueries({ queryKey: k })),
    );

  const decide = async (a: Approval, decision: Decision, note: string, outcome?: OosOutcome) => {
    setError(null);
    setNotice(null);
    try {
      await op("approval.decide", { id: a.id, decision, note: note.trim() || null, ...(outcome ? { outcome } : {}) });
      await refresh();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === "STEP_UP_REQUIRED") {
        setStepUp({ a, decision, note, outcome });
      } else if (e instanceof ApiError && e.code === "ALREADY_DECIDED") {
        setNotice(t("alreadyDecided"));
        await refresh();
      } else {
        setError(e);
      }
      return false;
    }
  };

  const items = inbox.data ?? [];
  return (
    <section>
      <div className="toolbar">
        <h1>{t("approvals")}</h1>
        <div className="segmented" role="tablist">
          {(["pending", "recent"] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={include === k}
              className={include === k ? "active" : ""}
              onClick={() => setInclude(k)}
              data-testid={`inbox-tab-${k}`}
            >
              {t(`inbox.${k}`)}
            </button>
          ))}
        </div>
      </div>
      {notice && (
        <p className="notice" role="status" data-testid="inbox-notice">
          {notice}
        </p>
      )}
      <ErrorBanner error={error ?? inbox.error} />
      {inbox.isLoading && <p>{t("loading")}</p>}
      {inbox.data && items.length === 0 && <p className="muted">{t("inboxEmpty")}</p>}
      <div className="approval-list" data-testid="inbox-list">
        {items.map((a) => (
          <ApprovalCard key={a.id} a={a} onDecide={decide} />
        ))}
      </div>
      {stepUp && (
        <StepUpModal
          onCancel={() => setStepUp(null)}
          onVerified={async () => {
            const s = stepUp;
            setStepUp(null);
            await decide(s.a, s.decision, s.note, s.outcome);
          }}
        />
      )}
    </section>
  );
}

function ApprovalCard({
  a,
  onDecide,
}: {
  a: Approval;
  onDecide: (a: Approval, d: Decision, note: string, outcome?: OosOutcome) => Promise<boolean>;
}) {
  const { t, date, money } = useI18n();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const click = async (d: Decision, outcome?: OosOutcome) => {
    setBusy(true);
    const ok = await onDecide(a, d, note, outcome);
    if (!ok) setBusy(false);
  };
  // Deep link from MCP "decide in the app" (MCP-OA): /inbox?approval=<id> brings this card into view.
  const focused = new URLSearchParams(window.location.search).get("approval") === a.id;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  const oos = a.kind === "out_of_scope";
  const facts = a.facts;
  const currency = facts.currency === "KHR" ? "KHR" : "USD";
  const costs = a.costs as {
    feeMarginBp?: number | null;
    feeFloorBp?: number;
    ptMarkupBp?: number | null;
    ptFloorBp?: number | null;
  } | null;
  return (
    <article
      ref={ref}
      className={`card approval${a.overdue ? " overdue" : ""}${focused ? " focused" : ""}`}
      data-testid={`approval-${a.id}`}
      data-focused={focused || undefined}
      data-kind={a.kind}
      data-title={a.title}
    >
      <header className="approval-head">
        <span className="tag kind">{isKind(a.kind) ? t(`approvalKind.${a.kind}`) : a.kind}</span>
        {a.assignedToMe && <span className="tag">{t("assignedToYou")}</span>}
        {a.mine && <span className="tag">{t("yourRequest")}</span>}
        {a.overdue && (
          <span className="tag danger" data-testid="overdue">
            {t("overdue")}
          </span>
        )}
      </header>
      <h2 data-testid="approval-title">{a.title}</h2>
      <p className="muted small">
        {t("requestedBy", { who: a.requestedBy ?? "—" })} · {t("dueAt", { when: date(a.dueAt) })}
      </p>
      <dl className="facts">
        {typeof facts.totalMinor === "string" && (
          <>
            <dt>{t("total")}</dt>
            <dd data-testid="approval-total">{money(facts.totalMinor, currency)}</dd>
          </>
        )}
        {typeof facts.engagementType === "string" && (
          <>
            <dt>{t("engagementType")}</dt>
            <dd>{facts.engagementType}</dd>
          </>
        )}
        {costs && typeof costs.feeFloorBp === "number" && (
          <>
            <dt>{t("feeMargin")}</dt>
            <dd data-testid="approval-fee-margin" className={(costs.feeMarginBp ?? -1) < costs.feeFloorBp ? "bad" : ""}>
              {t("marginVsFloor", { margin: formatBp(costs.feeMarginBp ?? null), floor: formatBp(costs.feeFloorBp) })}
            </dd>
          </>
        )}
        {costs && costs.ptMarkupBp !== null && costs.ptMarkupBp !== undefined && (
          <>
            <dt>{t("ptMarkup")}</dt>
            <dd data-testid="approval-pt-markup">
              {costs.ptFloorBp !== null && costs.ptFloorBp !== undefined
                ? t("marginVsFloor", { margin: formatBp(costs.ptMarkupBp), floor: formatBp(costs.ptFloorBp) })
                : formatBp(costs.ptMarkupBp)}
            </dd>
          </>
        )}
        {Array.isArray(facts.gates) && (
          <>
            <dt>{t("bypassGates")}</dt>
            <dd data-testid="approval-gates">{(facts.gates as Gate[]).map((g) => t(`gate.${g}`)).join(", ")}</dd>
          </>
        )}
        {typeof facts.expiresOn === "string" && (
          <>
            <dt>{t("bypassExpires")}</dt>
            <dd>{facts.expiresOn}</dd>
          </>
        )}
        {typeof facts.reason === "string" && facts.reason !== "influencer_over_quantity" && (
          <>
            <dt>{t("closeReason")}</dt>
            <dd data-testid="approval-reason">{facts.reason}</dd>
          </>
        )}
        <S4Facts a={a} />
      </dl>
      {a.subjectType === "quote" && (
        <p>
          <Link to={`/quotes/${a.subjectId}`} testId="approval-open-subject">
            {t("openQuote")}
          </Link>
        </p>
      )}
      {a.subjectType === "change_order" && (
        <p>
          <Link to={`/change-orders/${a.subjectId}`} testId="approval-open-subject">
            {t("openChangeOrder")}
          </Link>
        </p>
      )}
      {a.subjectType !== "quote" && a.subjectType !== "change_order" && typeof facts.projectId === "string" && (
        <p className="links">
          {typeof facts.taskId === "string" ? (
            <Link to={`/projects/${facts.projectId}/tasks/${facts.taskId}`} testId="approval-open-subject">
              {t("openTask")}
            </Link>
          ) : typeof facts.assignmentId === "string" ? (
            <Link to={`/projects/${facts.projectId}/influencers`} testId="approval-open-subject">
              {t("openSubmissions")}
            </Link>
          ) : (
            <Link to={`/projects/${facts.projectId}`} testId="approval-open-subject">
              {t("openProject")}
            </Link>
          )}
          {(typeof facts.taskId === "string" || typeof facts.assignmentId === "string") && (
            <Link to={`/projects/${facts.projectId}`} testId="approval-open-project">
              {t("openProject")}
            </Link>
          )}
        </p>
      )}
      {a.subjectType === "leave_request" && (
        <p>
          <Link to="/time/leave" testId="approval-open-subject">
            {t("openLeave")}
          </Link>
        </p>
      )}
      {a.status !== "pending" && (
        <p className="muted small" data-testid="approval-decided">
          {t("decidedBy", {
            status: a.outcome ? t(`oosDecided.${a.outcome}`) : t(`approvalStatus.${a.status}`),
            who: a.decidedBy ?? "—",
          })}
          {a.decidedAt ? ` · ${date(a.decidedAt)}` : ""}
        </p>
      )}
      {a.canDecide && (
        <div className="decide">
          <Field label={t("decisionNote")}>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} data-testid="decision-note" />
          </Field>
          {oos ? (
            <>
              <p className="muted small">{t("oosOutcomeHelp")}</p>
              <div className="actions wrap">
                {OUTCOMES.map((o) => (
                  <button
                    key={o.outcome}
                    className={o.className}
                    disabled={busy}
                    onClick={() => click(o.decision, o.outcome)}
                    data-testid={`decide-${o.outcome}`}
                  >
                    {t(`oosOutcome.${o.outcome}`)}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="actions">
              <button className="danger" disabled={busy} onClick={() => click("reject")} data-testid="reject-approval">
                {t("reject")}
              </button>
              <button className="primary" disabled={busy} onClick={() => click("approve")} data-testid="approve-approval">
                {t("approve")}
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/** Facts of the S4 kinds: QC and revision rounds, leave, influencer work (all plain text; links are plain links). */
function S4Facts({ a }: { a: Approval }) {
  const { t, label } = useI18n();
  const f = a.facts;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const round = num(f.round);
  const rework = num(f.reworkMinutes);
  const estimate = num(f.estimateMinutes);
  const metrics = f.metrics && typeof f.metrics === "object" ? Object.entries(f.metrics as Record<string, unknown>) : [];
  const proofs = Array.isArray(f.proofUrls) ? (f.proofUrls as unknown[]).filter((u): u is string => typeof u === "string") : [];
  const leaveType = typeof f.leaveType === "string" ? f.leaveType : null;
  const types = useLeaveTypes(!!leaveType);
  const type = types.data?.find((x) => x.code === leaveType);
  return (
    <>
      {round !== null && (
        <>
          <dt>{t("revisionRound")}</dt>
          <dd data-testid="approval-round">{t("roundN", { n: String(round), max: "4" })}</dd>
        </>
      )}
      {rework !== null ? (
        <>
          <dt>{t("reworkEstimate")}</dt>
          <dd data-testid="approval-rework">{formatMinutes(rework)}</dd>
        </>
      ) : (
        estimate !== null && (
          <>
            <dt>{t("estimate")}</dt>
            <dd>{formatMinutes(estimate)}</dd>
          </>
        )
      )}
      {typeof f.note === "string" && f.note && a.kind === "quality_check" && (
        <>
          <dt>{t("noteLabel")}</dt>
          <dd>{f.note}</dd>
        </>
      )}
      {leaveType && (
        <>
          <dt>{t("leaveType")}</dt>
          <dd data-testid="approval-leave-type">{type ? label(type.labelEn, type.labelKm) : leaveType}</dd>
          <dt>{t("leaveDates")}</dt>
          <dd data-testid="approval-leave-dates">
            {f.startDate === f.endDate ? String(f.startDate) : `${String(f.startDate)} → ${String(f.endDate)}`}
            {f.halfDay === "am" || f.halfDay === "pm" ? ` · ${t(`halfDay.${f.halfDay}`)}` : ""}
          </dd>
        </>
      )}
      {typeof f.influencer === "string" && (
        <>
          <dt>{t("influencer")}</dt>
          <dd>{f.influencer}</dd>
        </>
      )}
      {typeof f.deliverable === "string" && (
        <>
          <dt>{t("deliverable")}</dt>
          <dd>{f.deliverable}</dd>
        </>
      )}
      {typeof f.postUrl === "string" && (
        <>
          <dt>{t("postUrl")}</dt>
          <dd className="break">
            <a href={f.postUrl} target="_blank" rel="noopener noreferrer nofollow" data-testid="approval-post-url">
              {f.postUrl}
            </a>
          </dd>
        </>
      )}
      {typeof f.postedOn === "string" && (
        <>
          <dt>{t("postedOn")}</dt>
          <dd>{f.postedOn}</dd>
        </>
      )}
      {metrics.length > 0 && (
        <>
          <dt>{t("metrics")}</dt>
          <dd>{metrics.map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}</dd>
        </>
      )}
      {proofs.length > 0 && (
        <>
          <dt>{t("proofLinks")}</dt>
          <dd className="break">
            <ul className="plain" data-testid="approval-proofs">
              {proofs.map((u) => (
                <li key={u}>
                  <a href={u} target="_blank" rel="noopener noreferrer nofollow">
                    {u}
                  </a>
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
      {typeof f.note === "string" && f.note && typeof f.postUrl === "string" && (
        <>
          <dt>{t("noteLabel")}</dt>
          <dd>{f.note}</dd>
        </>
      )}
      {num(f.contractedPosts) !== null && num(f.submittedCount) !== null && (
        <>
          <dt>{t("contractedPosts")}</dt>
          <dd data-testid="approval-post-count">
            {t("postNofM", { n: String(f.submittedCount), m: String(f.contractedPosts) })}
            {f.overQuantity === true && <span className="tag danger">{t("overQuantity")}</span>}
          </dd>
        </>
      )}
    </>
  );
}

function StepUpModal({ onCancel, onVerified }: { onCancel: () => void; onVerified: () => Promise<void> }) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.stepUp(code.trim());
      await onVerified();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t("stepUpTitle")} onClose={onCancel} testId="step-up-modal">
      <form onSubmit={submit}>
        <p>{t("stepUpHelp")}</p>
        <ErrorBanner error={error} />
        <Field label={t("totpCode")}>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoFocus
            data-testid="step-up-code"
          />
        </Field>
        <div className="actions">
          <button type="button" onClick={onCancel}>
            {t("cancel")}
          </button>
          <button className="primary" disabled={busy} data-testid="step-up-submit">
            {t("confirm")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
