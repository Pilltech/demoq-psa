// The one approval inbox (specs/approvals/engine.md). What I may decide comes first; costs appear only when the
// server sends them (APR-EN-11). Far-below-floor approvals need a fresh TOTP (APR-EN-12, STEP_UP_REQUIRED).
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { formatBp } from "@demoq/shared";
import { ApiError, auth, op, type Me } from "../api";
import { ErrorBanner, Field, Modal } from "../components/ui";
import { useI18n } from "../i18n";
import { useInbox } from "../queries";
import { Link } from "../router";
import type { Approval } from "../types";

type Decision = "approve" | "reject";
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
  const [stepUp, setStepUp] = useState<{ a: Approval; decision: Decision; note: string } | null>(null);

  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: ["approvals"] }), qc.invalidateQueries({ queryKey: ["quote"] })]);

  const decide = async (a: Approval, decision: Decision, note: string) => {
    setError(null);
    setNotice(null);
    try {
      await op("approval.decide", { id: a.id, decision, note: note.trim() || null });
      await refresh();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === "STEP_UP_REQUIRED") {
        setStepUp({ a, decision, note });
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
            await decide(s.a, s.decision, s.note);
          }}
        />
      )}
    </section>
  );
}

function ApprovalCard({ a, onDecide }: { a: Approval; onDecide: (a: Approval, d: Decision, note: string) => Promise<boolean> }) {
  const { t, date, money } = useI18n();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const click = async (d: Decision) => {
    setBusy(true);
    const ok = await onDecide(a, d, note);
    if (!ok) setBusy(false);
  };
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
      className={`card approval${a.overdue ? " overdue" : ""}`}
      data-testid={`approval-${a.id}`}
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
      </dl>
      {a.subjectType === "quote" && (
        <p>
          <Link to={`/quotes/${a.subjectId}`} testId="approval-open-subject">
            {t("openQuote")}
          </Link>
        </p>
      )}
      {a.status !== "pending" && (
        <p className="muted small" data-testid="approval-decided">
          {t("decidedBy", { status: t(`approvalStatus.${a.status}`), who: a.decidedBy ?? "—" })}
          {a.decidedAt ? ` · ${date(a.decidedAt)}` : ""}
        </p>
      )}
      {a.canDecide && (
        <div className="decide">
          <Field label={t("decisionNote")}>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} data-testid="decision-note" />
          </Field>
          <div className="actions">
            <button className="danger" disabled={busy} onClick={() => click("reject")} data-testid="reject-approval">
              {t("reject")}
            </button>
            <button className="primary" disabled={busy} onClick={() => click("approve")} data-testid="approve-approval">
              {t("approve")}
            </button>
          </div>
        </div>
      )}
    </article>
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
