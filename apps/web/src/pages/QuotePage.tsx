// Quote builder (specs/commercial/quote-builder.md). Live margin uses the SAME pricing function as the server
// (COM-QB-02); the server recalculates on every save and its figures win. Costs, margin and floors are shown only
// when the server returned them (COM-QB-04) — the UI never asks for or sends costs otherwise.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { formatBp, priceLine, priceQuote, type Currency, type PricingLineInput } from "@demoq/shared";
import { hasAnyScope, hasPerm, op, type Me } from "../api";
import { ErrorBanner, Field, Modal, QuoteStatusBadge } from "../components/ui";
import {
  bpToPercentInput,
  microsToRate,
  minorToInput,
  qtyMilliToInput,
  tryMoney,
  tryPercent,
  tryQty,
  type Parsed,
} from "../format";
import { useI18n } from "../i18n";
import { useEngagementTypes, useProjectTypes, useRateCard, useRateCards } from "../queries";
import { Link, navigate } from "../router";
import { AcceptQuoteModal } from "./AcceptQuote";
import type { BillingModel, DealDetail, Floors, LineKind, QuoteDetail, QuoteLine, QuoteStatus } from "../types";

/** "25.00%" → "25%", "18.50%" stays. */
const pct = (bp: number | null) => formatBp(bp).replace(/\.00%$/, "%");

export function QuotePage({ id, me }: { id: string; me: Me }) {
  const { t } = useI18n();
  const quote = useQuery({
    queryKey: ["quote", id],
    queryFn: () => op<QuoteDetail>("quote.get", { id }),
    refetchOnWindowFocus: false, // never clobber what someone is typing
  });
  const dealId = quote.data?.dealId;
  const deal = useQuery({
    queryKey: ["deal", dealId],
    enabled: !!dealId,
    queryFn: () => op<DealDetail>("deal.get", { id: dealId }),
  });
  const [flash, setFlash] = useState<string | null>(null);
  if (quote.error) return <ErrorBanner error={quote.error} />;
  if (!quote.data) return <p>{t("loading")}</p>;
  // Re-keyed on the server version: after every save/submit/send the editor restarts from the server's figures.
  return (
    <QuoteEditor
      key={`${quote.data.id}:${quote.data.version}`}
      quote={quote.data}
      deal={deal.data}
      me={me}
      flash={flash}
      setFlash={setFlash}
    />
  );
}

interface DraftLine {
  key: number;
  kind: LineKind;
  rateCardItemId: string | null;
  descriptionEn: string;
  descriptionKm: string | null;
  qty: string;
  unitPrice: string;
  unitCost: string;
  discount: string;
  perPeriod: boolean;
  quotedMinutes: number | null;
}
interface Header {
  title: string;
  engagementTypeId: string;
  projectTypeId: string;
  billingModel: BillingModel;
  months: string;
  validUntil: string;
  terms: string;
}

let keySeq = 1;
const fromServer = (l: QuoteLine, currency: Currency): DraftLine => ({
  key: keySeq++,
  kind: l.kind,
  rateCardItemId: l.rateCardItemId,
  descriptionEn: l.descriptionEn,
  descriptionKm: l.descriptionKm,
  qty: qtyMilliToInput(l.qtyMilli),
  unitPrice: minorToInput(l.unitPriceMinor, currency),
  unitCost: minorToInput(l.unitCostMinor, currency),
  discount: l.discountBp ? bpToPercentInput(l.discountBp) : "",
  perPeriod: l.perPeriod,
  quotedMinutes: l.quotedMinutes,
});
const blankLine = (kind: LineKind = "fee"): DraftLine => ({
  key: keySeq++,
  kind,
  rateCardItemId: null,
  descriptionEn: "",
  descriptionKm: null,
  qty: "1",
  unitPrice: "",
  unitCost: "",
  discount: "",
  perPeriod: false,
  quotedMinutes: null,
});
const snapshot = (h: Header, lines: DraftLine[]) => JSON.stringify([h, lines.map(({ key: _k, ...rest }) => rest)]);

