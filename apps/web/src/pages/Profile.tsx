// My profile: link Telegram (TG-02) and personal access tokens for Claude Code / MCP (MCP-03, MCP-04).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { op, type Me } from "../api";
import { ErrorBanner, Field } from "../components/ui";
import { useI18n } from "../i18n";
import type { ApiToken, Profile as ProfileData } from "../types";

const BOT = (import.meta.env.VITE_TELEGRAM_BOT as string | undefined) ?? "DemoQBot";

export function Profile({ me }: { me: Me }) {
  const { t } = useI18n();
  const profile = useQuery({ queryKey: ["profile"], queryFn: () => op<ProfileData>("profile.get", {}) });
  return (
    <section>
      <h1>{t("profile")}</h1>
      <p className="muted">
        {me.name} · {me.email}
      </p>
      <ErrorBanner error={profile.error} />
      {profile.data && (
        <div className="grid2">
          <Telegram linked={profile.data.telegramLinked} />
          <Tokens tokens={profile.data.tokens} readOnly={profile.data.readOnlyTokens} />
        </div>
      )}
    </section>
  );
}

function Telegram({ linked }: { linked: boolean }) {
  const { t, date } = useI18n();
  const qc = useQueryClient();
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const getCode = async () => {
    setError(null);
    try {
      setCode(await op<{ code: string; expiresAt: string }>("telegram.link_code", {}));
    } catch (e) {
      setError(e);
    }
  };
  const unlink = async () => {
    setError(null);
    try {
      await op("telegram.unlink", {});
      setCode(null);
      await qc.invalidateQueries({ queryKey: ["profile"] });
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="card" data-testid="telegram-card">
      <h2>{t("telegram")}</h2>
      <ErrorBanner error={error} />
      <p data-testid="telegram-status" data-linked={linked}>
        {linked ? t("telegramLinked") : t("telegramNotLinked")}
      </p>
      {code && (
        <div className="code-box" data-testid="telegram-code-box">
          <p>{t("telegramInstruction", { bot: BOT })}</p>
          <pre data-testid="telegram-command">{`/start ${code.code}`}</pre>
          <p className="muted small">{t("codeExpires", { when: date(code.expiresAt) })}</p>
        </div>
      )}
      <div className="actions">
        {linked && (
          <button onClick={unlink} data-testid="telegram-unlink">
            {t("unlink")}
          </button>
        )}
        <button className="primary" onClick={getCode} data-testid="telegram-link">
          {t("linkTelegram")}
        </button>
      </div>
    </div>
  );
}

function Tokens({ tokens, readOnly }: { tokens: ApiToken[]; readOnly: boolean }) {
  const { t, date } = useI18n();
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [write, setWrite] = useState(false);
  const [days, setDays] = useState("30");
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await op<{ token: string }>("token.create", {
        label,
        scopes: write && !readOnly ? ["read", "write"] : ["read"],
        days: Number(days),
      });
      setCreated(r.token);
      setLabel("");
      setWrite(false);
      await qc.invalidateQueries({ queryKey: ["profile"] });
    } catch (err) {
      setError(err);
    }
  };
  const revoke = async (id: string) => {
    setError(null);
    try {
      await op("token.revoke", { id });
      await qc.invalidateQueries({ queryKey: ["profile"] });
    } catch (err) {
      setError(err);
    }
  };
  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      /* clipboard blocked: the text is selectable */
    }
  };
  const snippet = JSON.stringify(
    {
      mcpServers: {
        demoq: { type: "http", url: `${window.location.origin}/mcp`, headers: { Authorization: "Bearer ${DEMOQ_PAT}" } },
      },
    },
    null,
    2,
  );
  const now = Date.now();

  return (
    <div className="card" data-testid="tokens-card">
      <h2>{t("accessTokens")}</h2>
      <p className="muted small">{t("tokensHelp")}</p>
      <ErrorBanner error={error} />
      {created && (
        <div className="code-box" data-testid="token-created">
          <p className="notice">{t("tokenOnce")}</p>
          <div className="row nowrap">
            <code className="secret" data-testid="token-value">
              {created}
            </code>
            <button type="button" onClick={() => copy("token", created)} data-testid="token-copy">
              {copied === "token" ? t("copied") : t("copy")}
            </button>
          </div>
          <p className="small">{t("mcpSnippetHelp")}</p>
          <pre data-testid="mcp-snippet">{snippet}</pre>
          <div className="actions">
            <button type="button" onClick={() => copy("snippet", snippet)}>
              {copied === "snippet" ? t("copied") : t("copy")}
            </button>
            <button
              type="button"
              onClick={() => {
                setCreated(null);
                setCopied(null);
              }}
              data-testid="token-done"
            >
              {t("done")}
            </button>
          </div>
        </div>
      )}
      <form onSubmit={create} className="inline-form" data-testid="token-form">
        <div className="row">
          <Field label={t("tokenLabel")}>
            <input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={80} data-testid="token-label" />
          </Field>
          <Field label={t("validDays")}>
            <input type="number" min={1} max={30} value={days} onChange={(e) => setDays(e.target.value)} required />
          </Field>
        </div>
        <fieldset className="roles">
          <legend>{t("scopes")}</legend>
          <label className="check">
            <input type="checkbox" checked disabled /> {t("scope.read")}
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={write && !readOnly}
              disabled={readOnly}
              onChange={(e) => setWrite(e.target.checked)}
              data-testid="token-scope-write"
            />{" "}
            {t("scope.write")}
          </label>
          {readOnly && <p className="muted small">{t("readOnlyHint")}</p>}
        </fieldset>
        <button className="primary" data-testid="token-create">
          {t("createToken")}
        </button>
      </form>
      <ul className="list" data-testid="token-list">
        {tokens.map((tk) => {
          const expired = new Date(tk.expires_at).getTime() < now;
          const live = !tk.revoked_at && !expired;
          return (
            <li key={tk.id} className="token-row" data-testid={`token-${tk.label}`}>
              <div>
                <strong>{tk.label}</strong> <code>{tk.prefix}…</code> <span className="tag">{tk.scopes.join(" + ")}</span>
                {tk.revoked_at && <span className="tag danger">{t("revoked")}</span>}
                {!tk.revoked_at && expired && <span className="tag">{t("expired")}</span>}
                <div className="muted small">
                  {t("expiresAt", { when: date(tk.expires_at) })} ·{" "}
                  {tk.last_used_at ? t("lastUsed", { when: date(tk.last_used_at) }) : t("neverUsed")}
                </div>
              </div>
              {live && (
                <button onClick={() => revoke(tk.id)} data-testid={`token-revoke-${tk.label}`}>
                  {t("revoke")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
