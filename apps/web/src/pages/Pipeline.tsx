// Pipeline Kanban. Drag a card between columns (or use the stage menu on the card — works on
// phones and with a keyboard). Dropping on Lost asks for a reason; the server enforces it anyway.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type DragEvent, type FormEvent } from "react";
import { parseMoney } from "@demoq/shared";
import { ApiError, hasPerm, op, type Me } from "../api";
import { ErrorBanner, Field, Modal } from "../components/ui";
import { useI18n } from "../i18n";
import type { ClientRow, CloseReason, Deal, Stage } from "../types";
import { DealDrawer } from "./DealDrawer";

export const STAGES: Stage[] = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];

export function Pipeline({ me }: { me: Me }) {
  const { t, money } = useI18n();
  const qc = useQueryClient();
  const deals = useQuery({ queryKey: ["deals"], queryFn: () => op<Deal[]>("deal.list", {}) });
  const [error, setError] = useState<unknown>(null);
  const [losing, setLosing] = useState<Deal | null>(null);
  const [openDeal, setOpenDeal] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dragOver, setDragOver] = useState<Stage | null>(null);

  const move = useMutation({
    mutationFn: (v: { deal: Deal; toStage: Stage; closeReasonCode?: string; note?: string }) =>
      op("deal.move", {
        id: v.deal.id,
        expectedVersion: v.deal.version,
        toStage: v.toStage,
        closeReasonCode: v.closeReasonCode,
        note: v.note,
      }),
    onSuccess: () => {
      setError(null);
      return qc.invalidateQueries({ queryKey: ["deals"] });
    },
    onError: (e) => {
      setError(e);
      if (e instanceof ApiError && e.code === "STALE_VERSION") void qc.invalidateQueries({ queryKey: ["deals"] });
    },
  });

  const requestMove = (deal: Deal, to: Stage) => {
    if (deal.stage === to) return;
    if (to === "lost") return setLosing(deal); // ask for the reason first (CRM-CR-01)
    move.mutate({ deal, toStage: to });
  };

  const onDrop = (e: DragEvent, to: Stage) => {
    e.preventDefault();
    setDragOver(null);
    const deal = deals.data?.find((d) => d.id === e.dataTransfer.getData("text/deal-id"));
    if (deal) requestMove(deal, to);
  };

  return (
    <section>
      <div className="toolbar">
        <h1>{t("pipeline")}</h1>
        {hasPerm(me, "deal.manage") && (
          <button className="primary" onClick={() => setCreating(true)} data-testid="new-deal">
            {t("newDeal")}
          </button>
        )}
      </div>
      <ErrorBanner error={error} />
      {deals.isLoading && <p>{t("loading")}</p>}
      <div className="board" data-testid="board">
        {STAGES.map((stage) => {
          const cards = deals.data?.filter((d) => d.stage === stage) ?? [];
          return (
            <div
              key={stage}
              className={`column column-${stage}${dragOver === stage ? " over" : ""}`}
              data-testid={`column-${stage}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(stage);
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => onDrop(e, stage)}
            >
              <h3>
                {t(`stage.${stage}`)} <span className="count">{cards.length}</span>
              </h3>
              {stage === "won" && <p className="hint">{t("wonHint")}</p>}
              {cards.map((d) => (
                <article
                  key={d.id}
                  className="deal-card"
                  draggable={d.canManage && stage !== "won" && stage !== "lost"}
                  onDragStart={(e) => e.dataTransfer.setData("text/deal-id", d.id)}
                  data-testid={`deal-${d.id}`}
                  data-title={d.title}
                >
                  <button className="link title" onClick={() => setOpenDeal(d.id)}>
                    {d.title}
                  </button>
                  <div className="muted">{d.client_name}</div>
                  <div className="meta">
                    <span>{money(d.expected_value_minor, d.currency)}</span>
                    <span>{d.owner_name}</span>
                  </div>
                  {d.canManage && stage !== "won" && stage !== "lost" && (
                    <select
                      aria-label={t("moveTo")}
                      value=""
                      onChange={(e) => requestMove(d, e.target.value as Stage)}
                      data-testid={`move-${d.id}`}
                    >
                      <option value="">{t("moveTo")}…</option>
                      {STAGES.filter((s) => s !== stage).map((s) => (
                        <option key={s} value={s}>
                          {t(`stage.${s}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </article>
              ))}
            </div>
          );
        })}
      </div>
      {losing && (
        <LostReasonModal
          deal={losing}
          onCancel={() => setLosing(null)}
          onConfirm={(closeReasonCode, note) => {
            move.mutate({ deal: losing, toStage: "lost", closeReasonCode, note });
            setLosing(null);
          }}
        />
      )}
      {openDeal && <DealDrawer id={openDeal} me={me} onClose={() => setOpenDeal(null)} />}
      {creating && <NewDealModal me={me} onClose={() => setCreating(false)} />}
    </section>
  );
}

