// Admin → Pricing (specs/commercial/pricing-config.md): engagement types and their floors, project types,
// rate cards and items. Only admin.config holders reach this page; the server re-checks every write.
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { hasPerm, op, type Me } from "../api";
import { ErrorBanner, Field } from "../components/ui";
import { bpToPercentInput, minorToInput, tryMoney, tryPercent } from "../format";
import { useI18n } from "../i18n";
import { useEngagementTypes, useProjectTypes, useRateCard, useRateCards } from "../queries";
import type { CommercialModel, Currency, EngagementType, LineKind, ProjectType, RateCardItem, Unit } from "../types";
import { AdminTabs } from "./Admin";

const MODELS: CommercialModel[] = ["campaign", "retainer", "one_off", "influencer_program"];
const UNITS: Unit[] = ["hour", "day", "item", "post", "month", "lump"];

export function Pricing({ me }: { me: Me }) {
  const { t } = useI18n();
  return (
    <section>
      <h1>{t("admin")}</h1>
      <AdminTabs me={me} />
      <div className="stack">
        <EngagementTypes me={me} />
        <ProjectTypes me={me} />
        <RateCards me={me} />
      </div>
    </section>
  );
}

/** Wraps a write: shows the server's error, refreshes the list on success. */
function useWrite(keys: string[][]) {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const write = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })));
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, write };
}

// ---- Engagement types -----------------------------------------------------------------------------

