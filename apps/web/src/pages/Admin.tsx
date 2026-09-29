import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { ROLES } from "@demoq/shared";
import { hasPerm, op, type Me } from "../api";
import { ErrorBanner, Field, Tabs } from "../components/ui";
import { useI18n } from "../i18n";
import type { DirectoryUser } from "../types";

/** Admin sub-navigation: users and teams (user.manage); pricing, task templates, holidays and activity codes (admin.config). */
export function AdminTabs({ me }: { me: Me }) {
  const { t } = useI18n();
  const items = [
    ...(hasPerm(me, "user.manage") ? [{ to: "/admin", label: t("usersTeams"), testId: "tab-users" }] : []),
    ...(hasPerm(me, "admin.config")
      ? [
          { to: "/admin/pricing", label: t("pricing"), testId: "tab-pricing" },
          { to: "/admin/templates", label: t("taskTemplates"), testId: "tab-templates" },
          { to: "/admin/holidays", label: t("adm.holidays"), testId: "tab-holidays" },
          { to: "/admin/activity-codes", label: t("adm.activityCodes"), testId: "tab-activity-codes" },
        ]
      : []),
  ];
  return items.length > 1 ? <Tabs items={items} /> : null;
}

export function Admin({ me }: { me: Me }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: () => op<DirectoryUser[]>("user.directory", {}) });
  const teams = useQuery({ queryKey: ["teams"], queryFn: () => op<{ id: string; name: string }[]>("team.list", {}) });
  const [form, setForm] = useState({ email: "", displayName: "", teamId: "", roles: [] as string[], initialPassword: "" });
  const [teamName, setTeamName] = useState("");
  const [error, setError] = useState<unknown>(null);

  const createUser = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await op("user.create", { ...form, teamId: form.teamId || null });
      setForm({ email: "", displayName: "", teamId: "", roles: [], initialPassword: "" });
      setError(null);
      await qc.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      setError(err);
    }
  };
  const createTeam = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await op("team.create", { name: teamName });
      setTeamName("");
      await qc.invalidateQueries({ queryKey: ["teams"] });
    } catch (err) {
      setError(err);
    }
  };
  const teamName_ = (id: string | null) => teams.data?.find((x) => x.id === id)?.name ?? t("none");

  return (
    <section>
      <h1>{t("admin")}</h1>
      <AdminTabs me={me} />
      <ErrorBanner error={error} />
      <div className="grid2">
        <div className="card">
          <h2>{t("users")}</h2>
          <table className="table">
            <tbody>
              {users.data?.map((u) => (
                <tr key={u.id}>
                  <td>{u.displayName}</td>
                  <td className="muted">{u.email}</td>
                  <td>{teamName_(u.teamId)}</td>
                  <td>{u.roles.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>{t("newUser")}</h3>
          <form onSubmit={createUser} className="inline-form">
            <Field label={t("name")}>
              <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required />
            </Field>
            <Field label={t("email")}>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </Field>
            <Field label={t("team")}>
              <select value={form.teamId} onChange={(e) => setForm({ ...form, teamId: e.target.value })}>
                <option value="">{t("none")}</option>
                {teams.data?.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </Field>
            <fieldset className="roles">
              <legend>{t("roles")}</legend>
              {ROLES.map((r) => (
                <label key={r} className="check">
                  <input
                    type="checkbox"
                    checked={form.roles.includes(r)}
                    onChange={(e) =>
                      setForm({ ...form, roles: e.target.checked ? [...form.roles, r] : form.roles.filter((x) => x !== r) })
                    }
                  />{" "}
                  {r}
                </label>
              ))}
            </fieldset>
            <Field label={t("initialPassword")}>
              <input
                type="password"
                minLength={12}
                value={form.initialPassword}
                onChange={(e) => setForm({ ...form, initialPassword: e.target.value })}
                required
                autoComplete="new-password"
              />
            </Field>
            <button className="primary">{t("create")}</button>
          </form>
        </div>
        <div className="card">
          <h2>{t("teams")}</h2>
          <ul className="list">
            {teams.data?.map((x) => (
              <li key={x.id}>{x.name}</li>
            ))}
          </ul>
          <form onSubmit={createTeam} className="inline-form">
            <Field label={t("newTeam")}>
              <input value={teamName} onChange={(e) => setTeamName(e.target.value)} required />
            </Field>
            <button>{t("create")}</button>
          </form>
        </div>
      </div>
    </section>
  );
}
