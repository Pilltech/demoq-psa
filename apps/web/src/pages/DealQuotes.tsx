// The quotes on a deal (in the deal drawer): every version, and "New quote" for whoever may edit it.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { hasAnyScope, hasPerm, op, type Me } from "../api";
import { ErrorBanner, Field, QuoteStatusBadge } from "../components/ui";
import { useI18n } from "../i18n";
import { useEngagementTypes, useProjectTypes, useRateCards } from "../queries";
import { Link, navigate } from "../router";
import type { BillingModel, Currency, DealDetail, QuoteSummary } from "../types";

export function DealQuotes({ deal, me }: { deal: DealDetail; me: Me }) {
  const { t, money } = useI18n();
  const quotes = useQuery({
    queryKey: ["quotes", deal.id],
    queryFn: () => op<QuoteSummary[]>("quote.list", { dealId: deal.id }),
  });
  const [creating, setCreating] = useState(false);
  const open = deal.stage !== "won" && deal.stage !== "lost";
  // quote.create is scoped to the deal owner (own) or any deal (ops); the server re-checks.
  const canCreate = open && hasPerm(me, "quote.edit") && (hasAnyScope(me, "quote.edit") || deal.owner_id === me.id);

  return (
    <div className="deal-quotes">
      <div className="toolbar compact">
        <h3>{t("quotes")}</h3>
        {canCreate && !creating && (
          <button className="primary" onClick={() => setCreating(true)} data-testid="new-quote">
            {t("newQuote")}
          </button>
        )}
      </div>
      <ErrorBanner error={quotes.error} />
      {quotes.data && quotes.data.length === 0 && !creating && <p className="muted small">{t("noItems")}</p>}
      <ul className="list" data-testid="deal-quotes">
        {quotes.data?.map((q) => (
          <li key={q.id} className="quote-row">
            <Link to={`/quotes/${q.id}`} testId={`quote-link-${q.id}`}>
              {t("versionNo", { n: String(q.versionNo) })} · {q.title}
            </Link>
            <QuoteStatusBadge status={q.status} />
            <span className="muted small">{money(q.totalMinor, q.currency)}</span>
          </li>
        ))}
      </ul>
      {creating && <NewQuoteForm deal={deal} me={me} onCancel={() => setCreating(false)} />}
    </div>
  );
}

function NewQuoteForm({ deal, me, onCancel }: { deal: DealDetail; me: Me; onCancel: () => void }) {
  const { t, label } = useI18n();
  const qc = useQueryClient();
  const ets = useEngagementTypes(me);
  const pts = useProjectTypes(me);
  const cards = useRateCards(me);
  const [title, setTitle] = useState(deal.title);
  const [engagementTypeId, setEngagementTypeId] = useState("");
  const [projectTypeId, setProjectTypeId] = useState("");
  const [currency, setCurrency] = useState<Currency>(deal.currency);
  const [billingModel, setBillingModel] = useState<BillingModel>("one_off");
  const [months, setMonths] = useState("6");
  // null = not chosen yet: default to the first active card in this currency.
  const [rateCardChoice, setRateCardId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const activeEts = ets.data?.filter((e) => e.active) ?? [];
  const etId = engagementTypeId || activeEts[0]?.id || "";
  const cardOptions = cards.data?.filter((c) => c.active && c.currency === currency) ?? [];
  const rateCardId = rateCardChoice ?? cardOptions[0]?.id ?? "";

  const onProjectType = (id: string) => {
    setProjectTypeId(id);
    const def = pts.data?.find((p) => p.id === id)?.default_engagement_type_id;
    if (def) setEngagementTypeId(def);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await op<{ id: string }>("quote.create", {
        dealId: deal.id,
        title,
        currency,
        engagementTypeId: etId,
        projectTypeId: projectTypeId || null,
        rateCardId: rateCardId || null,
        billingModel,
        periodMonths: billingModel === "retainer" ? Number(months) : null,
      });
      await qc.invalidateQueries({ queryKey: ["quotes", deal.id] });
      navigate(`/quotes/${r.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form className="inline-form" onSubmit={submit} data-testid="new-quote-form">
      <ErrorBanner error={error} />
      <Field label={t("quoteTitle")}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} data-testid="new-quote-title" />
      </Field>
      <div className="row">
        <Field label={t("projectType")}>
          <select value={projectTypeId} onChange={(e) => onProjectType(e.target.value)} data-testid="new-quote-project-type">
            <option value="">{t("none")}</option>
            {pts.data
              ?.filter((p) => p.active)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {label(p.label_en, p.label_km)}
                </option>
              ))}
          </select>
        </Field>
        <Field label={t("engagementType")}>
          <select
            value={etId}
            onChange={(e) => setEngagementTypeId(e.target.value)}
            required
            data-testid="new-quote-engagement-type"
          >
            {activeEts.map((et) => (
              <option key={et.id} value={et.id}>
                {label(et.label_en, et.label_km)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="row">
        <Field label={t("currency")}>
          <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)} data-testid="new-quote-currency">
            <option>USD</option>
            <option>KHR</option>
          </select>
        </Field>
        <Field label={t("billingModel")}>
          <select
            value={billingModel}
            onChange={(e) => setBillingModel(e.target.value as BillingModel)}
            data-testid="new-quote-billing"
          >
            <option value="one_off">{t("billing.one_off")}</option>
            <option value="retainer">{t("billing.retainer")}</option>
          </select>
        </Field>
        {billingModel === "retainer" && (
          <Field label={t("months")}>
            <input
              type="number"
              min={1}
              max={36}
              value={months}
              onChange={(e) => setMonths(e.target.value)}
              required
              data-testid="new-quote-months"
            />
          </Field>
        )}
      </div>
      <Field label={t("rateCard")}>
        <select value={rateCardId} onChange={(e) => setRateCardId(e.target.value)} data-testid="new-quote-rate-card">
          <option value="">{t("none")}</option>
          {cardOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="actions">
        <button type="button" onClick={onCancel}>
          {t("cancel")}
        </button>
        <button className="primary" disabled={busy || !etId} data-testid="new-quote-submit">
          {t("create")}
        </button>
      </div>
    </form>
  );
}