function EngagementTypes({ me }: { me: Me }) {
  const { t } = useI18n();
  const ets = useEngagementTypes(me);
  return (
    <div className="card">
      <h2>{t("engagementTypes")}</h2>
      <div className="table-scroll">
        <table className="table" data-testid="engagement-types">
          <thead>
            <tr>
              <th>{t("code")}</th>
              <th>{t("labelEn")}</th>
              <th>{t("labelKm")}</th>
              <th>{t("commercialModel")}</th>
              <th className="num">{t("feeFloorPct")}</th>
              <th className="num">{t("ptFloorPct")}</th>
              <th className="num">{t("ptWarnPct")}</th>
              <th>{t("active")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {ets.data?.map((et) => (
              <EngagementTypeRow key={`${et.id}:${et.version}`} et={et} />
            ))}
          </tbody>
        </table>
      </div>
      <NewEngagementType />
    </div>
  );
}

interface EtForm {
  code: string;
  labelEn: string;
  labelKm: string;
  model: CommercialModel;
  fee: string;
  ptFloor: string;
  ptWarn: string;
  active: boolean;
}
const etPayload = (f: EtForm) => {
  const fee = tryPercent(f.fee);
  const warn = tryPercent(f.ptWarn);
  const floor = f.ptFloor.trim() === "" ? { ok: true as const, value: null } : tryPercent(f.ptFloor);
  if (!fee.ok || !warn.ok || !floor.ok || !f.fee.trim()) return null;
  return {
    code: f.code,
    labelEn: f.labelEn,
    labelKm: f.labelKm,
    commercialModel: f.model,
    feeMarginFloorBp: fee.value,
    passthroughMarkupFloorBp: floor.value,
    passthroughMarkupWarnBp: warn.value,
    active: f.active,
  };
};

function EngagementTypeRow({ et }: { et: EngagementType }) {
  const { t } = useI18n();
  const { error, busy, write } = useWrite([["engagement-types"]]);
  const [f, setF] = useState<EtForm>({
    code: et.code,
    labelEn: et.label_en,
    labelKm: et.label_km,
    model: et.commercial_model,
    fee: bpToPercentInput(et.fee_margin_floor_bp),
    ptFloor: bpToPercentInput(et.passthrough_markup_floor_bp),
    ptWarn: bpToPercentInput(et.passthrough_markup_warn_bp),
    active: et.active,
  });
  const payload = etPayload(f);
  return (
    <tr data-testid={`et-${et.code}`}>
      <td>
        <code>{et.code}</code>
        <ErrorBanner error={error} />
      </td>
      <td>
        <input value={f.labelEn} onChange={(e) => setF({ ...f, labelEn: e.target.value })} aria-label={t("labelEn")} />
      </td>
      <td>
        <input value={f.labelKm} onChange={(e) => setF({ ...f, labelKm: e.target.value })} aria-label={t("labelKm")} lang="km" />
      </td>
      <td>
        <select
          value={f.model}
          onChange={(e) => setF({ ...f, model: e.target.value as CommercialModel })}
          aria-label={t("commercialModel")}
        >
          {MODELS.map((m) => (
            <option key={m} value={m}>
              {t(`model.${m}`)}
            </option>
          ))}
        </select>
      </td>
      <td className="num">
        <input
          className="num short"
          inputMode="decimal"
          value={f.fee}
          onChange={(e) => setF({ ...f, fee: e.target.value })}
          aria-label={t("feeFloorPct")}
          aria-invalid={!tryPercent(f.fee).ok}
          data-testid={`et-fee-floor-${et.code}`}
        />
      </td>
      <td className="num">
        <input
          className="num short"
          inputMode="decimal"
          value={f.ptFloor}
          onChange={(e) => setF({ ...f, ptFloor: e.target.value })}
          aria-label={t("ptFloorPct")}
        />
      </td>
      <td className="num">
        <input
          className="num short"
          inputMode="decimal"
          value={f.ptWarn}
          onChange={(e) => setF({ ...f, ptWarn: e.target.value })}
          aria-label={t("ptWarnPct")}
        />
      </td>
      <td>
        <input
          type="checkbox"
          checked={f.active}
          onChange={(e) => setF({ ...f, active: e.target.checked })}
          aria-label={t("active")}
        />
      </td>
      <td>
        <button
          disabled={busy || !payload}
          onClick={() => void write(() => op("engagement_type.upsert", { ...payload!, id: et.id, expectedVersion: et.version }))}
          data-testid={`et-save-${et.code}`}
        >
          {t("save")}
        </button>
      </td>
    </tr>
  );
}

function NewEngagementType() {
  const { t } = useI18n();
  const { error, busy, write } = useWrite([["engagement-types"]]);
  const blank: EtForm = {
    code: "",
    labelEn: "",
    labelKm: "",
    model: "campaign",
    fee: "25",
    ptFloor: "",
    ptWarn: "10",
    active: true,
  };
  const [f, setF] = useState<EtForm>(blank);
  const payload = etPayload(f);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (payload && (await write(() => op("engagement_type.upsert", payload)))) setF(blank);
  };
  return (
    <form className="inline-form" onSubmit={submit} data-testid="new-engagement-type">
      <h3>{t("newEngagementType")}</h3>
      <ErrorBanner error={error} />
      <div className="row">
        <Field label={t("code")}>
          <input
            value={f.code}
            onChange={(e) => setF({ ...f, code: e.target.value })}
            pattern="[a-z][a-z0-9_]*"
            maxLength={40}
            required
          />
        </Field>
        <Field label={t("labelEn")}>
          <input value={f.labelEn} onChange={(e) => setF({ ...f, labelEn: e.target.value })} required maxLength={80} />
        </Field>
        <Field label={t("labelKm")}>
          <input value={f.labelKm} onChange={(e) => setF({ ...f, labelKm: e.target.value })} required maxLength={80} lang="km" />
        </Field>
      </div>
      <div className="row">
        <Field label={t("commercialModel")}>
          <select value={f.model} onChange={(e) => setF({ ...f, model: e.target.value as CommercialModel })}>
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {t(`model.${m}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("feeFloorPct")}>
          <input inputMode="decimal" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} required />
        </Field>
        <Field label={t("ptFloorPct")}>
          <input inputMode="decimal" value={f.ptFloor} onChange={(e) => setF({ ...f, ptFloor: e.target.value })} />
        </Field>
        <Field label={t("ptWarnPct")}>
          <input inputMode="decimal" value={f.ptWarn} onChange={(e) => setF({ ...f, ptWarn: e.target.value })} required />
        </Field>
      </div>
      <button disabled={busy || !payload}>{t("create")}</button>
    </form>
  );
}

// ---- Project types --------------------------------------------------------------------------------

function ProjectTypes({ me }: { me: Me }) {
  const { t } = useI18n();
  const pts = useProjectTypes(me);
  const ets = useEngagementTypes(me);
  return (
    <div className="card">
      <h2>{t("projectTypes")}</h2>
      <div className="table-scroll">
        <table className="table" data-testid="project-types">
          <thead>
            <tr>
              <th>{t("code")}</th>
              <th>{t("labelEn")}</th>
              <th>{t("labelKm")}</th>
              <th>{t("defaultEngagementType")}</th>
              <th>{t("active")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pts.data?.map((p) => (
              <ProjectTypeRow key={`${p.id}:${p.version}`} p={p} ets={ets.data ?? []} />
            ))}
          </tbody>
        </table>
      </div>
      <NewProjectType ets={ets.data ?? []} />
    </div>
  );
}

function ProjectTypeRow({ p, ets }: { p: ProjectType; ets: EngagementType[] }) {
  const { t, label } = useI18n();
  const { error, busy, write } = useWrite([["project-types"]]);
  const [f, setF] = useState({ labelEn: p.label_en, labelKm: p.label_km, et: p.default_engagement_type_id, active: p.active });
  return (
    <tr data-testid={`pt-${p.code}`}>
      <td>
        <code>{p.code}</code>
        <ErrorBanner error={error} />
      </td>
      <td>
        <input value={f.labelEn} onChange={(e) => setF({ ...f, labelEn: e.target.value })} aria-label={t("labelEn")} />
      </td>
      <td>
        <input value={f.labelKm} onChange={(e) => setF({ ...f, labelKm: e.target.value })} aria-label={t("labelKm")} lang="km" />
      </td>
      <td>
        <select value={f.et} onChange={(e) => setF({ ...f, et: e.target.value })} aria-label={t("defaultEngagementType")}>
          {ets.map((et) => (
            <option key={et.id} value={et.id}>
              {label(et.label_en, et.label_km)}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="checkbox"
          checked={f.active}
          onChange={(e) => setF({ ...f, active: e.target.checked })}
          aria-label={t("active")}
        />
      </td>
      <td>
        <button
          disabled={busy}
          onClick={() =>
            void write(() =>
              op("project_type.upsert", {
                id: p.id,
                expectedVersion: p.version,
                code: p.code,
                labelEn: f.labelEn,
                labelKm: f.labelKm,
                defaultEngagementTypeId: f.et,
                active: f.active,
              }),
            )
          }
        >
          {t("save")}
        </button>
      </td>
    </tr>
  );
}

function NewProjectType({ ets }: { ets: EngagementType[] }) {
  const { t, label } = useI18n();
  const { error, busy, write } = useWrite([["project-types"]]);
  const blank = { code: "", labelEn: "", labelKm: "", et: "" };
  const [f, setF] = useState(blank);
  const et = f.et || ets[0]?.id || "";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await write(() =>
      op("project_type.upsert", { code: f.code, labelEn: f.labelEn, labelKm: f.labelKm, defaultEngagementTypeId: et }),
    );
    if (ok) setF(blank);
  };
  return (
    <form className="inline-form" onSubmit={submit} data-testid="new-project-type">
      <h3>{t("newProjectType")}</h3>
      <ErrorBanner error={error} />
      <div className="row">
        <Field label={t("code")}>
          <input
            value={f.code}
            onChange={(e) => setF({ ...f, code: e.target.value })}
            pattern="[a-z][a-z0-9_]*"
            maxLength={40}
            required
          />
        </Field>
        <Field label={t("labelEn")}>
          <input value={f.labelEn} onChange={(e) => setF({ ...f, labelEn: e.target.value })} required maxLength={80} />
        </Field>
        <Field label={t("labelKm")}>
          <input value={f.labelKm} onChange={(e) => setF({ ...f, labelKm: e.target.value })} required maxLength={80} lang="km" />
        </Field>
        <Field label={t("defaultEngagementType")}>
          <select value={et} onChange={(e) => setF({ ...f, et: e.target.value })}>
            {ets.map((x) => (
              <option key={x.id} value={x.id}>
                {label(x.label_en, x.label_km)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <button disabled={busy || !et}>{t("create")}</button>
    </form>
  );
}

// ---- Rate cards -----------------------------------------------------------------------------------

function RateCards({ me }: { me: Me }) {
  const { t } = useI18n();
  const cards = useRateCards(me);
  const [choice, setChoice] = useState<string | null>(null);
  const selected = choice ?? cards.data?.[0]?.id ?? null;
  const { error, busy, write } = useWrite([["rate-cards"]]);
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState<Currency>("USD");
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (await write(() => op("rate_card.upsert", { name, currency }))) setName("");
  };
  return (
    <div className="card">
      <h2>{t("rateCards")}</h2>
      <div className="segmented wrap" data-testid="rate-card-list">
        {cards.data?.map((c) => (
          <button
            key={c.id}
            className={c.id === selected ? "active" : ""}
            onClick={() => setChoice(c.id)}
            data-testid={`rate-card-${c.id}`}
          >
            {c.name} · {c.currency}
            {!c.active && ` (${t("archived")})`}
          </button>
        ))}
      </div>
      {selected && <RateCardItems me={me} id={selected} />}
      <form className="inline-form" onSubmit={create} data-testid="new-rate-card">
        <h3>{t("newRateCard")}</h3>
        <ErrorBanner error={error} />
        <div className="row">
          <Field label={t("name")}>
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          </Field>
          <Field label={t("currency")}>
            <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
              <option>USD</option>
              <option>KHR</option>
            </select>
          </Field>
        </div>
        <button disabled={busy}>{t("create")}</button>
      </form>
    </div>
  );
}

interface ItemForm {
  serviceCode: string;
  kind: LineKind;
  labelEn: string;
  labelKm: string;
  unit: Unit;
  price: string;
  cost: string;
  active: boolean;
}

function RateCardItems({ me, id }: { me: Me; id: string }) {
  const { t } = useI18n();
  const card = useRateCard(me, id);
  // Admins without finance.view_costs get no costs back (COM-CF-04) and must re-enter one to save.
  const costsVisible = hasPerm(me, "finance.view_costs");
  if (!card.data) return <p className="muted">{t("loading")}</p>;
  const cur = card.data.currency;
  return (
    <>
      <div className="table-scroll">
        <table className="table" data-testid="rate-card-items">
          <thead>
            <tr>
              <th>{t("serviceCode")}</th>
              <th>{t("kind")}</th>
              <th>{t("labelEn")}</th>
              <th>{t("labelKm")}</th>
              <th>{t("unit")}</th>
              <th className="num">{t("price")}</th>
              <th className="num">{t("cost")}</th>
              <th>{t("active")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {card.data.items.map((it) => (
              <ItemRow key={`${it.id}:${it.version}`} it={it} cardId={id} currency={cur} costsVisible={costsVisible} />
            ))}
          </tbody>
        </table>
      </div>
      <NewItem cardId={id} currency={cur} />
    </>
  );
}

const itemPayload = (f: ItemForm, currency: Currency) => {
  const price = tryMoney(f.price, currency);
  const cost = tryMoney(f.cost, currency);
  if (!price.ok || !cost.ok || !f.price.trim() || !f.cost.trim()) return null;
  return {
    serviceCode: f.serviceCode,
    kind: f.kind,
    labelEn: f.labelEn,
    labelKm: f.labelKm,
    unit: f.unit,
    unitPriceMinor: price.value.toString(),
    unitCostMinor: cost.value.toString(),
    active: f.active,
  };
};

function ItemFields({
  f,
  setF,
  currency,
  withCode,
  costPlaceholder,
}: {
  f: ItemForm;
  setF: (f: ItemForm) => void;
  currency: Currency;
  withCode: boolean;
  costPlaceholder?: string;
}) {
  const { t } = useI18n();
  return (
    <>
      {withCode && (
        <td>
          <input
            value={f.serviceCode}
            onChange={(e) => setF({ ...f, serviceCode: e.target.value.toUpperCase() })}
            pattern="[A-Z0-9][A-Z0-9_\-]*"
            maxLength={40}
            required
            aria-label={t("serviceCode")}
          />
        </td>
      )}
      <td>
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as LineKind })} aria-label={t("kind")}>
          <option value="fee">{t("kind.fee")}</option>
          <option value="pass_through">{t("kind.pass_through")}</option>
        </select>
      </td>
      <td>
        <input value={f.labelEn} onChange={(e) => setF({ ...f, labelEn: e.target.value })} required aria-label={t("labelEn")} />
      </td>
      <td>
        <input
          value={f.labelKm}
          onChange={(e) => setF({ ...f, labelKm: e.target.value })}
          required
          aria-label={t("labelKm")}
          lang="km"
        />
      </td>
      <td>
        <select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value as Unit })} aria-label={t("unit")}>
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {t(`unit.${u}`)}
            </option>
          ))}
        </select>
      </td>
      <td className="num">
        <input
          className="num short"
          inputMode="decimal"
          value={f.price}
          onChange={(e) => setF({ ...f, price: e.target.value })}
          aria-invalid={!!f.price && !tryMoney(f.price, currency).ok}
          aria-label={t("price")}
        />
      </td>
      <td className="num">
        <input
          className="num short"
          inputMode="decimal"
          value={f.cost}
          placeholder={costPlaceholder}
          onChange={(e) => setF({ ...f, cost: e.target.value })}
          aria-invalid={!!f.cost && !tryMoney(f.cost, currency).ok}
          aria-label={t("cost")}
        />
      </td>
      <td>
        <input
          type="checkbox"
          checked={f.active}
          onChange={(e) => setF({ ...f, active: e.target.checked })}
          aria-label={t("active")}
        />
      </td>
    </>
  );
}

function ItemRow({
  it,
  cardId,
  currency,
  costsVisible,
}: {
  it: RateCardItem;
  cardId: string;
  currency: Currency;
  costsVisible: boolean;
}) {
  const { t } = useI18n();
  const { error, busy, write } = useWrite([["rate-card", cardId]]);
  const [f, setF] = useState<ItemForm>({
    serviceCode: it.service_code,
    kind: it.kind,
    labelEn: it.label_en,
    labelKm: it.label_km,
    unit: it.unit,
    price: minorToInput(it.unit_price_minor, currency),
    cost: costsVisible ? minorToInput(it.unit_cost_minor, currency) : "",
    active: it.active,
  });
  const payload = itemPayload(f, currency);
  return (
    <tr data-testid={`item-${it.service_code}`}>
      <td>
        <code>{it.service_code}</code>
        <ErrorBanner error={error} />
      </td>
      <ItemFields
        f={f}
        setF={setF}
        currency={currency}
        withCode={false}
        costPlaceholder={costsVisible ? undefined : t("costHidden")}
      />
      <td>
        <button
          disabled={busy || !payload}
          onClick={() =>
            void write(() =>
              op("rate_card.item_upsert", { ...payload!, id: it.id, expectedVersion: it.version, rateCardId: cardId }),
            )
          }
        >
          {t("save")}
        </button>
      </td>
    </tr>
  );
}

function NewItem({ cardId, currency }: { cardId: string; currency: Currency }) {
  const { t } = useI18n();
  const { error, busy, write } = useWrite([["rate-card", cardId]]);
  const blank: ItemForm = {
    serviceCode: "",
    kind: "fee",
    labelEn: "",
    labelKm: "",
    unit: "hour",
    price: "",
    cost: "",
    active: true,
  };
  const [f, setF] = useState<ItemForm>(blank);
  const payload = itemPayload(f, currency);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (payload && (await write(() => op("rate_card.item_upsert", { ...payload, rateCardId: cardId })))) setF(blank);
  };
  return (
    <form className="inline-form" onSubmit={submit} data-testid="new-rate-card-item">
      <h3>{t("newItem")}</h3>
      <ErrorBanner error={error} />
      <div className="table-scroll">
        <table className="table">
          <tbody>
            <tr>
              <ItemFields f={f} setF={setF} currency={currency} withCode />
              <td>
                <button disabled={busy || !payload}>{t("create")}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </form>
  );
}
