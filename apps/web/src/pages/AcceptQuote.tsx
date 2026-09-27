// "Accept quote" (specs/commercial/accept-scope.md): the client said yes to a sent quote. One server call closes the
// deal as Won, turns the quote into scope, and opens a gated project with its template tasks (COM-AC-01..04).
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { op, type Me } from "../api";
import { ErrorBanner, Field, Modal } from "../components/ui";
import { phnomPenhToday } from "../format";
import { useI18n } from "../i18n";
import { useDirectory, useProjectTypes, useWinReasons } from "../queries";
import { navigate } from "../router";
import type { QuoteDetail } from "../types";

export function AcceptQuoteModal({ quote, me, onClose }: { quote: QuoteDetail; me: Me; onClose: () => void }) {
  const { t, label } = useI18n();
  const qc = useQueryClient();
  const reasons = useWinReasons();
  const users = useDirectory(me);
  const pts = useProjectTypes(me);
  const [winReasonCode, setWinReason] = useState("");
  const [plannedStart, setPlannedStart] = useState(phnomPenhToday());
  // D-AC-1: the PM defaults to the quote owner.
  const [pmId, setPmId] = useState(quote.ownerId);
  const [projectTypeId, setProjectTypeId] = useState(quote.projectTypeId ?? "");
  const [projectName, setProjectName] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await op<{ projectId: string }>("quote.accept", {
        id: quote.id,
        expectedVersion: quote.version,
        winReasonCode: winReasonCode || null,
        plannedStart,
        projectManagerId: pmId || null,
        projectTypeId: projectTypeId || null,
        ...(projectName.trim() ? { projectName: projectName.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      await Promise.all(
        [["quote"], ["quotes"], ["deals"], ["deal"], ["projects"]].map((k) => qc.invalidateQueries({ queryKey: k })),
      );
      navigate(`/projects/${r.projectId}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal title={t("acceptQuote")} onClose={onClose} testId="accept-modal">
      <form onSubmit={submit}>
        <p className="muted small">{t("acceptHelp")}</p>
        <ErrorBanner error={error} />
        <Field label={t("winReason")}>
          <select value={winReasonCode} onChange={(e) => setWinReason(e.target.value)} required data-testid="accept-win-reason">
            <option value="">{t("chooseReason")}</option>
            {reasons.data?.map((r) => (
              <option key={r.code} value={r.code}>
                {label(r.label_en, r.label_km)}
              </option>
            ))}
          </select>
        </Field>
        <div className="row">
          <Field label={t("plannedStart")}>
            <input
              type="date"
              value={plannedStart}
              onChange={(e) => setPlannedStart(e.target.value)}
              required
              data-testid="accept-planned-start"
            />
          </Field>
          <Field label={t("projectManager")}>
            <select value={pmId} onChange={(e) => setPmId(e.target.value)} required data-testid="accept-pm">
              {users.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {label(u.displayName, u.displayNameKm)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={t("projectType")}>
          <select
            value={projectTypeId}
            onChange={(e) => setProjectTypeId(e.target.value)}
            required
            data-testid="accept-project-type"
          >
            <option value="">{t("none")}</option>
            {pts.data
              ?.filter((p) => p.active || p.id === projectTypeId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {label(p.label_en, p.label_km)}
                </option>
              ))}
          </select>
        </Field>
        <Field label={t("projectNameOptional")}>
          <input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            maxLength={200}
            placeholder={quote.title}
            data-testid="accept-project-name"
          />
        </Field>
        <Field label={t("note")}>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} data-testid="accept-note" />
        </Field>
        <div className="actions">
          <button type="button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary" disabled={busy || !winReasonCode || !plannedStart || !pmId} data-testid="accept-confirm">
            {t("acceptQuote")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
