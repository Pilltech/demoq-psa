// The public influencer page /l/:token (specs/influencers/links.md, INF-LK-06…09). No account, no app chrome, no staff
// API: only GET /api/v1/link/:token and POST /api/v1/link/:token/submissions, without cookies. Phone-first, EN/KM.
// Texts come from the API with the link (so page and API agree); the 404/410/429 states use the app's own strings.
// Everything the influencer typed is shown back as text, never as HTML.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  errorMessage,
  LINK_MAX_PROOF_URLS,
  LINK_METRIC_KEYS,
  LinkSubmissionInput,
  type ErrorCode,
  type Locale,
  type Problem,
} from "@demoq/shared";
import { makeI18n } from "../i18n";

type Texts = Record<string, string>;
interface LinkInfo {
  state: "active";
  influencer: { displayName: string };
  project: { name: string };
  deliverable: { en: string; km: string };
  contractedPosts: number;
  submissions: { used: number; max: number; remaining: number };
  expiresAt: string;
  accepts: { metrics: string[]; maxProofUrls: number; noteMaxLength: number; urlMaxLength: number };
  mine: { postUrl: string; postedOn: string; status: "submitted" | "approved" | "rejected"; submittedAt: string }[];
  texts: Record<Locale, Texts>;
}
type View =
  | { kind: "loading" }
  | { kind: "active"; info: LinkInfo }
  | { kind: "not_found" }
  | { kind: "expired"; reason: string | null }
  | { kind: "rate_limited" }
  | { kind: "error" };

const LOCALE_KEY = "psa.locale";
function initialLocale(): Locale {
  try {
    const v = localStorage.getItem(LOCALE_KEY);
    if (v === "km" || v === "en") return v;
  } catch {
    /* private mode */
  }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("km") ? "km" : "en";
}

const METRIC_TEXT: Record<string, string> = {
  views: "metricViews",
  likes: "metricLikes",
  comments: "metricComments",
  shares: "metricShares",
  saves: "metricSaves",
  reach: "metricReach",
};
const STATUS_TEXT = { submitted: "statusSubmitted", approved: "statusApproved", rejected: "statusRejected" } as const;

