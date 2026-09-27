// Admin → Task templates (specs/tasks/tasks.md, TSK-TP-01): one template per project type. Each item has a key,
// EN/KM titles, a role hint (owner = the member with that project role, else the PM), days after the planned start,
// an estimate, dependencies on earlier items and an optional service code linking it to a scope item.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { op, type Me } from "../api";
import { ErrorBanner, Field } from "../components/ui";
import { useI18n } from "../i18n";
import { formatMinutes, minutesToHoursInput, parseHours } from "../format";
import type { TemplateEntry, TemplateItem } from "../types";
import { AdminTabs } from "./Admin";

interface DraftItem {
  id: number;
  key: string;
  titleEn: string;
  titleKm: string;
  roleHint: string;
  offsetDays: string;
  hours: string;
  dependsOn: string[];
  serviceCode: string;
  clientFacing: boolean;
}
let seq = 1;
const hoursText = minutesToHoursInput;
const toDraft = (it: TemplateItem): DraftItem => ({
  id: seq++,
  key: it.key,
  titleEn: it.title_en,
  titleKm: it.title_km ?? "",
  roleHint: it.role_hint ?? "",
  offsetDays: String(it.offset_days),
  hours: hoursText(it.estimate_minutes),
  dependsOn: it.depends_on_keys,
  serviceCode: it.service_code ?? "",
  clientFacing: it.client_facing,
});
const KEY_RE = /^[a-z][a-z0-9_]*$/;
const ROLE_RE = /^[a-z][a-z_]*$/;

export function TaskTemplates({ me }: { me: Me }) {
  const { t, label } = useI18n();
  const list = useQuery({ queryKey: ["task-templates"], queryFn: () => op<TemplateEntry[]>("task_template.list", {}) });
  const [ptId, setPtId] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const entry = list.data?.find((e) => e.projectType.id === ptId) ?? list.data?.[0];
  return (
    <section>
      <h1>{t("admin")}</h1>
      <AdminTabs me={me} />
      <ErrorBanner error={list.error} />
      {list.data && (
        <div className="toolbar">
          <h2 className="grow">{t("taskTemplates")}</h2>
          <select
            className="auto"
            value={entry?.projectType.id ?? ""}
            onChange={(e) => {
              setPtId(e.target.value);
              setSaved(null);
            }}
            aria-label={t("projectType")}
            data-testid="template-project-type"
          >
            {list.data.map((e) => (
              <option key={e.projectType.id} value={e.projectType.id}>
                {label(e.projectType.label_en, e.projectType.label_km)}
              </option>
            ))}
          </select>
        </div>
      )}
      <p className="muted small">{t("templateHelp")}</p>
      {entry && saved === entry.projectType.id && (
        <p className="ok" role="status" data-testid="template-saved">
          {t("saved")}
        </p>
      )}
      {/* Re-keyed on the server version: after a save the editor restarts from the server's template. */}
      {entry && (
        <TemplateEditor
          key={`${entry.projectType.id}:${entry.template?.version ?? 0}`}
          entry={entry}
          setSaved={(v) => setSaved(v ? entry.projectType.id : null)}
        />
      )}
    </section>
  );
}

