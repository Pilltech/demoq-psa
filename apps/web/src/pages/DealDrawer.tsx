import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { hasPerm, op, type Me } from "../api";
import { ErrorBanner, Field, Modal } from "../components/ui";
import { useI18n } from "../i18n";
import type { AuditRow, DealDetail } from "../types";

export function DealDrawer({ id, me, onClose }: { id: string; me: Me; onClose: () => void }) {
  const { t, date, money } = useI18n();
  const qc = useQueryClient();
  const deal = useQuery({ queryKey: ["deal", id], queryFn: () => op<DealDetail>("deal.get", { id }) });
  const audit = useQuery({
    queryKey: ["audit", "deal", id],
    enabled: hasPerm(me, "audit.view"),
    queryFn: () => op<AuditRow[]>("audit.timeline", { subjectType: "deal", subjectId: id }),
  });
  const [reason, setReason] = useState("");
  const reopen = useMutation({
    mutationFn: () => op("deal.reopen", { id, expectedVersion: deal.data!.version, reason }),
    onSuccess: async () => {
      setReason("");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["deals"] }),
        qc.invalidateQueries({ queryKey: ["deal", id] }),
        qc.invalidateQueries({ queryKey: ["audit", "deal", id] }),
      ]);
    },
  });
  const d = deal.data;
  return (
    <Modal title={d?.title ?? t("loading")} onClose={onClose} testId="deal-drawer">
      {d && (
        <div className="drawer">
          <dl className="facts">
            <dt>{t("clients")}</dt>
            <dd>{d.client_name}</dd>
            <dt>{t("stage")}</dt>
            <dd data-testid="drawer-stage">{t(`stage.${d.stage}`)}</dd>
            <dt>{t("owner")}</dt>
            <dd>{d.owner_name}</dd>
            <dt>{t("expectedValue")}</dt>
            <dd>{money(d.expected_value_minor, d.currency)}</dd>
            {d.close_reason_code && (
              <>
                <dt>{t("closeReason")}</dt>
                <dd>
                  {d.close_reason_code}
                  {d.close_note ? ` — ${d.close_note}` : ""}
                </dd>
              </>
            )}
          </dl>
          {d.canReopen && (
            <form
              className="inline-form"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                reopen.mutate();
              }}
            >
              <ErrorBanner error={reopen.error} />
              <Field label={t("reopenReason")}>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  minLength={10}
                  required
                  data-testid="reopen-reason"
                />
              </Field>
              <button data-testid="reopen-submit">{t("reopen")}</button>
            </form>
          )}
          <h3>{t("history")}</h3>
          <ol className="timeline" data-testid="history">
            {d.history.map((h, i) => (
              <li key={i}>
                <strong>
                  {h.from_stage ? `${t(`stage.${h.from_stage}`)} → ` : ""}
                  {t(`stage.${h.to_stage}`)}
                </strong>
                {h.close_reason_code && <span className="tag">{h.close_reason_code}</span>}
                {h.note && <div className="muted">{h.note}</div>}
                <div className="muted small">{`${h.changed_by_name ?? "system"} · ${date(h.changed_at)}`}</div>
              </li>
            ))}
          </ol>
          {audit.data && (
            <>
              <h3>{t("auditTrail")}</h3>
              <ol className="timeline" data-testid="audit">
                {audit.data.map((a) => (
                  <li key={a.id} className={a.outcome === "denied" ? "denied" : ""}>
                    <code>{a.action}</code>
                    <div className="muted small">
                      {t("byOn", { who: a.actor_name, when: date(a.occurred_at), channel: a.channel })}
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
      <div className="actions">
        <button onClick={onClose} data-testid="drawer-close">
          {t("cancel")}
        </button>
      </div>
    </Modal>
  );
}
