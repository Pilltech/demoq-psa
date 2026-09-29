// Influencers (specs/influencers/links.md): the roster (INF-RS-01), and on a project its assignments (INF-RS-02),
// expiring work-log links (INF-LK-01…05: the full link is shown once, with a copy button), submissions with their
// review status, and approved vs contracted (INF-LK-10, INV-13). Influencer-supplied text is shown as text and links as
// plain links, never as HTML.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { INFLUENCER_PLATFORMS, LINK_DEFAULT_EXPIRES_DAYS, LINK_DEFAULT_MAX_SUBMISSIONS } from "@demoq/shared";
import { ApiError, hasPerm, op, type Me } from "../api";
import { ErrorBanner, Field, Modal } from "../components/ui";
import { tryMoney } from "../format";
import { useI18n } from "../i18n";
import { useScope } from "../queries";
import type { Assignment, Influencer, InfluencerHandle, ProjectDetail, WorkLink, WorkLog, WorkSummary } from "../types";

// ---- Roster (influencer.manage) ----------------------------------------------------------------

export function InfluencerRoster({ me }: { me: Me }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const roster = useQuery({
    queryKey: ["influencers", showInactive],
    queryFn: () => op<Influencer[]>("influencer.list", { includeInactive: showInactive }),
  });
  const [error, setError] = useState<unknown>(null);
  const setActive = async (x: Influencer, active: boolean) => {
    setError(null);
    try {
      await op("influencer.update", { id: x.id, expectedVersion: x.version, active });
      await qc.invalidateQueries({ queryKey: ["influencers"] });
    } catch (e) {
      setError(e);
    }
  };
  const manage = hasPerm(me, "influencer.manage");
  return (
    <section data-testid="influencer-roster">
      <div className="toolbar">
        <h1>{t("influencers")}</h1>
        <label className="check">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          {t("showInactive")}
        </label>
      </div>
      <ErrorBanner error={error ?? roster.error} />
      <div className="grid2">
        <div className="card">
          <h2>{t("roster")}</h2>
          {roster.data && roster.data.length === 0 && <p className="muted">{t("noItems")}</p>}
          <ul className="list" data-testid="roster-list">
            {roster.data?.map((x) => (
              <li key={x.id} className="token-row" data-testid={`influencer-${x.displayName}`} data-active={x.active}>
                <div>
                  <strong>{x.displayName}</strong>
                  {!x.active && <span className="tag">{t("inactive")}</span>}
                  <div className="muted small">
                    {x.handles
                      .map((h) => `${t(`platform.${h.platform as (typeof INFLUENCER_PLATFORMS)[number]}`)} ${h.handle}`)
                      .join(" · ")}
                  </div>
                  {(x.phone || x.telegram) && (
                    <div className="muted small">{[x.phone, x.telegram].filter(Boolean).join(" · ")}</div>
                  )}
                  {x.notes && <div className="small">{x.notes}</div>}
                </div>
                {manage && (
                  <button onClick={() => setActive(x, !x.active)} data-testid="influencer-toggle">
                    {x.active ? t("deactivate") : t("activate")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
        {manage && <NewInfluencer />}
      </div>
    </section>
  );
}

function NewInfluencer() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [handles, setHandles] = useState<InfluencerHandle[]>([{ platform: "tiktok", handle: "" }]);
  const [phone, setPhone] = useState("");
  const [telegram, setTelegram] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await op("influencer.create", {
        displayName: name.trim(),
        handles: handles.filter((h) => h.handle.trim()).map((h) => ({ platform: h.platform, handle: h.handle.trim() })),
        phone: phone.trim() || null,
        telegram: telegram.trim() || null,
        notes: notes.trim() || null,
      });
      setName("");
      setHandles([{ platform: "tiktok", handle: "" }]);
      setPhone("");
      setTelegram("");
      setNotes("");
      await qc.invalidateQueries({ queryKey: ["influencers"] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card" onSubmit={submit} data-testid="influencer-form">
      <h2>{t("addInfluencer")}</h2>
      <ErrorBanner error={error} />
      <Field label={t("name")}>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required data-testid="influencer-name" />
      </Field>
      {handles.map((h, i) => (
        <div className="row" key={i}>
          <Field label={t("platform")}>
            <select
              value={h.platform}
              onChange={(e) => setHandles(handles.map((x, j) => (j === i ? { ...x, platform: e.target.value } : x)))}
            >
              {INFLUENCER_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {t(`platform.${p}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("handle")}>
            <input
              value={h.handle}
              onChange={(e) => setHandles(handles.map((x, j) => (j === i ? { ...x, handle: e.target.value } : x)))}
              maxLength={100}
              data-testid={`influencer-handle-${i}`}
            />
          </Field>
        </div>
      ))}
      {handles.length < 10 && (
        <button type="button" className="link small" onClick={() => setHandles([...handles, { platform: "tiktok", handle: "" }])}>
          {t("addHandle")}
        </button>
      )}
      <div className="row">
        <Field label={t("phone")}>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} />
        </Field>
        <Field label={t("telegram")}>
          <input value={telegram} onChange={(e) => setTelegram(e.target.value)} maxLength={100} />
        </Field>
      </div>
      <Field label={t("notesLabel")}>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
      </Field>
      <div className="actions">
        <button className="primary" disabled={busy || !name.trim()} data-testid="influencer-submit">
          {t("create")}
        </button>
      </div>
    </form>
  );
}

// ---- On a project -----------------------------------------------------------------------------

export function ProjectInfluencers({ project, me }: { project: ProjectDetail; me: Me }) {
  const { t, label } = useI18n();
  const summary = useQuery({
    queryKey: ["influencer-summary", project.id],
    queryFn: () => op<WorkSummary[]>("influencer.work.summary", { projectId: project.id }),
  });
  const mayIssue = hasPerm(me, "influencer.link.issue");
  const mayReview = hasPerm(me, "influencer.work.approve");
  return (
    <div className="stack" data-testid="project-influencers">
      <div className="card">
        <h2>{t("approvedVsContracted")}</h2>
        <p className="muted small">{t("approvedOnlyHelp")}</p>
        <ErrorBanner error={summary.error} />
        {summary.data && summary.data.length === 0 && <p className="muted">{t("noAssignments")}</p>}
        {summary.data && summary.data.length > 0 && (
          <div className="table-scroll">
            <table className="table" data-testid="influencer-summary">
              <thead>
                <tr>
                  <th>{t("influencer")}</th>
                  <th>{t("deliverable")}</th>
                  <th className="num">{t("approvedOfContracted")}</th>
                  <th className="num">{t("pendingCount")}</th>
                  <th className="num">{t("rejectedCount")}</th>
                </tr>
              </thead>
              <tbody>
                {summary.data.map((s) => (
                  <tr
                    key={s.assignmentId}
                    data-testid={`summary-${s.influencer}`}
                    data-approved={s.approved}
                    data-pending={s.pending}
                  >
                    <td>{s.influencer}</td>
                    <td>{label(s.deliverable.en, s.deliverable.km)}</td>
                    <td className="num">
                      {s.approved} / {s.contractedPosts}
                      {s.approvedOverQuantity > 0 && (
                        <span className="tag danger">{t("overQuantityN", { n: String(s.approvedOverQuantity) })}</span>
                      )}
                    </td>
                    <td className="num">{s.pending}</td>
                    <td className="num">{s.rejected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {mayIssue && <Assignments project={project} me={me} />}
      {mayReview && <Submissions project={project} />}
    </div>
  );
}

const isForbidden = (e: unknown) => e instanceof ApiError && (e.code === "FORBIDDEN" || e.code === "NOT_FOUND");

function Assignments({ project, me }: { project: ProjectDetail; me: Me }) {
  const { t } = useI18n();
  const list = useQuery({
    queryKey: ["assignments", project.id],
    queryFn: () => op<Assignment[]>("influencer.assignment.list", { projectId: project.id }),
  });
  const [creating, setCreating] = useState(false);
  if (isForbidden(list.error)) return null; // not this project's PM
  const open = ["gated", "active", "on_hold"].includes(project.status);
  return (
    <div className="card" data-testid="assignments">
      <div className="toolbar compact">
        <h2>{t("assignments")}</h2>
        {open && project.scope_id && (
          <button className="primary" onClick={() => setCreating(true)} data-testid="assignment-new">
            {t("newAssignment")}
          </button>
        )}
      </div>
      <p className="muted small">{t("linkHelp")}</p>
      <ErrorBanner error={list.error} />
      {list.data && list.data.length === 0 && <p className="muted">{t("noAssignments")}</p>}
      <div className="stack">
        {list.data?.map((a) => (
          <AssignmentCard key={a.id} a={a} project={project} />
        ))}
      </div>
      {creating && <AssignmentModal project={project} me={me} onClose={() => setCreating(false)} />}
    </div>
  );
}

function AssignmentCard({ a, project }: { a: Assignment; project: ProjectDetail }) {
  const { t, label, money, date } = useI18n();
  const qc = useQueryClient();
  const links = useQuery({
    queryKey: ["links", a.id],
    queryFn: () => op<WorkLink[]>("influencer.link.list", { assignmentId: a.id }),
  });
  const [issued, setIssued] = useState<{ url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [days, setDays] = useState(String(LINK_DEFAULT_EXPIRES_DAYS));
  const [max, setMax] = useState(String(LINK_DEFAULT_MAX_SUBMISSIONS));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () =>
    Promise.all(
      [
        ["links", a.id],
        ["assignments", project.id],
      ].map((k) => qc.invalidateQueries({ queryKey: k })),
    );
  const issue = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await op<{ path: string }>("influencer.link.issue", {
        assignmentId: a.id,
        expiresInDays: Number(days),
        maxSubmissions: Number(max),
      });
      setCopied(false);
      setIssued({ url: `${window.location.origin}${r.path}` });
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (l: WorkLink) => {
    setError(null);
    try {
      await op("influencer.link.revoke", { id: l.id });
      await refresh();
    } catch (err) {
      setError(err);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued!.url);
      setCopied(true);
    } catch {
      /* clipboard blocked: the link is selectable */
    }
  };
  const open = ["gated", "active", "on_hold"].includes(project.status);
  return (
    <div className="assignment" data-testid={`assignment-${a.influencer}`} data-active={a.active}>
      <div className="gate-head">
        <strong>{a.influencer}</strong>
        {!a.active && <span className="tag">{t("inactive")}</span>}
      </div>
      <p className="muted small">
        {label(a.deliverable.en, a.deliverable.km)} · {t("contractedN", { n: String(a.contractedPosts) })}
        {a.perPostPassthroughMinor && a.currency
          ? ` · ${t("perPost", { amount: money(a.perPostPassthroughMinor, a.currency) })}`
          : ""}
      </p>
      <ErrorBanner error={error} />
      {issued && (
        <div className="code-box" data-testid="link-issued">
          <p className="warning">{t("linkOnce")}</p>
          <div className="row nowrap">
            <code className="secret" data-testid="link-url">
              {issued.url}
            </code>
            <button type="button" onClick={copy} data-testid="link-copy">
              {copied ? t("copied") : t("copy")}
            </button>
          </div>
          <div className="actions">
            <button type="button" onClick={() => setIssued(null)} data-testid="link-done">
              {t("done")}
            </button>
          </div>
        </div>
      )}
      {a.active && open && (
        <form className="row link-form" onSubmit={issue}>
          <Field label={t("linkDays")}>
            <input
              type="number"
              min={1}
              max={30}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              required
              className="short"
            />
          </Field>
          <Field label={t("linkMaxSubmissions")}>
            <input
              type="number"
              min={1}
              max={50}
              value={max}
              onChange={(e) => setMax(e.target.value)}
              required
              className="short"
            />
          </Field>
          <button className="primary align-end" disabled={busy} data-testid="link-issue">
            {t("issueLink")}
          </button>
        </form>
      )}
      {links.data && links.data.length > 0 && (
        <ul className="list links" data-testid="link-list">
          {links.data.map((l) => (
            <li key={l.id} className="token-row" data-testid="link-row" data-state={l.state}>
              <div>
                <span className={`badge link-${l.state}`}>{t(`linkState.${l.state}`)}</span>{" "}
                <span className="small">
                  {t("linkUse", { used: String(l.used), max: String(l.maxSubmissions), left: String(l.remaining) })}
                </span>
                <div className="muted small">
                  {t("linkIssued", { who: l.issuedBy, when: date(l.issuedAt) })} · {t("expiresAt", { when: date(l.expiresAt) })}
                </div>
              </div>
              {l.state === "active" && (
                <button onClick={() => revoke(l)} data-testid="link-revoke">
                  {t("revoke")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AssignmentModal({ project, me, onClose }: { project: ProjectDetail; me: Me; onClose: () => void }) {
  const { t, label, money } = useI18n();
  const qc = useQueryClient();
  const roster = useQuery({
    queryKey: ["influencers", false],
    enabled: hasPerm(me, "influencer.link.issue"),
    queryFn: () => op<Influencer[]>("influencer.list", {}),
  });
  const scope = useScope(project.id, !!project.scope_id);
  const [influencerId, setInfluencerId] = useState("");
  const [scopeItemId, setScopeItemId] = useState("");
  const [posts, setPosts] = useState("1");
  const [perPost, setPerPost] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const currency = scope.data?.currency ?? "USD";
  const value = perPost.trim() ? tryMoney(perPost, currency) : null;
  const postsN = /^\d{1,4}$/.test(posts) ? Number(posts) : 0;
  const valid = !!influencerId && !!scopeItemId && postsN >= 1 && postsN <= 1000 && (value === null || value.ok);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await op("influencer.assignment.create", {
        projectId: project.id,
        scopeItemId,
        influencerId,
        contractedPosts: postsN,
        perPostPassthroughMinor: value && value.ok ? value.value.toString() : null,
        notes: notes.trim() || null,
      });
      await Promise.all(
        [
          ["assignments", project.id],
          ["influencer-summary", project.id],
        ].map((k) => qc.invalidateQueries({ queryKey: k })),
      );
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t("newAssignment")} onClose={onClose} testId="assignment-modal">
      <form onSubmit={submit}>
        <ErrorBanner error={error} />
        <Field label={t("influencer")}>
          <select
            value={influencerId}
            onChange={(e) => setInfluencerId(e.target.value)}
            required
            data-testid="assignment-influencer"
          >
            <option value="">{t("chooseInfluencer")}</option>
            {roster.data?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("deliverable")}>
          <select
            value={scopeItemId}
            onChange={(e) => setScopeItemId(e.target.value)}
            required
            data-testid="assignment-scope-item"
          >
            <option value="">{t("chooseScopeItem")}</option>
            {scope.data?.items.map((it) => (
              <option key={it.id} value={it.id}>
                {label(it.description_en, it.description_km)} ({money(it.line_price_minor, scope.data!.currency)})
              </option>
            ))}
          </select>
        </Field>
        <div className="row">
          <Field label={t("contractedPosts")}>
            <input
              inputMode="numeric"
              value={posts}
              onChange={(e) => setPosts(e.target.value)}
              required
              data-testid="assignment-posts"
            />
          </Field>
          <Field label={t("perPostPassthrough", { currency })}>
            <input
              inputMode="decimal"
              value={perPost}
              onChange={(e) => setPerPost(e.target.value)}
              aria-invalid={value !== null && !value.ok}
              placeholder="350.00"
              data-testid="assignment-per-post"
            />
          </Field>
        </div>
        <Field label={t("notesLabel")}>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </Field>
        <div className="actions">
          <button type="button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary" disabled={busy || !valid} data-testid="assignment-submit">
            {t("create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Submissions({ project }: { project: ProjectDetail }) {
  const { t, date } = useI18n();
  const work = useQuery({
    queryKey: ["influencer-work", project.id],
    queryFn: () => op<WorkLog[]>("influencer.work.list", { projectId: project.id }),
  });
  if (isForbidden(work.error)) return null;
  return (
    <div className="card" data-testid="submissions">
      <h2>{t("submissions")}</h2>
      <ErrorBanner error={work.error} />
      {work.data && work.data.length === 0 && <p className="muted">{t("noSubmissions")}</p>}
      <ul className="list">
        {work.data?.map((w) => (
          <li key={w.id} className="submission" data-testid={`submission-${w.postUrl}`} data-status={w.status}>
            <div className="gate-head">
              <strong>{w.influencer}</strong>
              <span>
                {w.overQuantity && <span className="tag danger">{t("overQuantity")}</span>}
                {w.oosOutcome && <span className="tag">{t(`oosOutcome.${w.oosOutcome}`)}</span>}
                <span className={`badge work-${w.status}`}>{t(`workStatus.${w.status}`)}</span>
              </span>
            </div>
            <div className="break small">
              <a href={w.postUrl} target="_blank" rel="noopener noreferrer nofollow">
                {w.postUrl}
              </a>
            </div>
            <div className="muted small">
              {t("postedOnDate", { date: w.postedOn })} · {t("submittedAt", { when: date(w.submittedAt) })}
              {Object.keys(w.metrics ?? {}).length > 0 &&
                ` · ${Object.entries(w.metrics)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(", ")}`}
            </div>
            {w.proofUrls.length > 0 && (
              <ul className="plain small">
                {w.proofUrls.map((u) => (
                  <li key={u} className="break">
                    <a href={u} target="_blank" rel="noopener noreferrer nofollow">
                      {u}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {w.note && <div className="small">“{w.note}”</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