function TemplateEditor({ entry, setSaved }: { entry: TemplateEntry; setSaved: (saved: boolean) => void }) {
  const { t, label } = useI18n();
  const qc = useQueryClient();
  const [name, setName] = useState(entry.template?.name ?? `${entry.projectType.label_en} template`);
  const [items, setItems] = useState<DraftItem[]>(() => entry.template?.items.map(toDraft) ?? []);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const set = (i: number, patch: Partial<DraftItem>) => {
    setSaved(false);
    setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  };
  const move = (i: number, d: -1 | 1) =>
    setItems((xs) => {
      const j = i + d;
      if (j < 0 || j >= xs.length) return xs;
      const copy = [...xs];
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      // Dependencies must point to earlier items: drop any that now come later.
      return copy.map((x, n) => ({ ...x, dependsOn: x.dependsOn.filter((k) => copy.slice(0, n).some((y) => y.key === k)) }));
    });
  const remove = (i: number) =>
    setItems((xs) => {
      const gone = xs[i]!.key;
      return xs.filter((_, j) => j !== i).map((x) => ({ ...x, dependsOn: x.dependsOn.filter((k) => k !== gone) }));
    });
  const add = () =>
    setItems((xs) => [
      ...xs,
      {
        id: seq++,
        key: `step_${xs.length + 1}`,
        titleEn: "",
        titleKm: "",
        roleHint: "",
        offsetDays: "0",
        hours: "1",
        dependsOn: [],
        serviceCode: "",
        clientFacing: false,
      },
    ]);

  const checks = items.map((it, i) => {
    const minutes = parseHours(it.hours);
    const offsetOk = /^\d{1,3}$/.test(it.offsetDays) && Number(it.offsetDays) <= 365;
    const keyOk = KEY_RE.test(it.key) && it.key.length <= 40 && !items.slice(0, i).some((x) => x.key === it.key);
    return {
      minutes,
      keyOk,
      offsetOk,
      titleOk: it.titleEn.trim().length > 0,
      roleOk: it.roleHint === "" || ROLE_RE.test(it.roleHint),
      valid:
        keyOk &&
        offsetOk &&
        minutes !== null &&
        it.titleEn.trim().length > 0 &&
        (it.roleHint === "" || ROLE_RE.test(it.roleHint)),
    };
  });
  const valid = name.trim().length > 0 && checks.every((c) => c.valid);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await op("task_template.save", {
        projectTypeId: entry.projectType.id,
        name: name.trim(),
        items: items.map((it, i) => ({
          key: it.key,
          titleEn: it.titleEn.trim(),
          titleKm: it.titleKm.trim() || null,
          roleHint: it.roleHint || null,
          offsetDays: Number(it.offsetDays),
          estimateMinutes: checks[i]!.minutes!,
          dependsOnKeys: it.dependsOn,
          serviceCode: it.serviceCode.trim() || null,
          clientFacing: it.clientFacing,
        })),
      });
      setSaved(true);
      await qc.invalidateQueries({ queryKey: ["task-templates"] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" data-testid="template-editor" data-project-type={entry.projectType.code}>
      <ErrorBanner error={error} />
      <Field label={t("templateName")}>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} data-testid="template-name" />
      </Field>
      <div className="table-scroll">
        <table className="table lines template-items" data-testid="template-items">
          <thead>
            <tr>
              <th>{t("templateKey")}</th>
              <th>{t("labelEn")}</th>
              <th>{t("labelKm")}</th>
              <th>{t("roleHint")}</th>
              <th className="num">{t("offsetDays")}</th>
              <th className="num">{t("estimateHours")}</th>
              <th>{t("dependsOn")}</th>
              <th>{t("serviceCode")}</th>
              <th>{t("clientFacing")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              const c = checks[i]!;
              return (
                <tr key={it.id} data-testid={`template-item-${i}`} data-key={it.key}>
                  <td>
                    <input
                      className="short"
                      value={it.key}
                      onChange={(e) => set(i, { key: e.target.value })}
                      aria-invalid={!c.keyOk}
                      aria-label={t("templateKey")}
                    />
                  </td>
                  <td>
                    <input
                      value={it.titleEn}
                      onChange={(e) => set(i, { titleEn: e.target.value })}
                      aria-invalid={!c.titleOk}
                      aria-label={t("labelEn")}
                      data-testid={`template-title-${i}`}
                    />
                  </td>
                  <td>
                    <input
                      value={it.titleKm}
                      onChange={(e) => set(i, { titleKm: e.target.value })}
                      aria-label={t("labelKm")}
                      lang="km"
                    />
                  </td>
                  <td>
                    <input
                      className="short"
                      value={it.roleHint}
                      onChange={(e) => set(i, { roleHint: e.target.value.trim().toLowerCase() })}
                      aria-invalid={!c.roleOk}
                      aria-label={t("roleHint")}
                      data-testid={`template-role-${i}`}
                    />
                  </td>
                  <td className="num">
                    <input
                      className="num short"
                      inputMode="numeric"
                      value={it.offsetDays}
                      onChange={(e) => set(i, { offsetDays: e.target.value })}
                      aria-invalid={!c.offsetOk}
                      aria-label={t("offsetDays")}
                      data-testid={`template-offset-${i}`}
                    />
                  </td>
                  <td className="num">
                    <input
                      className="num short"
                      inputMode="decimal"
                      value={it.hours}
                      onChange={(e) => set(i, { hours: e.target.value })}
                      aria-invalid={c.minutes === null}
                      aria-label={t("estimateHours")}
                      title={c.minutes !== null ? formatMinutes(c.minutes) : ""}
                      data-testid={`template-hours-${i}`}
                    />
                  </td>
                  <td>
                    <select
                      multiple
                      value={it.dependsOn}
                      onChange={(e) => set(i, { dependsOn: Array.from(e.target.selectedOptions, (o) => o.value) })}
                      aria-label={t("dependsOn")}
                      className="deps"
                    >
                      {items.slice(0, i).map((x) => (
                        <option key={x.id} value={x.key}>
                          {x.key}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="short"
                      value={it.serviceCode}
                      onChange={(e) => set(i, { serviceCode: e.target.value })}
                      aria-label={t("serviceCode")}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={it.clientFacing}
                      onChange={(e) => set(i, { clientFacing: e.target.checked })}
                      aria-label={t("clientFacing")}
                    />
                  </td>
                  <td className="keep-together">
                    <button
                      type="button"
                      className="link"
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      aria-label={t("moveUp")}
                    >
                      ↑
                    </button>{" "}
                    <button
                      type="button"
                      className="link"
                      onClick={() => move(i, 1)}
                      disabled={i === items.length - 1}
                      aria-label={t("moveDown")}
                    >
                      ↓
                    </button>{" "}
                    <button type="button" className="link" onClick={() => remove(i)} data-testid={`template-remove-${i}`}>
                      {t("remove")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!valid && <p className="error small">{t("checkFields")}</p>}
      <p className="muted small">
        {t("templateAppliesHint", { type: label(entry.projectType.label_en, entry.projectType.label_km) })}
      </p>
      <div className="actions wrap">
        <button type="button" onClick={add} data-testid="template-add">
          {t("addStep")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !valid}
          onClick={() => void save()}
          data-testid="template-save"
        >
          {t("save")}
        </button>
      </div>
    </div>
  );
}
