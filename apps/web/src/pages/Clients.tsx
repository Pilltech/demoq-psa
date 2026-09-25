import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useState, type FormEvent } from "react";
import { hasPerm, op, type Me } from "../api";
import { ErrorBanner, Field, Modal } from "../components/ui";
import { useI18n } from "../i18n";
import { Link, navigate } from "../router";
import type { ClientRow } from "../types";

export function Clients({ me }: { me: Me }) {
  const { t, locale } = useI18n();
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search);
  const clients = useQuery({ queryKey: ["clients", q], queryFn: () => op<ClientRow[]>("client.list", { search: q || undefined, limit: 100 }) });
  const [creating, setCreating] = useState(false);
  return (
    <section>
      <div className="toolbar">
        <h1>{t("clients")}</h1>
        <input type="search" placeholder={t("search")} value={search} onChange={(e) => setSearch(e.target.value)} data-testid="client-search" />
        {hasPerm(me, "client.manage") && (
          <button className="primary" onClick={() => setCreating(true)} data-testid="new-client">
            {t("newClient")}
          </button>
        )}
      </div>
      <table className="table" data-testid="client-table">
        <thead>
          <tr>
            <th>{t("name")}</th>
            <th>{t("industry")}</th>
            <th>{t("accountLead")}</th>
          </tr>
        </thead>
        <tbody>
          {clients.data?.map((c) => (
            <tr key={c.id}>
              <td>
                <Link to={`/clients/${c.id}`}>{locale === "km" && c.name_km ? c.name_km : c.name}</Link>
                {locale !== "km" && c.name_km && <span className="muted"> · {c.name_km}</span>}
              </td>
              <td>{c.industry ?? t("none")}</td>
              <td>{c.account_lead_name}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {clients.data?.length === 0 && <p className="muted">{t("noItems")}</p>}
      {creating && <NewClientModal onClose={() => setCreating(false)} />}
    </section>
  );
}

function NewClientModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [nameKm, setNameKm] = useState("");
  const [industry, setIndustry] = useState("");
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const c = await op<{ id: string }>("client.create", { name, nameKm: nameKm || null, industry: industry || null });
      await qc.invalidateQueries({ queryKey: ["clients"] });
      onClose();
      navigate(`/clients/${c.id}`);
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Modal title={t("newClient")} onClose={onClose} testId="new-client-modal">
      <form onSubmit={submit}>
        <ErrorBanner error={error} />
        <Field label={t("name")}>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} data-testid="client-name" />
        </Field>
        <Field label={t("nameKm")}>
          <input value={nameKm} onChange={(e) => setNameKm(e.target.value)} maxLength={200} lang="km" data-testid="client-name-km" />
        </Field>
        <Field label={t("industry")}>
          <input value={industry} onChange={(e) => setIndustry(e.target.value)} maxLength={120} />
        </Field>
        <div className="actions">
          <button type="button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary" data-testid="client-submit">
            {t("create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
