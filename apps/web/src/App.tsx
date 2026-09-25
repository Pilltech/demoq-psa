import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ApiError, auth, hasPerm, op, setLocaleGetter, type Me } from "./api";
import { I18nProvider, makeI18n, useI18n } from "./i18n";
import { Link, navigate, usePath } from "./router";
import { Login } from "./pages/Login";
import { Totp } from "./pages/Totp";
import { Pipeline } from "./pages/Pipeline";
import { Clients } from "./pages/Clients";
import { ClientPage } from "./pages/ClientPage";
import { Admin } from "./pages/Admin";
import type { Locale } from "@demoq/shared";

const LOCALE_KEY = "psa.locale";
const storedLocale = (): Locale | null => {
  try {
    const v = localStorage.getItem(LOCALE_KEY);
    return v === "km" || v === "en" ? v : null;
  } catch {
    return null;
  }
};

export function App() {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await auth.me();
      } catch (e) {
        if (e instanceof ApiError && e.code === "UNAUTHENTICATED") return null;
        throw e;
      }
    },
  });
  const [locale, setLocale] = useState<Locale>(storedLocale() ?? "en");
  useEffect(() => {
    if (me.data?.user && !storedLocale()) setLocale(me.data.user.locale);
  }, [me.data]);
  const i18n = useMemo(() => makeI18n(locale), [locale]);
  useEffect(() => {
    setLocaleGetter(() => locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const toggleLocale = async () => {
    const next: Locale = locale === "en" ? "km" : "en";
    setLocale(next);
    try {
      localStorage.setItem(LOCALE_KEY, next);
    } catch {
      /* private mode */
    }
    if (me.data?.totp === "ok") await op("user.set_locale", { locale: next }).catch(() => {});
  };

  let body;
  if (me.isLoading) body = <p className="center">{i18n.t("loading")}</p>;
  else if (!me.data) body = <Login onDone={() => qc.invalidateQueries({ queryKey: ["me"] })} />;
  else if (me.data.totp !== "ok") body = <Totp mode={me.data.totp} onDone={() => qc.invalidateQueries({ queryKey: ["me"] })} />;
  else body = <Shell me={me.data.user} />;

  return (
    <I18nProvider value={i18n}>
      <div className={`app locale-${locale}`}>
        <header className="topbar">
          <strong className="brand">{i18n.t("appName")}</strong>
          {me.data?.totp === "ok" && <Nav me={me.data.user} />}
          <span className="spacer" />
          <button className="link" onClick={toggleLocale} data-testid="toggle-locale">
            {i18n.t("language")}
          </button>
          {me.data && (
            <button
              className="link"
              data-testid="sign-out"
              onClick={async () => {
                await auth.logout();
                qc.clear();
                navigate("/");
                await qc.invalidateQueries({ queryKey: ["me"] });
              }}
            >
              {i18n.t("signOut")}
            </button>
          )}
        </header>
        <main>{body}</main>
      </div>
    </I18nProvider>
  );
}

function Nav({ me }: { me: Me }) {
  const { t } = useI18n();
  return (
    <nav>
      {hasPerm(me, "deal.view") && <Link to="/pipeline" testId="nav-pipeline">{t("pipeline")}</Link>}
      <Link to="/clients" testId="nav-clients">{t("clients")}</Link>
      {hasPerm(me, "user.manage") && <Link to="/admin" testId="nav-admin">{t("admin")}</Link>}
    </nav>
  );
}

function Shell({ me }: { me: Me }) {
  const path = usePath();
  const clientMatch = /^\/clients\/([0-9a-f-]{36})$/.exec(path);
  if (clientMatch) return <ClientPage id={clientMatch[1]!} me={me} />;
  if (path.startsWith("/clients")) return <Clients me={me} />;
  if (path.startsWith("/admin") && hasPerm(me, "user.manage")) return <Admin />;
  if (hasPerm(me, "deal.view")) return <Pipeline me={me} />;
  return <Clients me={me} />;
}
