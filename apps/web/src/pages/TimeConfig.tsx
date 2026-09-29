// Admin: public holidays (TIM-LV-02, D-HD-1: verify each row against the official sub-decree) and internal activity
// codes (TIM-TS-01). admin.config only; English-only screens (D25).
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import type { Me } from "../api";
import { op } from "../api";
import { ErrorBanner, Field } from "../components/ui";
import { phnomPenhToday } from "../format";
import { useI18n } from "../i18n";
import { useActivityCodes, useHolidays } from "../queries";
import type { ActivityCode, Holiday } from "../types";
import { AdminTabs } from "./Admin";

export function HolidaysAdmin({ me }: { me: Me }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const thisYear = Number(phnomPenhToday().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const holidays = useHolidays(year);
  const [error, setError] = useState<unknown>(null);
  const empty = { date: "", nameEn: "", nameKm: "", source: "", verified: false };
  const [form, setForm] = useState(empty);
  const refresh = () => qc.invalidateQueries({ queryKey: ["holidays"] });
  const save = async (h: typeof empty & { expectedVersion?: number }) => {
    setError(null);
    try {
      await op("holiday.upsert", h);
      await refresh();
      return true;
    } catch (e) {
      setError(e);
      return false;
    }
  };
  const remove = async (h: Holiday) => {
    setError(null);
    try {
      await op("holiday.remove", { date: h.date, expectedVersion: h.version });
      await refresh();
    } catch (e) {
      setError(e);
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await save(form)) setForm(empty);
  };
  return (
    <section data-testid="holidays-admin">
      <h1>{t("admin")}</h1>
      <AdminTabs me={me} />
      <div className="toolbar compact">
        <h2>{t("adm.holidays")}</h2>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="auto" data-testid="admin-holiday-year">
          {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>
      <p className="notice">{t("adm.holidaysHelp")}</p>
      <ErrorBanner error={error ?? holidays.error} />
      <div className="table-scroll">
        <table className="table" data-testid="admin-holidays">
          <thead>
            <tr>
              <th>{t("rateDate")}</th>
              <th>{t("adm.nameEn")}</th>
              <th>{t("adm.nameKm")}</th>
              <th>{t("source")}</th>
              <th>{t("adm.verified")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {holidays.data?.map((h) => (
              <HolidayRow key={`${h.date}:${h.version}`} h={h} onSave={save} onRemove={remove} />
            ))}
          </tbody>
        </table>
      </div>
      <form className="card inline-form" onSubmit={add} data-testid="admin-holiday-form">
        <h3>{t("adm.addHoliday")}</h3>
        <div className="row">
          <Field label={t("rateDate")}>
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
          </Field>
          <Field label={t("adm.nameEn")}>
            <input value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} maxLength={200} required />
          </Field>
          <Field label={t("adm.nameKm")}>
            <input value={form.nameKm} onChange={(e) => setForm({ ...form, nameKm: e.target.value })} maxLength={200} required />
          </Field>
          <Field label={t("source")}>
            <input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} maxLength={300} required />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.verified} onChange={(e) => setForm({ ...form, verified: e.target.checked })} />
          {t("adm.verifiedAgainst")}
        </label>
        <div className="actions">
          <button className="primary">{t("add")}</button>
        </div>
      </form>
    </section>
  );
}

function HolidayRow({
  h,
  onSave,
  onRemove,
}: {
  h: Holiday;
  onSave: (h: {
    date: string;
    nameEn: string;
    nameKm: string;
    source: string;
    verified: boolean;
    expectedVersion?: number;
  }) => Promise<boolean>;
  onRemove: (h: Holiday) => void;
}) {
  const { t } = useI18n();
  const [row, setRow] = useState({ nameEn: h.nameEn, nameKm: h.nameKm, source: h.source, verified: h.verified });
  const dirty = row.nameEn !== h.nameEn || row.nameKm !== h.nameKm || row.source !== h.source || row.verified !== h.verified;
  return (
    <tr data-testid={`admin-holiday-${h.date}`} data-verified={h.verified ? "true" : "false"}>
      <td className="keep-together">{h.date}</td>
      <td>
        <input value={row.nameEn} onChange={(e) => setRow({ ...row, nameEn: e.target.value })} aria-label={t("adm.nameEn")} />
      </td>
      <td>
        <input value={row.nameKm} onChange={(e) => setRow({ ...row, nameKm: e.target.value })} aria-label={t("adm.nameKm")} />
      </td>
      <td>
        <input value={row.source} onChange={(e) => setRow({ ...row, source: e.target.value })} aria-label={t("source")} />
      </td>
      <td>
        <label className="check">
          <input
            type="checkbox"
            checked={row.verified}
            onChange={(e) => setRow({ ...row, verified: e.target.checked })}
            data-testid="admin-holiday-verified"
          />
          {h.verified ? t("adm.verified") : t("unverified")}
        </label>
      </td>
      <td className="keep-together">
        <button disabled={!dirty} onClick={() => void onSave({ date: h.date, ...row, expectedVersion: h.version })}>
          {t("save")}
        </button>{" "}
        <button className="link small" onClick={() => onRemove(h)}>
          {t("remove")}
        </button>
      </td>
    </tr>
  );
}

