import { useState, type FormEvent } from "react";
import { auth } from "../api";
import { ErrorBanner, Field } from "../components/ui";
import { useI18n } from "../i18n";

export function Login({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.login(email, password);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card narrow" onSubmit={submit} data-testid="login-form">
      <h1>{t("signIn")}</h1>
      <ErrorBanner error={error} />
      <Field label={t("email")}>
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required data-testid="login-email" />
      </Field>
      <Field label={t("password")}>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required data-testid="login-password" />
      </Field>
      <button className="primary" disabled={busy} data-testid="login-submit">
        {t("signIn")}
      </button>
    </form>
  );
}
