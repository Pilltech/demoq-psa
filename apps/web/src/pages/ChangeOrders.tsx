// Change orders (specs/commercial/change-orders.md): additive changes to a project's scope. The builder follows the
// quote builder: lines from the project's rate card or custom, live figures from the SAME pricing function as the
// server (priceQuote), and cost, margin and floor only when the server returned costs (COM-QB-04).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { formatBp, priceLine, priceQuote, type Currency, type PricingLineInput } from "@demoq/shared";
import { hasPerm, op, type Me } from "../api";
import { CoStatusBadge, ErrorBanner, Field } from "../components/ui";
import {
  bpToPercentInput,
  minorToInput,
  minutesToHoursInput,
  parseHours,
  qtyMilliToInput,
  tryMoney,
  tryPercent,
  tryQty,
  type Parsed,
} from "../format";
import { useI18n } from "../i18n";
import { useEngagementTypes, useProjectRefresh, useRateCard, useScope } from "../queries";
import { Link, navigate } from "../router";
import type { ChangeOrder, ChangeOrderDetail, ChangeOrderLine, Floors, LineKind, ProjectDetail, QuoteDetail } from "../types";

const pct = (bp: number | null) => formatBp(bp).replace(/\.00%$/, "%");
const OPEN = ["gated", "active", "on_hold"];
const EDITABLE = ["draft", "margin_review", "ready", "submitted"];

export function ChangeOrders({ project, me, coId }: { project: ProjectDetail; me: Me; coId?: string }) {
  if (coId) return <ChangeOrderPage key={coId} project={project} coId={coId} me={me} />;
  return <ChangeOrderList project={project} me={me} />;
}

function ChangeOrderList({ project, me }: { project: ProjectDetail; me: Me }) {
  const { t, money, date } = useI18n();
  const list = useQuery({
    queryKey: ["change-orders", project.id],
    queryFn: () => op<ChangeOrder[]>("change_order.list", { projectId: project.id }),
  });
  const [creating, setCreating] = useState(false);
  // COM-CO-06: account lead (own), PM (assigned), ops (any); the server re-checks the scope.
  const canCreate = hasPerm(me, "change_order.manage") && OPEN.includes(project.status);
  return (
    <div className="card" data-testid="change-orders">
      <div className="toolbar compact">
        <h2>{t("changeOrders")}</h2>
        {canCreate && !creating && (
          <button className="primary" onClick={() => setCreating(true)} data-testid="co-new">
            {t("newChangeOrder")}
          </button>
        )}
      </div>
      <p className="muted small">{t("coHelp")}</p>
      <ErrorBanner error={list.error} />
      {list.data && list.data.length === 0 && !creating && <p className="muted small">{t("noItems")}</p>}
      <ul className="list" data-testid="co-list">
        {list.data?.map((co) => (
          <li key={co.id} className="quote-row" data-testid={`co-row-${co.number}`}>
            <Link to={`/projects/${project.id}/change-orders/${co.id}`} testId="co-link">
              {t("coNumber", { n: String(co.number) })} · {co.title}
            </Link>
            <CoStatusBadge status={co.status} />
            <span className="muted small">{money(co.totalMinor, co.currency)}</span>
            {co.acceptedAt && <span className="muted small">{t("acceptedOn", { when: date(co.acceptedAt) })}</span>}
          </li>
        ))}
      </ul>
      {creating && <NewChangeOrder project={project} onCancel={() => setCreating(false)} />}
    </div>
  );
}

