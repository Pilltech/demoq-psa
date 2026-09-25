import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { hasPerm, op, type Me } from "../api";
import { ErrorBanner, Field } from "../components/ui";
import { useI18n } from "../i18n";
import type { AuditRow, ClientDetail } from "../types";

export function ClientPage({ id, me }: { id: string; me: Me }) {
  const { t, date } = useI18n();
  const qc = useQueryClient();
  const client = useQuery({ queryKey: ["client", id], queryFn: () => op<ClientDetail>("client.get", { id }) });
  const audit = useQuery({
    queryKey: ["audit", "client", id],
    enabled: hasPerm(me, "audit.view"),
    queryFn: () => op<AuditRow[]>("audit.timeline", { subjectType: "client", subjectId: id }),
  });
  const [contact, setContact] = useState({ fullName: "", title: "", email: "", phone: "", telegram: "", isPrimary: false });
  const [error, setError] = useState<unknown>(null);
  const c = client.data;
  if (client.error) return <ErrorBanner error={client.error} />;
  if (!c) return <p>{t("loading")}</p>;

  const addContact = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await op("contact.create", {
        clientId: id,
        fullName: contact.fullName,
        title: contact.title || null,
        email: contact.email || null,
        phone: contact.phone || null,
        telegram: contact.telegram || null,
        isPrimary: contact.isPrimary,
      });
      setContact({ fullName: "", title: "", email: "", phone: "", telegram: "", isPrimary: false });
      setError(null);
      await qc.invalidateQueries({ queryKey: ["client", id] });
    } catch (err) {
      setError(err);
    }
  };

  return (
    <section>
      <div className="toolbar">
        <h1 data-testid="client-title">
          {c.name} {c.name_km && <span className="muted" lang="km">· {c.name_km}</span>}
        </h1>
        {c.po_required && <span className="tag">{t("poRequired")}</span>}
        {c.archived_at && <span className="tag">{t("archived")}</span>}
      </div>
      <p className="muted">
        {t("accountLead")}: {c.account_lead_name} · {t("industry")}: {c.industry ?? t("none")}
      </p>

      <div className="grid2">
        <div className="card">
          <h2>{t("contacts")}</h2>
          <ul className="list" data-testid="contacts">
            {c.contacts.map((ct) => (
              <li key={ct.id}>
                <strong>{ct.full_name}</strong> {ct.is_primary && <span className="tag">{t("primary")}</span>}
                <div className="muted small">{[ct.title, ct.email, ct.phone, ct.telegram && `@${ct.telegram.replace(/^@/, "")}`].filter(Boolean).join(" · ")}</div>
              </li>
            ))}
          </ul>
          {c.canManage && (
            <form onSubmit={addContact} className="inline-form" data-testid="contact-form">
              <ErrorBanner error={error} />
              <Field label={t("fullName")}>
                <input value={contact.fullName} onChange={(e) => setContact({ ...contact, fullName: e.target.value })} required data-testid="contact-name" />
              </Field>
              <div className="row">
                <Field label={t("title")}>
                  <input value={contact.title} onChange={(e) => setContact({ ...contact, title: e.target.value })} />
                </Field>
                <Field label={t("email")}>
                  <input type="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
                </Field>
              </div>
              <div className="row">
                <Field label={t("phone")}>
                  <input value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
                </Field>
                <Field label={t("telegram")}>
                  <input value={contact.telegram} onChange={(e) => setContact({ ...contact, telegram: e.target.value })} />
                </Field>
              </div>
              <label className="check">
                <input type="checkbox" checked={contact.isPrimary} onChange={(e) => setContact({ ...contact, isPrimary: e.target.checked })} /> {t("primary")}
              </label>
              <button data-testid="contact-submit">{t("addContact")}</button>
            </form>
          )}
        </div>
        <div className="card">
          {c.deals && (
            <>
              <h2>{t("deals")}</h2>
              <ul className="list">
                {c.deals.map((d) => (
                  <li key={d.id}>
                    {d.title} <span className="tag">{t(`stage.${d.stage}`)}</span>
                  </li>
                ))}
                {c.deals.length === 0 && <li className="muted">{t("noItems")}</li>}
              </ul>
            </>
          )}
          {audit.data && (
            <>
              <h2>{t("auditTrail")}</h2>
              <ol className="timeline">
                {audit.data.map((a) => (
                  <li key={a.id}>
                    <code>{a.action}</code>
                    <div className="muted small">{t("byOn", { who: a.actor_name, when: date(a.occurred_at), channel: a.channel })}</div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
