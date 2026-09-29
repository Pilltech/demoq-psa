// One project (specs/projects/*.md): status and transitions, gates with evidence, bypass requests, members, scope,
// and the change-order and task tabs. Every button mirrors a server check (canManage, canSatisfyGates, …); the server
// re-checks every write.
import { useState, type FormEvent } from "react";
import { hasPerm, op, type Me } from "../api";
import { ErrorBanner, Field, GateChips, Modal, ProjectStatusBadge } from "../components/ui";
import { addDaysIso, phnomPenhToday, qtyMilliToInput } from "../format";
import { useI18n } from "../i18n";
import { useDirectory, useProject, useProjectRefresh, useScope } from "../queries";
import { Link } from "../router";
import { EVIDENCE_GATES, GATE_ORDER, type Gate, type ProjectDetail } from "../types";
import { ChangeOrders } from "./ChangeOrders";
import { ProjectInfluencers } from "./Influencers";
import { TaskBoard } from "./TaskBoard";

export type ProjectTab = "overview" | "tasks" | "change-orders" | "influencers";
const OPEN = ["gated", "active", "on_hold"];

export function ProjectPage({ id, tab, coId, me }: { id: string; tab: ProjectTab; coId?: string; me: Me }) {
  const { t, label } = useI18n();
  const project = useProject(id);
  if (project.error) return <ErrorBanner error={project.error} />;
  if (!project.data) return <p>{t("loading")}</p>;
  const p = project.data;
  const tabs: { key: ProjectTab; to: string; label: string }[] = [
    { key: "overview", to: `/projects/${id}`, label: t("overview") },
    { key: "tasks", to: `/projects/${id}/tasks`, label: t("tasks") },
    ...(p.scope_id ? [{ key: "change-orders" as const, to: `/projects/${id}/change-orders`, label: t("changeOrders") }] : []),
    ...(p.kind === "client" && p.scope_id
      ? [{ key: "influencers" as const, to: `/projects/${id}/influencers`, label: t("influencers") }]
      : []),
  ];
  return (
    <section className="project-page" data-testid="project-page">
      <p className="muted small">
        <Link to="/projects">{t("backToProjects")}</Link>
      </p>
      <div className="toolbar">
        <h1 data-testid="project-name">{p.name}</h1>
        <ProjectStatusBadge status={p.status} testId="project-status" />
        <GateChips gates={p.gateStatus.uncovered} testId="project-missing-gates" />
      </div>
      <p className="muted">
        {p.client_name ? (
          <>
            {t("client")}: <strong data-testid="project-client">{p.client_name}</strong> ·{" "}
          </>
        ) : (
          <>{t("internalProject")} · </>
        )}
        {t("pmIs", { who: p.pm_name })} · {label(p.project_type_en, p.project_type_km)} ·{" "}
        {t("startsOn", { date: p.planned_start })}
      </p>
      <Transitions p={p} />
      <nav className="tabs">
        {tabs.map((x) => (
          <Link key={x.key} to={x.to} testId={`project-tab-${x.key}`} className={tab === x.key ? "active" : ""}>
            {x.label}
          </Link>
        ))}
      </nav>
      {tab === "overview" && <Overview p={p} me={me} />}
      {tab === "tasks" && <TaskBoard project={p} me={me} openTaskId={coId} />}
      {tab === "change-orders" && p.scope_id && <ChangeOrders project={p} me={me} coId={coId} />}
      {tab === "influencers" && p.kind === "client" && p.scope_id && <ProjectInfluencers project={p} me={me} />}
    </section>
  );
}

// ---- Status transitions (PRJ-PJ-02) -----------------------------------------------------------

type Transition = "activate" | "hold" | "resume" | "complete" | "cancel";