export function ActivityCodesAdmin({ me }: { me: Me }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const codes = useActivityCodes(true);
  const [error, setError] = useState<unknown>(null);
  const empty = { code: "", labelEn: "", labelKm: "", active: true, position: 100 };
  const [form, setForm] = useState(empty);
  const save = async (c: typeof empty & { expectedVersion?: number }) => {
    setError(null);
    try {
      await op("activity_code.upsert", c);
      await qc.invalidateQueries({ queryKey: ["activity-codes"] });
      return true;
    } catch (e) {
      setError(e);
      return false;
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await save(form)) setForm(empty);
  };
  return (
    <section data-testid="activity-codes-admin">
      <h1>{t("admin")}</h1>
      <AdminTabs me={me} />
      <h2>{t("adm.activityCodes")}</h2>
      <p className="muted small">{t("adm.activityCodesHelp")}</p>
      <ErrorBanner error={error ?? codes.error} />
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>{t("code")}</th>
              <th>{t("labelEn")}</th>
              <th>{t("labelKm")}</th>
              <th className="num">{t("adm.position")}</th>
              <th>{t("active")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {codes.data?.map((c) => (
              <CodeRow key={`${c.code}:${c.version}`} c={c} onSave={save} />
            ))}
          </tbody>
        </table>
      </div>
      <form className="card inline-form" onSubmit={add}>
        <h3>{t("adm.addActivityCode")}</h3>
        <div className="row">
          <Field label={t("code")}>
            <input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              pattern="[a-z][a-z0-9_]{1,39}"
              placeholder="client_support"
              required
            />
          </Field>
          <Field label={t("labelEn")}>
            <input
              value={form.labelEn}
              onChange={(e) => setForm({ ...form, labelEn: e.target.value })}
              maxLength={100}
              required
            />
          </Field>
          <Field label={t("labelKm")}>
            <input
              value={form.labelKm}
              onChange={(e) => setForm({ ...form, labelKm: e.target.value })}
              maxLength={100}
              required
            />
          </Field>
        </div>
        <div className="actions">
          <button className="primary">{t("add")}</button>
        </div>
      </form>
    </section>
  );
}

function CodeRow({
  c,
  onSave,
}: {
  c: ActivityCode;
  onSave: (c: {
    code: string;
    labelEn: string;
    labelKm: string;
    active: boolean;
    position: number;
    expectedVersion?: number;
  }) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [row, setRow] = useState({ labelEn: c.labelEn, labelKm: c.labelKm, active: c.active, position: String(c.position) });
  const pos = /^\d{1,5}$/.test(row.position) ? Number(row.position) : null;
  const dirty = row.labelEn !== c.labelEn || row.labelKm !== c.labelKm || row.active !== c.active || pos !== c.position;
  return (
    <tr data-testid={`admin-code-${c.code}`}>
      <td>
        <code>{c.code}</code>
      </td>
      <td>
        <input value={row.labelEn} onChange={(e) => setRow({ ...row, labelEn: e.target.value })} aria-label={t("labelEn")} />
      </td>
      <td>
        <input value={row.labelKm} onChange={(e) => setRow({ ...row, labelKm: e.target.value })} aria-label={t("labelKm")} />
      </td>
      <td className="num">
        <input
          className="num short"
          value={row.position}
          onChange={(e) => setRow({ ...row, position: e.target.value })}
          aria-invalid={pos === null}
          aria-label={t("adm.position")}
        />
      </td>
      <td>
        <input
          type="checkbox"
          checked={row.active}
          onChange={(e) => setRow({ ...row, active: e.target.checked })}
          aria-label={t("active")}
        />
      </td>
      <td>
        <button
          disabled={!dirty || pos === null}
          onClick={() =>
            void onSave({
              code: c.code,
              labelEn: row.labelEn,
              labelKm: row.labelKm,
              active: row.active,
              position: pos!,
              expectedVersion: c.version,
            })
          }
        >
          {t("save")}
        </button>
      </td>
    </tr>
  );
}