interface ParsedLine {
  qty: Parsed<bigint>;
  price: Parsed<bigint>;
  cost: Parsed<bigint | null>;
  discount: Parsed<number>;
  descOk: boolean;
  valid: boolean;
}
function parseLine(l: DraftLine, currency: Currency, showCosts: boolean): ParsedLine {
  const qty = tryQty(l.qty);
  const price = tryMoney(l.unitPrice, currency);
  const cost: Parsed<bigint | null> =
    showCosts && l.unitCost.trim() !== "" ? tryMoney(l.unitCost, currency) : { ok: true, value: null };
  const discount = tryPercent(l.discount.trim());
  const descOk = l.descriptionEn.trim().length > 0;
  return { qty, price, cost, discount, descOk, valid: qty.ok && price.ok && cost.ok && discount.ok && descOk };
}

const EDITABLE_AFTER_SUBMIT: QuoteStatus[] = ["margin_review", "ready"];

function QuoteEditor({
  quote,
  deal,
  me,
  flash,
  setFlash,
}: {
  quote: QuoteDetail;
  deal: DealDetail | undefined;
  me: Me;
  flash: string | null;
  setFlash: (s: string | null) => void;
}) {
  const { t, money, date, label } = useI18n();
  const qc = useQueryClient();
  const ets = useEngagementTypes(me);
  const pts = useProjectTypes(me);
  const cards = useRateCards(me);
  const cardId = quote.rateCardId ?? cards.data?.find((c) => c.active && c.currency === quote.currency)?.id ?? null;
  const card = useRateCard(me, cardId);
  const cur = quote.currency;
  const showCosts = quote.costs !== null; // the server decides (COM-QB-04)
  const ro = !quote.canEdit;

  const initialHeader: Header = {
    title: quote.title,
    engagementTypeId: quote.engagementTypeId,
    projectTypeId: quote.projectTypeId ?? "",
    billingModel: quote.billingModel,
    months: quote.periodMonths ? String(quote.periodMonths) : "",
    validUntil: quote.validUntil ?? "",
    terms: quote.terms ?? "",
  };
  const [initial] = useState(() => {
    const lines = quote.lines.map((l) => fromServer(l, cur));
    return { header: initialHeader, lines, snap: snapshot(initialHeader, lines) };
  });
  const [header, setHeader] = useState<Header>(initial.header);
  const [lines, setLines] = useState<DraftLine[]>(initial.lines);
  const [sendOnApproval, setSendOnApproval] = useState(quote.sendOnApproval);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const dirty = !ro && snapshot(header, lines) !== initial.snap;

  // Floors of the engagement type selected right now (the list), else what the server sent for the saved one.
  const floors: Floors = useMemo(() => {
    const et = ets.data?.find((e) => e.id === header.engagementTypeId);
    if (et)
      return {
        feeMarginFloorBp: et.fee_margin_floor_bp,
        passthroughMarkupFloorBp: et.passthrough_markup_floor_bp,
        passthroughMarkupWarnBp: et.passthrough_markup_warn_bp,
      };
    return quote.floors ?? { feeMarginFloorBp: 2500, passthroughMarkupFloorBp: null, passthroughMarkupWarnBp: 1000 };
  }, [ets.data, header.engagementTypeId, quote.floors]);

  const itemCost = (itemId: string | null): bigint => {
    const c = itemId ? card.data?.items.find((i) => i.id === itemId)?.unit_cost_minor : null;
    return c ? BigInt(c) : 0n;
  };
  const parsed = lines.map((l) => parseLine(l, cur, showCosts));
  // rate_card.get hides costs from own-scope holders; a blank cost on such a line is filled in by the server on
  // save (COM-QB-13), so until then the live margin is unknown rather than wrong.
  const costPending =
    showCosts &&
    lines.some(
      (l) =>
        l.rateCardItemId && l.unitCost.trim() === "" && !card.data?.items.find((i) => i.id === l.rateCardItemId)?.unit_cost_minor,
    );
  const allValid = parsed.every((p) => p.valid);
  const monthsOk = header.billingModel === "one_off" || /^([1-9]|[12]\d|3[0-6])$/.test(header.months);
  const headerOk = header.title.trim().length > 0 && !!header.engagementTypeId && monthsOk;

  // Live figures on every keystroke, from valid lines only (COM-QB-02).
  const pricingInputs: (PricingLineInput | null)[] = lines.map((l, i) => {
    const p = parsed[i]!;
    if (!p.valid || !p.qty.ok || !p.price.ok || !p.cost.ok || !p.discount.ok) return null;
    return {
      kind: l.kind,
      qtyMilli: p.qty.value,
      unitPriceMinor: p.price.value,
      // Blank cost on a rate-card line → the item's cost, as the server does (COM-QB-13).
      unitCostMinor: p.cost.value ?? itemCost(l.rateCardItemId),
      discountBp: p.discount.value,
    };
  });
  const totals = priceQuote(
    pricingInputs.filter((x): x is PricingLineInput => x !== null),
    floors,
  );

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addFromCard = (itemId: string) => {
    const it = card.data?.items.find((x) => x.id === itemId);
    if (!it) return;
    setLines((ls) => [
      ...ls,
      {
        ...blankLine(it.kind),
        rateCardItemId: it.id,
        descriptionEn: it.label_en,
        descriptionKm: it.label_km,
        unitPrice: minorToInput(it.unit_price_minor, cur),
        unitCost: minorToInput(it.unit_cost_minor, cur),
      },
    ]);
  };

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["quote", quote.id] }),
      qc.invalidateQueries({ queryKey: ["quotes", quote.dealId] }),
      qc.invalidateQueries({ queryKey: ["approvals"] }),
      qc.invalidateQueries({ queryKey: ["deals"] }),
      qc.invalidateQueries({ queryKey: ["deal", quote.dealId] }),
    ]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setFlash(null);
    try {
      await fn();
      if (done) setFlash(done);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    op<{ version: number }>("quote.save", {
      id: quote.id,
      expectedVersion: quote.version,
      title: header.title,
      engagementTypeId: header.engagementTypeId,
      projectTypeId: header.projectTypeId || null,
      billingModel: header.billingModel,
      periodMonths: header.billingModel === "retainer" ? Number(header.months) : null,
      validUntil: header.validUntil || null,
      terms: header.terms,
      lines: lines.map((l, i) => {
        const p = parsed[i]!;
        const cost = p.cost.ok ? p.cost.value : null;
        return {
          kind: l.kind,
          rateCardItemId: l.rateCardItemId,
          descriptionEn: l.descriptionEn,
          descriptionKm: l.descriptionKm,
          qtyMilli: p.qty.ok ? Number(p.qty.value) : 0,
          unitPriceMinor: p.price.ok ? p.price.value.toString() : "0",
          // Only cost-holders send a cost; otherwise the server uses the rate-card cost (COM-QB-04/13).
          ...(showCosts && cost !== null ? { unitCostMinor: cost.toString() } : {}),
          discountBp: p.discount.ok ? p.discount.value : 0,
          perPeriod: l.perPeriod,
          quotedMinutes: l.quotedMinutes,
        };
      }),
    });

  const onSave = (e?: FormEvent) => {
    e?.preventDefault();
    if (!allValid || !headerOk) return setError(null);
    void run(save, t("saved"));
  };
  const onSubmit = () =>
    run(async () => {
      const version = dirty ? (await save()).version : quote.version;
      await op("quote.submit", { id: quote.id, expectedVersion: version, sendOnApproval });
    });
  const onSend = () => run(() => op("quote.send", { id: quote.id, expectedVersion: quote.version }));
  const onRevise = () =>
    run(async () => {
      const r = await op<{ id: string }>("quote.revise", { id: quote.id });
      navigate(`/quotes/${r.id}`);
    });
  const onReject = (reason: string) =>
    run(() => op("quote.mark_rejected", { id: quote.id, expectedVersion: quote.version, reason }));

  const mayEditDeal = hasPerm(me, "quote.edit") && (hasAnyScope(me, "quote.edit") || quote.ownerId === me.id);
  const canSubmit = quote.status === "draft" && quote.canEdit && hasPerm(me, "quote.submit");
  const canRevise = ["sent", "rejected", "expired"].includes(quote.status) && mayEditDeal;
  const canMarkRejected = quote.status === "sent" && mayEditDeal;
  // COM-AC-06: the deal owner (own) or ops_lead (any); the server re-checks.
  const canAccept =
    quote.status === "sent" &&
    hasPerm(me, "quote.accept") &&
    (hasAnyScope(me, "quote.accept") || (deal?.owner_id ?? quote.ownerId) === me.id);
  const locked = ["sent", "accepted", "rejected", "expired", "superseded"].includes(quote.status);
  const etOptions = ets.data?.filter((e) => e.active || e.id === header.engagementTypeId) ?? [];
  const etName = (() => {
    const et = ets.data?.find((e) => e.id === header.engagementTypeId);
    return et ? label(et.label_en, et.label_km) : (quote.floors?.label ?? t("none"));
  })();

  return (
    <section className="quote-page" data-testid="quote-page">
      <p className="muted small">
        <Link to="/pipeline">{t("backToPipeline")}</Link>
        {deal && ` · ${deal.title}`}
      </p>
      <div className="toolbar">
        <h1 data-testid="quote-title">{quote.title}</h1>
        <QuoteStatusBadge status={quote.status} testId="quote-status" />
        <span className="tag" data-testid="quote-version">
          {t("versionNo", { n: String(quote.versionNo) })}
        </span>
        {quote.approval && (
          <span
            className={`tag approval-${quote.approval.status}`}
            data-testid="approval-status"
            data-status={quote.approval.status}
          >
            {t("approval")}: {t(`approvalStatus.${quote.approval.status}`)}
          </span>
        )}
      </div>
      <p className="muted">
        {t("client")}: <strong data-testid="quote-client">{deal?.client_name ?? "…"}</strong> · {t("currency")}: {cur}
        {quote.sentAt && ` · ${t("sentOn", { when: date(quote.sentAt) })}`}
        {quote.sentAt &&
          cur === "KHR" &&
          quote.fxRateMicros &&
          quote.fxRateDate &&
          ` · ${t("fxFrozen", { rate: microsToRate(quote.fxRateMicros), date: quote.fxRateDate })}`}
      </p>
      {locked && (
        <p className="notice" data-testid="quote-locked">
          {t("lockedNotice")}
        </p>
      )}
      {quote.rejectedReason && (
        <p className="muted">
          {t("clientRejected")}: {quote.rejectedReason}
        </p>
      )}
      {flash && !dirty && (
        <p className="ok" role="status" data-testid="quote-flash">
          {flash}
        </p>
      )}
      <ErrorBanner error={error} />

      <form onSubmit={onSave} className="card quote-form">
        <div className="row">
          <Field label={t("quoteTitle")}>
            {ro ? (
              <span>{quote.title}</span>
            ) : (
              <input
                value={header.title}
                onChange={(e) => setHeader({ ...header, title: e.target.value })}
                maxLength={200}
                required
                data-testid="quote-title-input"
              />
            )}
          </Field>
          <Field label={t("engagementType")}>
            {ro ? (
              <span data-testid="quote-engagement-type-text">{etName}</span>
            ) : (
              <select
                value={header.engagementTypeId}
                onChange={(e) => setHeader({ ...header, engagementTypeId: e.target.value })}
                data-testid="quote-engagement-type"
              >
                {etOptions.map((et) => (
                  <option key={et.id} value={et.id}>
                    {label(et.label_en, et.label_km)}
                    {showCosts ? ` (${t("floor", { floor: pct(et.fee_margin_floor_bp) })})` : ""}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t("projectType")}>
            {ro ? (
              <span>
                {(() => {
                  const p = pts.data?.find((x) => x.id === quote.projectTypeId);
                  return p ? label(p.label_en, p.label_km) : t("none");
                })()}
              </span>
            ) : (
              <select
                value={header.projectTypeId}
                onChange={(e) => setHeader({ ...header, projectTypeId: e.target.value })}
                data-testid="quote-project-type"
              >
                <option value="">{t("none")}</option>
                {pts.data
                  ?.filter((p) => p.active || p.id === header.projectTypeId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {label(p.label_en, p.label_km)}
                    </option>
                  ))}
              </select>
            )}
          </Field>
        </div>
        <div className="row">
          <Field label={t("currency")}>
            <span data-testid="quote-currency">{cur}</span>
          </Field>
          <Field label={t("billingModel")}>
            {ro ? (
              <span>
                {t(`billing.${quote.billingModel}`)}
                {quote.periodMonths ? ` × ${quote.periodMonths} ${t("months")}` : ""}
              </span>
            ) : (
              <select
                value={header.billingModel}
                onChange={(e) =>
                  setHeader({
                    ...header,
                    billingModel: e.target.value as BillingModel,
                    months: e.target.value === "retainer" ? header.months || "6" : "",
                  })
                }
                data-testid="quote-billing"
              >
                <option value="one_off">{t("billing.one_off")}</option>
                <option value="retainer">{t("billing.retainer")}</option>
              </select>
            )}
          </Field>
          {!ro && header.billingModel === "retainer" && (
            <Field label={t("months")}>
              <input
                type="number"
                min={1}
                max={36}
                value={header.months}
                onChange={(e) => setHeader({ ...header, months: e.target.value })}
                aria-invalid={!monthsOk}
                data-testid="quote-months"
              />
            </Field>
          )}
          <Field label={t("validUntil")}>
            {ro ? (
              <span>{quote.validUntil ?? t("none")}</span>
            ) : (
              <input
                type="date"
                value={header.validUntil}
                onChange={(e) => setHeader({ ...header, validUntil: e.target.value })}
                data-testid="quote-valid-until"
              />
            )}
          </Field>
        </div>

        <h2>{t("lines")}</h2>
        <div className="table-scroll">
          <table className="table lines" data-testid="quote-lines">
            <thead>
              <tr>
                <th>{t("kind")}</th>
                <th>{t("description")}</th>
                <th className="num">{t("qty")}</th>
                <th className="num">{t("unitPrice")}</th>
                {showCosts && (
                  <th className="num" data-testid="cost-header">
                    {t("unitCost")}
                  </th>
                )}
                <th className="num">{t("discountPct")}</th>
                <th className="num">{t("lineTotal")}</th>
                {!ro && <th />}
              </tr>
            </thead>
            <tbody>
              {ro
                ? quote.lines.map((l, i) => (
                    <tr key={i} data-testid={`line-${i}`}>
                      <td>{t(`kind.${l.kind}`)}</td>
                      <td>
                        {label(l.descriptionEn, l.descriptionKm)}
                        {l.serviceCode && <span className="tag">{l.serviceCode}</span>}
                      </td>
                      <td className="num">{qtyMilliToInput(l.qtyMilli)}</td>
                      <td className="num">{money(l.unitPriceMinor, cur)}</td>
                      {showCosts && (
                        <td className="num" data-testid={`line-cost-${i}`}>
                          {money(l.unitCostMinor, cur)}
                        </td>
                      )}
                      <td className="num">{l.discountBp ? pct(l.discountBp) : ""}</td>
                      <td className="num" data-testid={`line-total-${i}`}>
                        {money(l.linePriceMinor, cur)}
                      </td>
                    </tr>
                  ))
                : lines.map((l, i) => {
                    const p = parsed[i]!;
                    const input = pricingInputs[i];
                    return (
                      <tr key={l.key} data-testid={`line-${i}`}>
                        <td>
                          <select
                            value={l.kind}
                            onChange={(e) => setLine(i, { kind: e.target.value as LineKind })}
                            aria-label={t("kind")}
                            data-testid={`line-kind-${i}`}
                          >
                            <option value="fee">{t("kind.fee")}</option>
                            <option value="pass_through">{t("kind.pass_through")}</option>
                          </select>
                        </td>
                        <td>
                          <input
                            value={l.descriptionEn}
                            onChange={(e) => setLine(i, { descriptionEn: e.target.value })}
                            maxLength={500}
                            aria-label={t("description")}
                            aria-invalid={!p.descOk}
                            data-testid={`line-desc-${i}`}
                          />
                        </td>
                        <td className="num">
                          <input
                            className="num"
                            inputMode="decimal"
                            value={l.qty}
                            onChange={(e) => setLine(i, { qty: e.target.value })}
                            aria-label={t("qty")}
                            aria-invalid={!p.qty.ok}
                            data-testid={`line-qty-${i}`}
                          />
                        </td>
                        <td className="num">
                          <input
                            className="num"
                            inputMode="decimal"
                            value={l.unitPrice}
                            onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                            aria-label={t("unitPrice")}
                            aria-invalid={!p.price.ok}
                            data-testid={`line-price-${i}`}
                          />
                        </td>
                        {showCosts && (
                          <td className="num">
                            <input
                              className="num"
                              inputMode="decimal"
                              value={l.unitCost}
                              onChange={(e) => setLine(i, { unitCost: e.target.value })}
                              aria-label={t("unitCost")}
                              placeholder={l.rateCardItemId ? t("fromRateCard") : "0"}
                              aria-invalid={!p.cost.ok}
                              data-testid={`line-cost-${i}`}
                            />
                          </td>
                        )}
                        <td className="num">
                          <input
                            className="num short"
                            inputMode="decimal"
                            value={l.discount}
                            onChange={(e) => setLine(i, { discount: e.target.value })}
                            aria-label={t("discountPct")}
                            aria-invalid={!p.discount.ok}
                            placeholder="0"
                            data-testid={`line-discount-${i}`}
                          />
                        </td>
                        <td className="num" data-testid={`line-total-${i}`}>
                          {input ? money(priceLine(input).priceMinor.toString(), cur) : "—"}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="link"
                            onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                            data-testid={`line-remove-${i}`}
                          >
                            {t("remove")}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
        {!ro && (
          <div className="row line-tools">
            <button type="button" onClick={() => setLines((ls) => [...ls, blankLine()])} data-testid="add-line">
              {t("addLine")}
            </button>
            {card.data && card.data.items.some((it) => it.active) && (
              <select
                value=""
                onChange={(e) => addFromCard(e.target.value)}
                data-testid="rate-card-pick"
                aria-label={t("addFromRateCard")}
              >
                <option value="">{t("addFromRateCard")}</option>
                {card.data.items
                  .filter((it) => it.active)
                  .map((it) => (
                    <option key={it.id} value={it.id}>
                      {`${it.service_code} — ${label(it.label_en, it.label_km)} (${money(it.unit_price_minor, cur)} / ${t(`unit.${it.unit}`)})`}
                    </option>
                  ))}
              </select>
            )}
          </div>
        )}
        {!allValid && <p className="error small">{t("checkFields")}</p>}

        <Summary
          ro={ro}
          quote={quote}
          totals={totals}
          floors={floors}
          showCosts={showCosts}
          etName={etName}
          liveKinds={pricingInputs.flatMap((x) => (x ? [x.kind] : []))}
          costPending={costPending}
        />
        {!ro && <p className="muted small">{t("liveHint")}</p>}

        {!ro && (
          <Field label={t("terms")}>
            <textarea
              rows={3}
              maxLength={4000}
              value={header.terms}
              onChange={(e) => setHeader({ ...header, terms: e.target.value })}
              data-testid="quote-terms"
            />
          </Field>
        )}
        {ro && quote.terms && (
          <p className="terms">
            <strong>{t("terms")}:</strong> {quote.terms}
          </p>
        )}

        {dirty && EDITABLE_AFTER_SUBMIT.includes(quote.status) && <p className="notice small">{t("editResetsHint")}</p>}
        <div className="actions wrap">
          {dirty && <span className="muted small unsaved">{t("unsaved")}</span>}
          {!ro && (
            <button type="submit" disabled={busy || !dirty || !allValid || !headerOk} data-testid="save-quote">
              {t("save")}
            </button>
          )}
          {canSubmit && (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={sendOnApproval}
                  onChange={(e) => setSendOnApproval(e.target.checked)}
                  data-testid="send-on-approval"
                />
                {t("sendOnApproval")}
              </label>
              <button
                type="button"
                className="primary"
                disabled={busy || !allValid || !headerOk || lines.length === 0}
                onClick={onSubmit}
                data-testid="submit-quote"
              >
                {t("submit")}
              </button>
            </>
          )}
          {quote.canSend && (
            <button type="button" className="primary" disabled={busy || dirty} onClick={onSend} data-testid="send-quote">
              {t("send")}
            </button>
          )}
          {canAccept && (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => setAccepting(true)}
              data-testid="accept-quote"
            >
              {t("acceptQuote")}
            </button>
          )}
          {canRevise && (
            <button type="button" disabled={busy} onClick={onRevise} data-testid="revise-quote">
              {t("revise")}
            </button>
          )}
          {canMarkRejected && (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => setRejecting(true)}
              data-testid="mark-rejected"
            >
              {t("markRejected")}
            </button>
          )}
        </div>
      </form>
      {accepting && <AcceptQuoteModal quote={quote} me={me} onClose={() => setAccepting(false)} />}
      {rejecting && (
        <RejectModal
          onCancel={() => setRejecting(false)}
          onConfirm={(reason) => {
            setRejecting(false);
            void onReject(reason);
          }}
        />
      )}
    </section>
  );
}

function Summary({
  ro,
  quote,
  totals,
  floors,
  showCosts,
  etName,
  liveKinds,
  costPending,
}: {
  ro: boolean;
  quote: QuoteDetail;
  totals: ReturnType<typeof priceQuote>;
  liveKinds: LineKind[];
  costPending: boolean;
  floors: Floors;
  showCosts: boolean;
  etName: string;
}) {
  const { t, money } = useI18n();
  const cur = quote.currency;
  // Locked quotes show the server's stored figures; editable ones the live figures.
  const fig = ro
    ? {
        fee: quote.feePriceMinor,
        pt: quote.ptPriceMinor,
        discount: quote.discountMinor,
        total: quote.totalMinor,
        feeMarginBp: quote.costs?.feeMarginBp ?? null,
        ptMarkupBp: quote.costs?.ptMarkupBp ?? null,
      }
    : {
        fee: totals.feePriceMinor.toString(),
        pt: totals.ptPriceMinor.toString(),
        discount: totals.discountMinor.toString(),
        total: totals.totalMinor.toString(),
        feeMarginBp: totals.feeMarginBp,
        ptMarkupBp: totals.ptMarkupBp,
      };
  const kinds = new Set(ro ? quote.lines.map((l) => l.kind) : liveKinds);
  const hasFees = kinds.has("fee");
  const hasPt = kinds.has("pass_through");
  const live = !ro && !costPending;
  const belowFee = live && totals.belowFeeFloor;
  const belowMarkup = live && totals.belowMarkupFloor;
  const warnMarkup = live && totals.markupWarning && !totals.belowMarkupFloor;
  const shown = (bp: number | null) => (costPending && !ro ? "—" : formatBp(bp));

  return (
    <div className="summary" data-testid="quote-summary">
      <dl className="figures">
        <div>
          <dt>{t("fees")}</dt>
          <dd data-testid="fee-total">{money(fig.fee, cur)}</dd>
        </div>
        {hasPt && (
          <div>
            <dt>{t("passThrough")}</dt>
            <dd data-testid="pt-total">{money(fig.pt, cur)}</dd>
          </div>
        )}
        {fig.discount !== "0" && (
          <div>
            <dt>{t("discounts")}</dt>
            <dd>−{money(fig.discount, cur)}</dd>
          </div>
        )}
        <div className="grand">
          <dt>{t("total")}</dt>
          <dd data-testid="quote-total">{money(fig.total, cur)}</dd>
        </div>
        {showCosts && hasFees && (
          <div className={belowFee ? "bad" : ""}>
            <dt>{t("feeMargin")}</dt>
            <dd data-testid="fee-margin">{shown(fig.feeMarginBp)}</dd>
            <dd className="muted small">
              {etName} · {t("floor", { floor: pct(floors.feeMarginFloorBp) })}
            </dd>
          </div>
        )}
        {showCosts && hasPt && (
          <div className={belowMarkup ? "bad" : ""}>
            <dt>{t("ptMarkup")}</dt>
            <dd data-testid="pt-markup">{shown(fig.ptMarkupBp)}</dd>
            {floors.passthroughMarkupFloorBp !== null && (
              <dd className="muted small">{t("floor", { floor: pct(floors.passthroughMarkupFloorBp) })}</dd>
            )}
          </div>
        )}
      </dl>
      {showCosts && costPending && !ro && (
        <p className="muted small" data-testid="cost-pending">
          {t("costOnSave")}
        </p>
      )}
      {showCosts && belowFee && (
        <p className="warning" role="alert" data-testid="below-floor-warning">
          {t("belowFloor", { floor: pct(floors.feeMarginFloorBp) })}
        </p>
      )}
      {showCosts && belowMarkup && (
        <p className="warning" role="alert" data-testid="markup-floor-warning">
          {t("belowMarkupFloor", { floor: pct(floors.passthroughMarkupFloorBp) })}
        </p>
      )}
      {showCosts && warnMarkup && (
        <p className="notice small" data-testid="markup-warning">
          {t("markupWarning", { warn: pct(floors.passthroughMarkupWarnBp) })}
        </p>
      )}
    </div>
  );
}

function RejectModal({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: (reason: string) => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  return (
    <Modal title={t("markRejected")} onClose={onCancel} testId="reject-modal">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim()) onConfirm(reason.trim());
        }}
      >
        <Field label={t("rejectReason")}>
          <textarea
            rows={3}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            data-testid="reject-reason"
          />
        </Field>
        <div className="actions">
          <button type="button" onClick={onCancel}>
            {t("cancel")}
          </button>
          <button className="danger" disabled={!reason.trim()} data-testid="reject-confirm">
            {t("markRejected")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