function LostReasonModal({
  deal,
  onCancel,
  onConfirm,
}: {
  deal: Deal;
  onCancel: () => void;
  onConfirm: (code: string, note?: string) => void;
}) {
  const { t, locale } = useI18n();
  const reasons = useQuery({
    queryKey: ["close-reasons", "lost"],
    queryFn: () => op<CloseReason[]>("close_reason.list", { kind: "lost" }),
  });
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (code) onConfirm(code, note.trim() || undefined);
  };
  return (
    <Modal title={`${t("closeAsLost")}: ${deal.title}`} onClose={onCancel} testId="lost-modal">
      <form onSubmit={submit} method="dialog">
        <Field label={t("closeReason")}>
          <select value={code} onChange={(e) => setCode(e.target.value)} required data-testid="lost-reason">
            <option value="">{t("chooseReason")}</option>
            {reasons.data?.map((r) => (
              <option key={r.code} value={r.code}>
                {locale === "km" ? r.label_km : r.label_en}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("note")}>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} data-testid="lost-note" />
        </Field>
        <div className="actions">
          <button type="button" onClick={onCancel} data-testid="lost-cancel">
            {t("cancel")}
          </button>
          <button className="danger" disabled={!code} data-testid="lost-confirm">
            {t("confirmLost")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NewDealModal({ me, onClose }: { me: Me; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const clients = useQuery({ queryKey: ["clients", ""], queryFn: () => op<ClientRow[]>("client.list", { limit: 200 }) });
  const [clientId, setClientId] = useState("");
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState<"USD" | "KHR">("USD");
  const [error, setError] = useState<unknown>(null);
  // Account leads (own scope) can only open deals on clients they lead.
  const anyScope = me.permissions["deal.manage"]?.includes("any");
  const options = clients.data?.filter((c) => anyScope || c.account_lead_id === me.id) ?? [];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const minor = value.trim() ? toMinor(value, currency) : null;
      await op("deal.create", { clientId, title, currency, expectedValueMinor: minor });
      await qc.invalidateQueries({ queryKey: ["deals"] });
      onClose();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Modal title={t("newDeal")} onClose={onClose} testId="new-deal-modal">
      <form onSubmit={submit}>
        <ErrorBanner error={error} />
        <Field label={t("clients")}>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} required data-testid="new-deal-client">
            <option value="" />
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("dealTitle")}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} data-testid="new-deal-title" />
        </Field>
        <div className="row">
          <Field label={t("expectedValue")}>
            <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} data-testid="new-deal-value" />
          </Field>
          <Field label={t("currency")}>
            <select value={currency} onChange={(e) => setCurrency(e.target.value as "USD" | "KHR")}>
              <option>USD</option>
              <option>KHR</option>
            </select>
          </Field>
        </div>
        <div className="actions">
          <button type="button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary" data-testid="new-deal-submit">
            {t("create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Decimal text → minor-unit string, without floats (shared parser, same as the server's rules). */
function toMinor(input: string, currency: "USD" | "KHR"): string {
  try {
    return parseMoney(input.replace(/៛/g, ""), currency).amountMinor.toString();
  } catch {
    throw new ApiError({ type: "", title: "", status: 422, code: "VALIDATION" });
  }
}