function NewChangeOrder({ project, onCancel }: { project: ProjectDetail; onCancel: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const scope = useScope(project.id);
  const [title, setTitle] = useState("");
  const [periodId, setPeriodId] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const retainer = scope.data?.billingModel === "retainer";
  const periods = scope.data?.periods.filter((p) => p.status !== "closed") ?? [];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await op<{ id: string }>("change_order.create", {
        projectId: project.id,
        title: title.trim(),
        scopePeriodId: retainer ? periodId || null : null,
      });
      await qc.invalidateQueries({ queryKey: ["change-orders", project.id] });
      navigate(`/projects/${project.id}/change-orders/${r.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <form className="inline-form" onSubmit={submit} data-testid="co-new-form">
      <ErrorBanner error={error} />
      <Field label={t("coTitle")}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required data-testid="co-title" />
      </Field>
      {retainer && (
        <Field label={t("coPeriod")}>
          <select value={periodId} onChange={(e) => setPeriodId(e.target.value)} required data-testid="co-period">
            <option value="">{t("choosePeriod")}</option>
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {t("periodN", { n: String(p.period_no) })}: {p.period_start} – {p.period_end}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="actions">
        <button type="button" onClick={onCancel}>
          {t("cancel")}
        </button>
        <button className="primary" disabled={busy || !title.trim() || (retainer && !periodId)} data-testid="co-create">
          {t("create")}
        </button>
      </div>
    </form>
  );
}

function ChangeOrderPage({ project, coId, me }: { project: ProjectDetail; coId: string; me: Me }) {
  const { t } = useI18n();
  const co = useQuery({
    queryKey: ["change-order", coId],
    queryFn: () => op<ChangeOrderDetail>("change_order.get", { id: coId }),
    refetchOnWindowFocus: false, // never clobber what someone is typing
  });
  const [flash, setFlash] = useState<string | null>(null);
  if (co.error) return <ErrorBanner error={co.error} />;
  if (!co.data) return <p>{t("loading")}</p>;
  // Re-keyed on the server version: after every write the editor restarts from the server's figures.
  return (
    <CoEditor key={`${co.data.id}:${co.data.version}`} co={co.data} project={project} me={me} flash={flash} setFlash={setFlash} />
  );
}

interface DraftLine {
  key: number;
  kind: LineKind;
  rateCardItemId: string | null;
  /** change_order.get returns the service code, not the item id: the item is found again on the card. */
  serviceCode: string | null;
  descriptionEn: string;
  descriptionKm: string | null;
  qty: string;
  unitPrice: string;
  unitCost: string;
  discount: string;
  hours: string;
}
let keySeq = 1;
const minutesToHours = minutesToHoursInput;
const blankLine = (kind: LineKind = "fee"): DraftLine => ({
  key: keySeq++,
  kind,
  rateCardItemId: null,
  serviceCode: null,
  descriptionEn: "",
  descriptionKm: null,
  qty: "1",
  unitPrice: "",
  unitCost: "",
  discount: "",
  hours: "",
});
const snapshot = (title: string, lines: DraftLine[]) => JSON.stringify([title, lines.map(({ key: _k, ...rest }) => rest)]);

function CoEditor({
  co,
  project,
  me,
  flash,
  setFlash,
}: {
  co: ChangeOrderDetail;
  project: ProjectDetail;
  me: Me;
  flash: string | null;
  setFlash: (s: string | null) => void;
}) {
  const { t, money, label } = useI18n();
  const qc = useQueryClient();
  const refreshProject = useProjectRefresh(project.id);
  const cur: Currency = co.currency;
  const showCosts = co.costs !== null; // the server decides (COM-QB-04)
  const ro = !co.canEdit;

  // Lines come from the rate card of the accepted quote (the server refuses items from any other card).
  const quote = useQuery({
    queryKey: ["quote", project.quote_id],
    enabled: !!project.quote_id && hasPerm(me, "deal.view"),
    queryFn: () => op<QuoteDetail>("quote.get", { id: project.quote_id }),
  });
  const card = useRateCard(me, quote.data?.rateCardId ?? null);
  const ets = useEngagementTypes(me);
  const floors: Floors = useMemo(() => {
    const et = ets.data?.find((e) => e.id === project.engagement_type_id);
    return et
      ? {
          feeMarginFloorBp: et.fee_margin_floor_bp,
          passthroughMarkupFloorBp: et.passthrough_markup_floor_bp,
          passthroughMarkupWarnBp: et.passthrough_markup_warn_bp,
        }
      : { feeMarginFloorBp: 2500, passthroughMarkupFloorBp: null, passthroughMarkupWarnBp: 1000 };
  }, [ets.data, project.engagement_type_id]);

  const fromServer = (l: ChangeOrderLine): DraftLine => ({
    key: keySeq++,
    kind: l.kind,
    rateCardItemId: null,
    serviceCode: l.serviceCode,
    descriptionEn: l.descriptionEn,
    descriptionKm: l.descriptionKm,
    qty: qtyMilliToInput(l.qtyMilli),
    unitPrice: minorToInput(l.unitPriceMinor, cur),
    unitCost: minorToInput(l.unitCostMinor, cur),
    discount: l.discountBp ? bpToPercentInput(l.discountBp) : "",
    hours: minutesToHours(l.quotedMinutes),
  });
  const [initial] = useState(() => {
    const lines = co.lines.map(fromServer);
    return { lines, snap: snapshot(co.title, lines) };
  });
  const [title, setTitle] = useState(co.title);
  const [lines, setLines] = useState<DraftLine[]>(initial.lines);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const dirty = !ro && snapshot(title, lines) !== initial.snap;

  const itemIdOf = (l: DraftLine): string | null =>
    l.rateCardItemId ?? ((l.serviceCode && card.data?.items.find((i) => i.service_code === l.serviceCode)?.id) || null);
  const itemCost = (itemId: string | null): bigint => {
    const c = itemId ? card.data?.items.find((i) => i.id === itemId)?.unit_cost_minor : null;
    return c ? BigInt(c) : 0n;
  };
  const parsed = lines.map((l) => {
    const qty = tryQty(l.qty);
    const price = tryMoney(l.unitPrice, cur);
    const cost: Parsed<bigint | null> =
      showCosts && l.unitCost.trim() !== "" ? tryMoney(l.unitCost, cur) : { ok: true, value: null };
    const discount = tryPercent(l.discount.trim());
    const minutes = l.hours.trim() === "" ? null : parseHours(l.hours);
    const descOk = l.descriptionEn.trim().length > 0;
    const hoursOk = l.hours.trim() === "" || minutes !== null;
    return {
      qty,
      price,
      cost,
      discount,
      minutes,
      descOk,
      hoursOk,
      valid: qty.ok && price.ok && cost.ok && discount.ok && descOk && hoursOk,
    };
  });
  const allValid = parsed.every((p) => p.valid);
  // rate_card.get hides costs from own-scope holders; a blank cost on such a line is filled in by the server on
  // save (the rate-card cost), so until then the live margin is unknown rather than wrong.
  const costPending =
    showCosts &&
    lines.some((l) => {
      const id = itemIdOf(l);
      return !!id && l.unitCost.trim() === "" && !card.data?.items.find((i) => i.id === id)?.unit_cost_minor;
    });
  const pricingInputs: (PricingLineInput | null)[] = lines.map((l, i) => {
    const p = parsed[i]!;
    if (!p.valid || !p.qty.ok || !p.price.ok || !p.cost.ok || !p.discount.ok) return null;
    return {
      kind: l.kind,
      qtyMilli: p.qty.value,
      unitPriceMinor: p.price.value,
      unitCostMinor: p.cost.value ?? itemCost(itemIdOf(l)),
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
        serviceCode: it.service_code,
        descriptionEn: it.label_en,
        descriptionKm: it.label_km,
        unitPrice: minorToInput(it.unit_price_minor, cur),
        unitCost: minorToInput(it.unit_cost_minor, cur),
      },
    ]);
  };

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["change-order", co.id] }),
      qc.invalidateQueries({ queryKey: ["change-orders", project.id] }),
      refreshProject(),
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
    op<{ version: number }>("change_order.save", {
      id: co.id,
      expectedVersion: co.version,
      title: title.trim(),
      lines: lines.map((l, i) => {
        const p = parsed[i]!;
        const cost = p.cost.ok ? p.cost.value : null;
        return {
          kind: l.kind,
          rateCardItemId: itemIdOf(l),
          descriptionEn: l.descriptionEn,
          descriptionKm: l.descriptionKm,
          qtyMilli: p.qty.ok ? Number(p.qty.value) : 0,
          unitPriceMinor: p.price.ok ? p.price.value.toString() : "0",
          // Only cost-holders send a cost; otherwise the server uses the rate-card cost (D-CO-2).
          ...(showCosts && cost !== null ? { unitCostMinor: cost.toString() } : {}),
          discountBp: p.discount.ok ? p.discount.value : 0,
          quotedMinutes: p.minutes,
        };
      }),
    });
  const act = (name: "submit" | "send" | "accept" | "reject" | "void", done: string) =>
    run(async () => {
      const version = name === "submit" && dirty ? (await save()).version : co.version;
      await op(`change_order.${name}`, { id: co.id, expectedVersion: version });
    }, done);

  const st = co.status;
  const canManage = co.canManage;
  const headerOk = title.trim().length > 0;
  const kinds = new Set(pricingInputs.flatMap((x) => (x ? [x.kind] : [])));
  const fig = ro
    ? {
        fee: co.feePriceMinor,
        pt: co.ptPriceMinor,
        total: co.totalMinor,
        feeMarginBp: co.costs?.feeMarginBp ?? null,
        ptMarkupBp: co.costs?.ptMarkupBp ?? null,
      }
    : {
        fee: totals.feePriceMinor.toString(),
        pt: totals.ptPriceMinor.toString(),
        total: totals.totalMinor.toString(),
        feeMarginBp: totals.feeMarginBp,
        ptMarkupBp: totals.ptMarkupBp,
      };
  const roKinds = new Set(co.lines.map((l) => l.kind));
  const hasFees = ro ? roKinds.has("fee") : kinds.has("fee");
  const hasPt = ro ? roKinds.has("pass_through") : kinds.has("pass_through");
  const live = !ro && !costPending;
  const belowFee = live && totals.belowFeeFloor;
  const belowMarkup = live && totals.belowMarkupFloor;
  const shown = (bp: number | null) => (costPending && !ro ? "—" : formatBp(bp));

  return (
    <div className="card quote-form" data-testid="co-page">
      <p className="muted small">
        <Link to={`/projects/${project.id}/change-orders`}>{t("backToChangeOrders")}</Link>
      </p>
      <div className="toolbar">
        <h2 data-testid="co-heading">
          {t("coNumber", { n: String(co.number) })} · {co.title}
        </h2>
        <CoStatusBadge status={st} testId="co-status" />
      </div>
      {flash && !dirty && (
        <p className="ok" role="status" data-testid="co-flash">
          {flash}
        </p>
      )}
      <ErrorBanner error={error} />
      {!ro && (
        <Field label={t("coTitle")}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} data-testid="co-title-input" />
        </Field>
      )}
      <p className="muted small">{t("coAdditiveHint")}</p>
      <div className="table-scroll">
        <table className="table lines" data-testid="co-lines">
          <thead>
            <tr>
              <th>{t("kind")}</th>
              <th>{t("description")}</th>
              <th className="num">{t("qty")}</th>
              <th className="num">{t("unitPrice")}</th>
              {showCosts && (
                <th className="num" data-testid="co-cost-header">
                  {t("unitCost")}
                </th>
              )}
              <th className="num">{t("discountPct")}</th>
              <th className="num">{t("hoursShort")}</th>
              <th className="num">{t("lineTotal")}</th>
              {!ro && <th />}
            </tr>
          </thead>
          <tbody>
            {ro
              ? co.lines.map((l, i) => (
                  <tr key={i} data-testid={`co-line-${i}`}>
                    <td>{t(`kind.${l.kind}`)}</td>
                    <td>
                      {label(l.descriptionEn, l.descriptionKm)}
                      {l.serviceCode && <span className="tag">{l.serviceCode}</span>}
                    </td>
                    <td className="num">{qtyMilliToInput(l.qtyMilli)}</td>
                    <td className="num">{money(l.unitPriceMinor, cur)}</td>
                    {showCosts && <td className="num">{money(l.unitCostMinor, cur)}</td>}
                    <td className="num">{l.discountBp ? pct(l.discountBp) : ""}</td>
                    <td className="num">{minutesToHours(l.quotedMinutes)}</td>
                    <td className="num" data-testid={`co-line-total-${i}`}>
                      {money(l.linePriceMinor, cur)}
                    </td>
                  </tr>
                ))
              : lines.map((l, i) => {
                  const p = parsed[i]!;
                  const input = pricingInputs[i];
                  return (
                    <tr key={l.key} data-testid={`co-line-${i}`}>
                      <td>
                        <select
                          value={l.kind}
                          disabled={!!l.serviceCode}
                          onChange={(e) => setLine(i, { kind: e.target.value as LineKind })}
                          aria-label={t("kind")}
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
                          data-testid={`co-line-desc-${i}`}
                        />
                      </td>
                      <td className="num">
                        <input
                          className="num short"
                          inputMode="decimal"
                          value={l.qty}
                          onChange={(e) => setLine(i, { qty: e.target.value })}
                          aria-label={t("qty")}
                          aria-invalid={!p.qty.ok}
                          data-testid={`co-line-qty-${i}`}
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
                          data-testid={`co-line-price-${i}`}
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
                            placeholder={l.serviceCode ? t("fromRateCard") : "0"}
                            aria-invalid={!p.cost.ok}
                            data-testid={`co-line-cost-${i}`}
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
                        />
                      </td>
                      <td className="num">
                        <input
                          className="num short"
                          inputMode="decimal"
                          value={l.hours}
                          onChange={(e) => setLine(i, { hours: e.target.value })}
                          aria-label={t("hoursShort")}
                          aria-invalid={!p.hoursOk}
                          data-testid={`co-line-hours-${i}`}
                        />
                      </td>
                      <td className="num" data-testid={`co-line-total-${i}`}>
                        {input ? money(priceLine(input).priceMinor.toString(), cur) : "—"}
                      </td>
                      <td>
                        <button type="button" className="link" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
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
          {showCosts && (
            <button type="button" onClick={() => setLines((ls) => [...ls, blankLine()])} data-testid="co-add-line">
              {t("addLine")}
            </button>
          )}
          {card.data && card.data.items.some((it) => it.active) ? (
            <select
              value=""
              onChange={(e) => addFromCard(e.target.value)}
              data-testid="co-rate-card-pick"
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
          ) : (
            !showCosts && <p className="muted small">{t("coNoRateCard")}</p>
          )}
        </div>
      )}
      {!allValid && <p className="error small">{t("checkFields")}</p>}

      <div className="summary" data-testid="co-summary">
        <dl className="figures">
          <div>
            <dt>{t("fees")}</dt>
            <dd data-testid="co-fee-total">{money(fig.fee, cur)}</dd>
          </div>
          {hasPt && (
            <div>
              <dt>{t("passThrough")}</dt>
              <dd>{money(fig.pt, cur)}</dd>
            </div>
          )}
          <div className="grand">
            <dt>{t("total")}</dt>
            <dd data-testid="co-total">{money(fig.total, cur)}</dd>
          </div>
          {showCosts && hasFees && (
            <div className={belowFee ? "bad" : ""}>
              <dt>{t("feeMargin")}</dt>
              <dd data-testid="co-fee-margin">{shown(fig.feeMarginBp)}</dd>
              <dd className="muted small">{t("floor", { floor: pct(floors.feeMarginFloorBp) })}</dd>
            </div>
          )}
          {showCosts && hasPt && (
            <div className={belowMarkup ? "bad" : ""}>
              <dt>{t("ptMarkup")}</dt>
              <dd>{shown(fig.ptMarkupBp)}</dd>
            </div>
          )}
        </dl>
        {costPending && (
          <p className="muted small" data-testid="co-cost-pending">
            {t("costOnSave")}
          </p>
        )}
        {showCosts && belowFee && (
          <p className="warning" role="alert" data-testid="co-below-floor">
            {t("belowFloor", { floor: pct(floors.feeMarginFloorBp) })}
          </p>
        )}
        {showCosts && belowMarkup && (
          <p className="warning" role="alert">
            {t("belowMarkupFloor", { floor: pct(floors.passthroughMarkupFloorBp) })}
          </p>
        )}
      </div>
      {!ro && <p className="muted small">{t("liveHint")}</p>}
      {st === "margin_review" && <p className="notice small">{t("coMarginReview")}</p>}
      {st === "accepted" && <p className="ok small">{t("coAcceptedHint")}</p>}

      {canManage && (
        <div className="actions wrap">
          {dirty && <span className="muted small unsaved">{t("unsaved")}</span>}
          {!ro && (
            <button
              type="button"
              disabled={busy || !dirty || !allValid || !headerOk}
              onClick={() => void run(save, t("saved"))}
              data-testid="co-save"
            >
              {t("save")}
            </button>
          )}
          {st === "draft" && (
            <button
              type="button"
              className="primary"
              disabled={busy || !allValid || !headerOk || lines.length === 0}
              onClick={() => void act("submit", t("coSubmitted"))}
              data-testid="co-submit"
            >
              {t("submit")}
            </button>
          )}
          {(st === "ready" || st === "submitted") && (
            <button
              type="button"
              className="primary"
              disabled={busy || dirty}
              onClick={() => void act("send", t("coSent"))}
              data-testid="co-send"
            >
              {t("send")}
            </button>
          )}
          {st === "sent" && (
            <>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void act("reject", t("coRejected"))}
                data-testid="co-reject"
              >
                {t("coClientRejected")}
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void act("accept", t("coAccepted"))}
                data-testid="co-accept"
              >
                {t("coClientAccepted")}
              </button>
            </>
          )}
          {EDITABLE.includes(st) && (
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => void act("void", t("coVoided"))}
              data-testid="co-void"
            >
              {t("coVoid")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** /change-orders/:id (e.g. from an approval card): find the project and open the change order there. */
export function ChangeOrderRedirect({ id }: { id: string }) {
  const { t } = useI18n();
  const co = useQuery({ queryKey: ["change-order", id], queryFn: () => op<ChangeOrderDetail>("change_order.get", { id }) });
  const projectId = co.data?.projectId;
  useEffect(() => {
    if (projectId) navigate(`/projects/${projectId}/change-orders/${id}`);
  }, [projectId, id]);
  if (co.error) return <ErrorBanner error={co.error} />;
  return <p>{t("loading")}</p>;
}
