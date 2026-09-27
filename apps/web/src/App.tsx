import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ApiError, auth, hasPerm, op, setLocaleGetter, type Me } from "./api";
import { useInbox } from "./queries";
import { I18nProvider, makeI18n, useI18n } from "./i18n";
import { Link, usePath } from "./router";
import { Login } from "./pages/Login";
import { Totp } from "./pages/Totp";
import { Pipeline } from "./pages/Pipeline";
import { Clients } from "./pages/Clients";
import { ClientPage } from "./pages/ClientPage";
import { Admin } from "./pages/Admin";
import { FxRates } from "./pages/FxRates";
import { Inbox } from "./pages/Inbox";
import { Pricing } from "./pages/Pricing";
import { Profile } from "./pages/Profile";
import { QuotePage } from "./pages/QuotePage";
import { Projects } from "./pages/Projects";
import { ProjectPage, type ProjectTab } from "./pages/ProjectPage";
import { ChangeOrderRedirect } from "./pages/ChangeOrders";
import { MyTasks } from "./pages/TaskBoard";
import { TaskTemplates } from "./pages/TaskTemplates";
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
                await auth.logout().catch(() => {});
                // A full reload drops every cached query and in-memory state of the previous user.
                // (clear() + invalidate left the "me" observer holding the old user, so the UI stayed signed in.)
                window.location.assign("/");
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
  const inbox = useInbox(me);
  const waiting = inbox.data?.filter((a) => a.canDecide).length ?? 0;
  return (
    <nav>
      {hasPerm(me, "deal.view") && (
        <Link to="/pipeline" testId="nav-pipeline">
          {t("pipeline")}
        </Link>
      )}
      <Link to="/clients" testId="nav-clients">
        {t("clients")}
      </Link>
      {hasPerm(me, "project.view") && (
        <Link to="/projects" testId="nav-projects">
          {t("projects")}
        </Link>
      )}
      {hasPerm(me, "project.view") && (
        <Link to="/tasks" testId="nav-tasks">
          {t("myTasks")}
        </Link>
      )}
      {hasPerm(me, "approval.view") && (
        <Link to="/inbox" testId="nav-inbox">
          {t("inbox")}
          {waiting > 0 && (
            <span className="pill" data-testid="inbox-count">
              {waiting}
            </span>
          )}
        </Link>
      )}
      {hasPerm(me, "fx.manage") && (
        <Link to="/finance/fx" testId="nav-fx">
          {t("fxRates")}
        </Link>
      )}
      {(hasPerm(me, "user.manage") || hasPerm(me, "admin.config")) && (
        <Link to={hasPerm(me, "user.manage") ? "/admin" : "/admin/pricing"} testId="nav-admin">
          {t("admin")}
        </Link>
      )}
      {hasPerm(me, "profile.manage") && (
        <Link to="/profile" testId="nav-profile">
          {t("profile")}
        </Link>
      )}
    </nav>
  );
}

function Shell({ me }: { me: Me }) {
  const path = usePath();
  const clientMatch = /^\/clients\/([0-9a-f-]{36})$/.exec(path);
  if (clientMatch) return <ClientPage id={clientMatch[1]!} me={me} />;
  if (path.startsWith("/clients")) return <Clients me={me} />;
  const quoteMatch = /^\/quotes\/([0-9a-f-]{36})$/.exec(path);
  if (quoteMatch && hasPerm(me, "deal.view")) return <QuotePage key={quoteMatch[1]} id={quoteMatch[1]!} me={me} />;
  if (hasPerm(me, "project.view")) {
    const m = /^\/projects\/([0-9a-f-]{36})(?:\/(tasks|change-orders)(?:\/([0-9a-f-]{36}))?)?$/.exec(path);
    if (m) {
      const tab: ProjectTab = m[2] === "tasks" ? "tasks" : m[2] === "change-orders" ? "change-orders" : "overview";
      return <ProjectPage key={m[1]} id={m[1]!} tab={tab} coId={m[3]} me={me} />;
    }
    if (path.startsWith("/projects")) return <Projects me={me} />;
    const co = /^\/change-orders\/([0-9a-f-]{36})$/.exec(path);
    if (co) return <ChangeOrderRedirect id={co[1]!} />;
    if (path.startsWith("/tasks")) return <MyTasks me={me} />;
  }
  if (path.startsWith("/inbox") && hasPerm(me, "approval.view")) return <Inbox me={me} />;
  if (path.startsWith("/profile") && hasPerm(me, "profile.manage")) return <Profile me={me} />;
  if (path.startsWith("/finance/fx") && hasPerm(me, "fx.manage")) return <FxRates me={me} />;
  if (path.startsWith("/admin/pricing") && hasPerm(me, "admin.config")) return <Pricing me={me} />;
  if (path.startsWith("/admin/templates") && hasPerm(me, "admin.config")) return <TaskTemplates me={me} />;
  if (path.startsWith("/admin") && hasPerm(me, "user.manage")) return <Admin me={me} />;
  if (hasPerm(me, "deal.view")) return <Pipeline me={me} />;
  return <Clients me={me} />;
}