function Transitions({ p }: { p: ProjectDetail }) {
  const { t } = useI18n();
  const refresh = useProjectRefresh(p.id);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Transition | null>(null);
  const run = async (tr: Transition) => {
    setBusy(true);
    setError(null);
    try {
      await op(`project.${tr}`, { id: p.id, expectedVersion: p.version });
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const available: Transition[] = [];
  if (p.status === "gated" && p.canActivate) available.push("activate");
  if (p.canManage) {
    if (p.status === "active") available.push("hold");
    if (p.status === "on_hold") available.push("resume");
    if (p.status === "active" || p.status === "on_hold") available.push("complete");
    if (OPEN.includes(p.status)) available.push("cancel");
  }
  if (!available.length) return <ErrorBanner error={error} />;
  const gatesOpen = p.gateStatus.missing.length > 0; // bypasses allow work, never activation
  return (
    <div className="transitions">
      <ErrorBanner error={error} />
      <div className="actions wrap start">
        {available.map((tr) => (
          <button
            key={tr}
            className={tr === "activate" ? "primary" : tr === "cancel" ? "danger" : ""}
            disabled={busy || (tr === "activate" && gatesOpen)}
            onClick={() => (tr === "complete" || tr === "cancel" ? setConfirming(tr) : void run(tr))}
            data-testid={`project-${tr}`}
          >
            {t(`projectAction.${tr}`)}
          </button>
        ))}
        {available.includes("activate") && gatesOpen && <span className="muted small">{t("activateNeedsGates")}</span>}
      </div>
      {confirming && (
        <Modal title={t(`projectAction.${confirming}`)} onClose={() => setConfirming(null)} testId="project-confirm">
          <p>{t(confirming === "cancel" ? "confirmCancelProject" : "confirmCompleteProject")}</p>
          <div className="actions">
            <button type="button" onClick={() => setConfirming(null)}>
              {t("close")}
            </button>
            <button
              className={confirming === "cancel" ? "danger" : "primary"}
              onClick={() => {
                const tr = confirming;
                setConfirming(null);
                void run(tr);
              }}
              data-testid="project-confirm-yes"
            >
              {t(`projectAction.${confirming}`)}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---- Overview ---------------------------------------------------------------------------------

function Overview({ p, me }: { p: ProjectDetail; me: Me }) {
  return (
    <div className="grid2">
      {p.kind === "client" && <GatesPanel p={p} me={me} />}
      {p.kind === "client" && <BypassPanel p={p} me={me} />}
      <MembersPanel p={p} me={me} />
      {p.scope_id && <ScopePanel p={p} />}
      {p.canManage && OPEN.includes(p.status) && <DetailsPanel key={p.version} p={p} me={me} />}
    </div>
  );
}

function GatesPanel({ p, me }: { p: ProjectDetail; me: Me }) {
  const { t, date } = useI18n();
  const [exempting, setExempting] = useState(false);
  const missing = p.gateStatus.missing;
  const covered = missing.filter((g) => !p.gateStatus.uncovered.includes(g));
  const open = OPEN.includes(p.status);
  return (
    <div className="card" data-testid="gates-panel">
      <h2>{t("gates")}</h2>
      {missing.length ? (
        <p className="notice" data-testid="missing-gates" data-gates={missing.join(",")}>
          {t("gatesMissing", { gates: missing.map((g) => t(`gate.${g}`)).join(", ") })}
        </p>
      ) : (
        <p className="ok" data-testid="gates-all-met">
          {t("gatesAllMet")}
        </p>
      )}
      {covered.length > 0 && (
        <p className="muted small" data-testid="gates-covered">
          {t("gatesCovered", { gates: covered.map((g) => t(`gate.${g}`)).join(", ") })}
        </p>
      )}
      <ul className="gate-list">
        {GATE_ORDER.map((g) => {
          const row = p.gates.find((x) => x.gate === g);
          if (!row) return null;
          return (
            <li key={g} data-testid={`gate-${g}`} data-status={row.status}>
              <div className="gate-head">
                <strong>{t(`gate.${g}`)}</strong>
                <span className={`chip ${row.status}`}>{t(`gateState.${row.status}`)}</span>
              </div>
              {row.status === "satisfied" && (
                <p className="muted small" data-testid={`gate-evidence-text-${g}`}>
                  {row.evidence} ·{" "}
                  {t("satisfiedBy", { who: row.satisfied_by_name ?? "—", when: row.satisfied_at ? date(row.satisfied_at) : "" })}
                </p>
              )}
              {row.status === "not_applicable" && (
                <p className="muted small" data-testid="po-exemption-detail">
                  {t("poExempt")}
                  {row.exemption_reason && (
                    <>
                      {" "}
                      “{row.exemption_reason}” ·{" "}
                      {t("satisfiedBy", {
                        who: row.exemption_decided_by_name ?? "—",
                        when: row.exemption_decided_at ? date(row.exemption_decided_at) : "",
                      })}
                    </>
                  )}
                </p>
              )}
              {row.status === "missing" && open && p.canSatisfyGates && EVIDENCE_GATES.includes(g) && (
                <SatisfyGate projectId={p.id} gate={g} />
              )}
              {row.status === "missing" &&
                g === "purchase_order" &&
                open &&
                p.client_id &&
                hasPerm(me, "client.gate_exemption") && (
                  <button className="link small" onClick={() => setExempting(true)} data-testid="po-exemption">
                    {t("recordPoExemption")}
                  </button>
                )}
            </li>
          );
        })}
      </ul>
      {exempting && p.client_id && <ExemptionModal projectId={p.id} clientId={p.client_id} onClose={() => setExempting(false)} />}
    </div>
  );
}

function SatisfyGate({ projectId, gate }: { projectId: string; gate: Gate }) {
  const { t } = useI18n();
  const refresh = useProjectRefresh(projectId);
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await op("gate.satisfy", { projectId, gate, evidence: evidence.trim() });
      await refresh();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <form className="row gate-form" onSubmit={submit}>
      <ErrorBanner error={error} />
      <input
        value={evidence}
        onChange={(e) => setEvidence(e.target.value)}
        placeholder={t(`gateEvidenceHint.${gate as "contract" | "purchase_order" | "deposit_terms"}`)}
        aria-label={t("evidence")}
        maxLength={500}
        data-testid={`gate-evidence-${gate}`}
      />
      <button className="primary" disabled={busy || evidence.trim().length < 3} data-testid={`gate-satisfy-${gate}`}>
        {t("markMet")}
      </button>
    </form>
  );
}

function ExemptionModal({ projectId, clientId, onClose }: { projectId: string; clientId: string; onClose: () => void }) {
  const { t } = useI18n();
  const refresh = useProjectRefresh(projectId);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await op("client.gate_exemption", { clientId, reason: reason.trim() });
      await refresh();
      onClose();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Modal title={t("recordPoExemption")} onClose={onClose} testId="exemption-modal">
      <form onSubmit={submit}>
        <p className="muted small">{t("poExemptionHelp")}</p>
        <ErrorBanner error={error} />
        <Field label={t("reasonMin", { n: "10" })}>
          <textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            data-testid="exemption-reason"
          />
        </Field>
        <div className="actions">
          <button type="button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary" disabled={reason.trim().length < 10} data-testid="exemption-submit">
            {t("save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Bypasses (PRJ-BP-01) ---------------------------------------------------------------------

const BYPASS_REASON_MIN = 30;
const BYPASS_MAX_DAYS = 30;

function BypassPanel({ p, me }: { p: ProjectDetail; me: Me }) {
  const { t, date } = useI18n();
  const [requesting, setRequesting] = useState(false);
  const [flash, setFlash] = useState(false);
  const canRequest = p.canRequestBypass && (p.status === "gated" || p.status === "active") && p.gateStatus.missing.length > 0;
  return (
    <div className="card" data-testid="bypass-panel">
      <div className="toolbar compact">
        <h2>{t("bypasses")}</h2>
        {canRequest && !requesting && (
          <button onClick={() => setRequesting(true)} data-testid="bypass-new">
            {t("requestBypass")}
          </button>
        )}
      </div>
      <p className="muted small">{t("bypassHelp")}</p>
      {flash && (
        <p className="ok" role="status" data-testid="bypass-flash">
          {t("bypassSent")}
        </p>
      )}
      {p.bypasses.length === 0 && !requesting && <p className="muted small">{t("noItems")}</p>}
      <ul className="list" data-testid="bypass-list">
        {p.bypasses.map((b) => (
          <li key={b.id} className="bypass-row" data-testid={`bypass-${b.id}`} data-status={b.status}>
            <div>
              <span className={`badge bypass-${b.status}`}>{t(`bypassStatus.${b.status}`)}</span>{" "}
              {b.gates.map((g) => t(`gate.${g}`)).join(", ")}
            </div>
            <div className="muted small">
              {t("bypassOwner", { who: b.owner_name })} · {t("expiresAt", { when: date(b.expires_at) })}
              {b.close_cause ? ` · ${t(`bypassCause.${b.close_cause === "expired" ? "expired" : "gates_met"}`)}` : ""}
            </div>
            <div className="small">{b.reason}</div>
          </li>
        ))}
      </ul>
      {requesting && (
        <BypassForm
          p={p}
          me={me}
          onDone={(ok) => {
            setRequesting(false);
            setFlash(ok);
          }}
        />
      )}
    </div>
  );
}

function BypassForm({ p, me, onDone }: { p: ProjectDetail; me: Me; onDone: (sent: boolean) => void }) {
  const { t, label } = useI18n();
  const refresh = useProjectRefresh(p.id);
  const users = useDirectory(me);
  const today = phnomPenhToday();
  const [gates, setGates] = useState<Gate[]>(p.gateStatus.uncovered);
  const [ownerId, setOwnerId] = useState(me.id);
  const [reason, setReason] = useState("");
  const [expiresOn, setExpiresOn] = useState(addDaysIso(today, 14));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const max = addDaysIso(today, BYPASS_MAX_DAYS);
  const valid =
    gates.length > 0 && reason.trim().length >= BYPASS_REASON_MIN && expiresOn > today && expiresOn <= max && !!ownerId;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await op("project.bypass.request", { projectId: p.id, gates, namedOwnerId: ownerId, reason: reason.trim(), expiresOn });
      await refresh();
      onDone(true);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <form className="inline-form" onSubmit={submit} data-testid="bypass-form">
      <ErrorBanner error={error} />
      <fieldset className="roles">
        <legend>{t("bypassGates")}</legend>
        {p.gateStatus.missing.map((g) => (
          <label key={g} className="check">
            <input
              type="checkbox"
              checked={gates.includes(g)}
              onChange={(e) => setGates(e.target.checked ? [...gates, g] : gates.filter((x) => x !== g))}
              data-testid={`bypass-gate-${g}`}
            />
            {t(`gate.${g}`)}
          </label>
        ))}
      </fieldset>
      <div className="row">
        <Field label={t("namedOwner")}>
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} data-testid="bypass-owner">
            {users.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {label(u.displayName, u.displayNameKm)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("bypassExpires")}>
          <input
            type="date"
            min={addDaysIso(today, 1)}
            max={max}
            value={expiresOn}
            onChange={(e) => setExpiresOn(e.target.value)}
            data-testid="bypass-expires"
          />
        </Field>
      </div>
      <Field label={t("reasonMin", { n: String(BYPASS_REASON_MIN) })}>
        <textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={2000}
          data-testid="bypass-reason"
        />
      </Field>
      <p className="muted small" data-testid="bypass-reason-count">
        {t("charCount", { n: String(reason.trim().length), min: String(BYPASS_REASON_MIN) })}
      </p>
      <div className="actions">
        <button type="button" onClick={() => onDone(false)}>
          {t("cancel")}
        </button>
        <button className="primary" disabled={busy || !valid} data-testid="bypass-submit">
          {t("requestBypass")}
        </button>
      </div>
    </form>
  );
}

// ---- Members (PRJ-PJ-01/04) ------------------------------------------------------------------

const COMMON_ROLES = ["pm", "creative", "designer", "copywriter", "editor", "videographer", "social", "influencer_manager"];

function MembersPanel({ p, me }: { p: ProjectDetail; me: Me }) {
  const { t, label } = useI18n();
  const refresh = useProjectRefresh(p.id);
  const users = useDirectory(me);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("designer");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const write = async (input: { userId: string; projectRole: string | null }) => {
    setBusy(true);
    setError(null);
    try {
      await op("project.set_member", { projectId: p.id, ...input });
      await refresh();
      setUserId("");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const roleOk = /^[a-z][a-z_]*$/.test(role);
  const candidates = users.data?.filter((u) => !p.members.some((m) => m.user_id === u.id)) ?? [];
  return (
    <div className="card" data-testid="members-panel">
      <h2>{t("members")}</h2>
      <ErrorBanner error={error} />
      <ul className="list" data-testid="member-list">
        {p.members.map((m) => (
          <li key={m.user_id} className="token-row" data-testid={`member-${m.display_name}`}>
            <span>
              {m.display_name} <span className="tag">{m.project_role.replace(/_/g, " ")}</span>
            </span>
            {p.canManage && m.user_id !== p.pm_id && (
              <button
                className="link small"
                disabled={busy}
                onClick={() => write({ userId: m.user_id, projectRole: null })}
                data-testid="member-remove"
              >
                {t("remove")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {p.canManage && OPEN.includes(p.status) && (
        <form
          className="row member-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (userId && roleOk) void write({ userId, projectRole: role });
          }}
        >
          <Field label={t("addMember")}>
            <select value={userId} onChange={(e) => setUserId(e.target.value)} data-testid="member-user">
              <option value="">{t("choosePerson")}</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {label(u.displayName, u.displayNameKm)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("projectRole")}>
            <input
              list="project-roles"
              value={role}
              onChange={(e) => setRole(e.target.value.trim().toLowerCase())}
              aria-invalid={!roleOk}
              data-testid="member-role"
            />
            <datalist id="project-roles">
              {COMMON_ROLES.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </Field>
          <button className="primary align-end" disabled={busy || !userId || !roleOk} data-testid="member-add">
            {t("add")}
          </button>
        </form>
      )}
    </div>
  );
}

// ---- Scope (COM-AC-03, COM-CO-05) -------------------------------------------------------------

function ScopePanel({ p }: { p: ProjectDetail }) {
  const { t, money, label } = useI18n();
  const scope = useScope(p.id);
  const s = scope.data;
  return (
    <div className="card scope-panel" data-testid="scope-panel">
      <h2>{t("scope")}</h2>
      <ErrorBanner error={scope.error} />
      {s && (
        <>
          <dl className="figures">
            <div className="grand">
              <dt>{t("scopeValue")}</dt>
              <dd data-testid="scope-value">{money(s.valueMinor, s.currency)}</dd>
            </div>
            <div>
              <dt>{t("billingModel")}</dt>
              <dd className="small">
                {t(`billing.${s.billingModel}`)}
                {s.periodMonths ? ` × ${s.periodMonths} ${t("months")}` : ""}
              </dd>
            </div>
          </dl>
          {s.periods.length > 0 && (
            <ul className="list small" data-testid="scope-periods">
              {s.periods.map((per) => (
                <li key={per.id}>
                  {t("periodN", { n: String(per.period_no) })}: {per.period_start} – {per.period_end}{" "}
                  <span className="tag">{t(`periodStatus.${per.status}`)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="table-scroll">
            <table className="table" data-testid="scope-items">
              <thead>
                <tr>
                  <th>{t("description")}</th>
                  <th className="num">{t("qty")}</th>
                  <th className="num">{t("amount")}</th>
                  <th>{t("source")}</th>
                </tr>
              </thead>
              <tbody>
                {s.items.map((it, i) => (
                  <tr key={it.id} data-testid={`scope-item-${i}`} data-source={it.source_type}>
                    <td>
                      {label(it.description_en, it.description_km)}
                      {it.kind === "pass_through" && <span className="tag">{t("kind.pass_through")}</span>}
                    </td>
                    <td className="num">{qtyMilliToInput(it.qty_milli)}</td>
                    <td className="num">{money(it.line_price_minor, s.currency)}</td>
                    <td className="small">{t(`scopeSource.${it.source_type}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Details (PRJ-PJ-03/04) -------------------------------------------------------------------

function DetailsPanel({ p, me }: { p: ProjectDetail; me: Me }) {
  const { t, label } = useI18n();
  const refresh = useProjectRefresh(p.id);
  const users = useDirectory(me);
  const [name, setName] = useState(p.name);
  const [pmId, setPmId] = useState(p.pm_id);
  const [plannedStart, setPlannedStart] = useState(p.planned_start);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const dirty = name.trim() !== p.name || pmId !== p.pm_id || plannedStart !== p.planned_start;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await op("project.update", {
        id: p.id,
        expectedVersion: p.version,
        ...(name.trim() !== p.name && { name: name.trim() }),
        ...(pmId !== p.pm_id && { projectManagerId: pmId }),
        ...(plannedStart !== p.planned_start && { plannedStart }),
      });
      await refresh();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <form className="card" onSubmit={submit} data-testid="details-panel">
      <h2>{t("projectDetails")}</h2>
      <ErrorBanner error={error} />
      <Field label={t("name")}>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required data-testid="project-edit-name" />
      </Field>
      <div className="row">
        <Field label={t("projectManager")}>
          <select value={pmId} onChange={(e) => setPmId(e.target.value)} data-testid="project-edit-pm">
            {users.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {label(u.displayName, u.displayNameKm)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("plannedStart")}>
          <input
            type="date"
            value={plannedStart}
            disabled={p.status !== "gated"}
            onChange={(e) => setPlannedStart(e.target.value)}
            data-testid="project-edit-start"
          />
        </Field>
      </div>
      <p className="muted small">{t("plannedStartHint")}</p>
      <div className="actions">
        <button className="primary" disabled={busy || !dirty || !name.trim()} data-testid="project-edit-save">
          {t("save")}
        </button>
      </div>
    </form>
  );
}