async function call(method: "GET" | "POST", url: string, locale: Locale, body?: unknown) {
  const res = await fetch(url, {
    method,
    credentials: "omit", // the token is the only authority (INF-LK-06)
    referrerPolicy: "no-referrer",
    headers: { accept: "application/json", "accept-language": locale, ...(body ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

export function LinkPage({ token }: { token: string }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const i18n = useMemo(() => makeI18n(locale), [locale]);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [thanks, setThanks] = useState(false);
  const base = `/api/v1/link/${encodeURIComponent(token)}`;

  const load = useCallback(async () => {
    try {
      const r = await call("GET", base, locale);
      if (r.status === 200) setView({ kind: "active", info: r.data as LinkInfo });
      else if (r.status === 404) setView({ kind: "not_found" });
      else if (r.status === 410)
        setView({ kind: "expired", reason: ((r.data as Problem | null)?.params?.reason as string | undefined) ?? null });
      else if (r.status === 429) setView({ kind: "rate_limited" });
      else setView({ kind: "error" });
    } catch {
      setView({ kind: "error" });
    }
  }, [base, locale]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = view.kind === "active" ? view.info.texts[locale].title! : "DemoQ";
    // Not for search engines, and no referrer to the links an influencer opens from here.
    const metas: [string, string][] = [
      ["robots", "noindex, nofollow"],
      ["referrer", "no-referrer"],
    ];
    for (const [name, content] of metas) {
      let m = document.querySelector(`meta[name="${name}"]`);
      if (!m) {
        m = document.createElement("meta");
        m.setAttribute("name", name);
        document.head.appendChild(m);
      }
      m.setAttribute("content", content);
    }
  }, [locale, view]);

  const toggle = () => {
    const next: Locale = locale === "en" ? "km" : "en";
    setLocale(next);
    try {
      localStorage.setItem(LOCALE_KEY, next);
    } catch {
      /* private mode */
    }
  };
  const t = i18n.t;
  const txt = view.kind === "active" ? view.info.texts[locale] : null;

  return (
    <div className={`app link-app locale-${locale}`} data-testid="link-page" data-state={view.kind}>
      <header className="link-header">
        <strong className="brand">DemoQ</strong>
        <span className="spacer" />
        <button className="link" onClick={toggle} data-testid="link-locale">
          {t("language")}
        </button>
      </header>
      <main className="link-main">
        {view.kind === "loading" && <p className="center">{t("loading")}</p>}
        {view.kind === "not_found" && (
          <div className="card link-problem" data-testid="link-not-found">
            <h1>{t("linkNotFoundTitle")}</h1>
            <p>{t("linkNotFound")}</p>
          </div>
        )}
        {view.kind === "expired" && (
          <div className="card link-problem" data-testid="link-expired" data-reason={view.reason ?? ""}>
            <h1>{t("linkExpiredTitle")}</h1>
            <p>
              {view.reason === "revoked"
                ? t("linkRevoked")
                : view.reason === "exhausted"
                  ? t("linkExhausted")
                  : t("linkExpiredText")}
            </p>
            <p className="muted">{t("linkAskContact")}</p>
          </div>
        )}
        {view.kind === "rate_limited" && (
          <div className="card link-problem" data-testid="link-rate-limited">
            <p>{errorMessage("RATE_LIMITED", locale)}</p>
            <button onClick={() => void load()}>{t("tryAgain")}</button>
          </div>
        )}
        {view.kind === "error" && (
          <div className="card link-problem" data-testid="link-error">
            <p>{errorMessage("INTERNAL", locale)}</p>
            <button onClick={() => void load()}>{t("tryAgain")}</button>
          </div>
        )}
        {view.kind === "active" && txt && (
          <ActiveLink
            info={view.info}
            txt={txt}
            locale={locale}
            thanks={thanks}
            onSubmitted={async () => {
              setThanks(true);
              await load();
            }}
            onAnother={() => setThanks(false)}
            onDead={(v) => setView(v)}
            base={base}
          />
        )}
      </main>
    </div>
  );
}

const fill = (s: string, vars: Record<string, string>) => Object.entries(vars).reduce((a, [k, v]) => a.replace(`{${k}}`, v), s);

function ActiveLink({
  info,
  txt,
  locale,
  thanks,
  onSubmitted,
  onAnother,
  onDead,
  base,
}: {
  info: LinkInfo;
  txt: Texts;
  locale: Locale;
  thanks: boolean;
  onSubmitted: () => Promise<void>;
  onAnother: () => void;
  onDead: (v: View) => void;
  base: string;
}) {
  const i18n = makeI18n(locale);
  const x = (k: string, vars: Record<string, string> = {}) => fill(txt[k] ?? k, vars);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Phnom_Penh" }).format(new Date());
  const [postUrl, setPostUrl] = useState("");
  const [postedOn, setPostedOn] = useState(today);
  const [metrics, setMetrics] = useState<Record<string, string>>({});
  const [proofs, setProofs] = useState<string[]>([""]);
  const [note, setNote] = useState("");
  const [issues, setIssues] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const expires = new Intl.DateTimeFormat(locale === "km" ? "km-KH" : "en-GB", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Phnom_Penh",
  }).format(new Date(info.expiresAt));
  const deliverable = locale === "km" ? info.deliverable.km : info.deliverable.en;
  const maxProofs = Math.min(info.accepts.maxProofUrls, LINK_MAX_PROOF_URLS);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = {
      postUrl: postUrl.trim(),
      postedOn,
      metrics: Object.fromEntries(
        Object.entries(metrics)
          .filter(([, v]) => v.trim() !== "")
          .map(([k, v]) => [k, /^\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN]),
      ),
      proofUrls: proofs.map((p) => p.trim()).filter(Boolean),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    const parsed = LinkSubmissionInput.safeParse(body);
    const bad = new Set<string>();
    if (!parsed.success) for (const i of parsed.error.issues) bad.add(i.path.join("."));
    if (postedOn > today) bad.add("postedOn");
    setIssues(bad);
    if (bad.size) {
      setError(errorMessage("VALIDATION", locale));
      return;
    }
    setBusy(true);
    try {
      const r = await call("POST", `${base}/submissions`, locale, body);
      if (r.status === 201) {
        setPostUrl("");
        setMetrics({});
        setProofs([""]);
        setNote("");
        await onSubmitted();
      } else if (r.status === 410) {
        onDead({ kind: "expired", reason: ((r.data as Problem | null)?.params?.reason as string | undefined) ?? null });
      } else if (r.status === 404) {
        onDead({ kind: "not_found" });
      } else {
        const p = r.data as (Problem & { code?: ErrorCode }) | null;
        const code = (p?.code ?? (r.status === 429 ? "RATE_LIMITED" : "INTERNAL")) as ErrorCode;
        const serverIssues = (p?.params?.issues as { path?: string }[] | undefined) ?? [];
        setIssues(new Set(serverIssues.map((i) => String(i.path ?? ""))));
        setError(errorMessage(code, locale));
      }
    } catch {
      setError(errorMessage("INTERNAL", locale));
    } finally {
      setBusy(false);
    }
  };
  const bad = (path: string) => [...issues].some((i) => i === path || i.startsWith(`${path}.`));

  return (
    <div className="link-body" data-testid="link-active">
      <h1 data-testid="link-title">{x("title")}</h1>
      <p>{x("intro")}</p>
      <dl className="facts link-facts">
        <dt>{i18n.t("influencer")}</dt>
        <dd data-testid="link-influencer">{info.influencer.displayName}</dd>
        <dt>{i18n.t("project")}</dt>
        <dd>{info.project.name}</dd>
        <dt>{x("deliverable")}</dt>
        <dd data-testid="link-deliverable">{deliverable}</dd>
        <dt>{x("contractedPosts")}</dt>
        <dd>{info.contractedPosts}</dd>
      </dl>
      <p className="notice" data-testid="link-remaining" data-remaining={info.submissions.remaining}>
        {x("remaining", { remaining: String(info.submissions.remaining), max: String(info.submissions.max) })}
        <br />
        <span data-testid="link-expires">{x("expiresOn", { date: expires })}</span>
      </p>
      {thanks ? (
        <div className="ok link-thanks" data-testid="link-thanks" role="status">
          <p>{x("submitted")}</p>
          {info.submissions.remaining > 0 && (
            <button onClick={onAnother} data-testid="link-another">
              {i18n.t("submitAnother")}
            </button>
          )}
        </div>
      ) : (
        info.submissions.remaining > 0 && (
          <form className="card link-form-card" onSubmit={submit} noValidate data-testid="link-form">
            {error && (
              <div role="alert" className="error" data-testid="link-error-msg">
                {error}
              </div>
            )}
            <label className="field">
              <span>{x("postUrl")}</span>
              <input
                type="url"
                inputMode="url"
                value={postUrl}
                onChange={(e) => setPostUrl(e.target.value)}
                maxLength={info.accepts.urlMaxLength}
                placeholder="https://"
                aria-invalid={bad("postUrl")}
                required
                data-testid="link-post-url"
              />
              <small className="muted">{x("postUrlHint")}</small>
            </label>
            <label className="field">
              <span>{x("postedOn")}</span>
              <input
                type="date"
                value={postedOn}
                max={today}
                onChange={(e) => setPostedOn(e.target.value)}
                aria-invalid={bad("postedOn")}
                required
                data-testid="link-posted-on"
              />
            </label>
            <fieldset className="roles link-metrics">
              <legend>{x("metrics")}</legend>
              <div className="metric-grid">
                {LINK_METRIC_KEYS.filter((k) => info.accepts.metrics.includes(k)).map((k) => (
                  <label key={k} className="field">
                    <span>{x(METRIC_TEXT[k]!)}</span>
                    <input
                      inputMode="numeric"
                      value={metrics[k] ?? ""}
                      onChange={(e) => setMetrics({ ...metrics, [k]: e.target.value })}
                      aria-invalid={bad(`metrics.${k}`) || bad("metrics")}
                      data-testid={`link-metric-${k}`}
                    />
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="roles">
              <legend>{x("proofUrls")}</legend>
              <small className="muted">{x("proofUrlsHint")}</small>
              {proofs.map((p, i) => (
                <div key={i} className="row nowrap proof-row">
                  <input
                    type="url"
                    inputMode="url"
                    value={p}
                    onChange={(e) => setProofs(proofs.map((q, j) => (j === i ? e.target.value : q)))}
                    placeholder="https://"
                    aria-invalid={bad(`proofUrls.${i}`)}
                    aria-label={`${x("proofUrls")} ${i + 1}`}
                    data-testid={`link-proof-${i}`}
                  />
                  {proofs.length > 1 && (
                    <button type="button" onClick={() => setProofs(proofs.filter((_, j) => j !== i))} aria-label="−">
                      −
                    </button>
                  )}
                </div>
              ))}
              {proofs.length < maxProofs && (
                <button
                  type="button"
                  className="link small"
                  onClick={() => setProofs([...proofs, ""])}
                  data-testid="link-add-proof"
                >
                  + {i18n.t("addProofLink")}
                </button>
              )}
            </fieldset>
            <label className="field">
              <span>{x("note")}</span>
              <textarea
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={info.accepts.noteMaxLength}
                aria-invalid={bad("note")}
                data-testid="link-note"
              />
            </label>
            <button className="primary big" disabled={busy} data-testid="link-submit">
              {x("submit")}
            </button>
          </form>
        )
      )}
      {info.mine.length > 0 && (
        <div className="card">
          <h2>{x("yourSubmissions")}</h2>
          <ul className="list" data-testid="link-mine">
            {info.mine.map((m, i) => (
              <li key={i} data-status={m.status} data-url={m.postUrl}>
                <div className="break">{m.postUrl}</div>
                <div className="small muted">
                  {m.postedOn} · <span className={`badge work-${m.status}`}>{x(STATUS_TEXT[m.status])}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="small muted privacy" data-testid="link-privacy">
        {x("privacyNotice")}
      </p>
    </div>
  );
}
