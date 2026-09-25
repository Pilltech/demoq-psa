import QRCode from "qrcode";
import { useEffect, useState, type FormEvent } from "react";
import { auth, type TotpState } from "../api";
import { ErrorBanner, Field } from "../components/ui";
import { useI18n } from "../i18n";

export function Totp({ mode, onDone }: { mode: Exclude<TotpState, "ok">; onDone: () => void }) {
  const { t } = useI18n();
  const [enrol, setEnrol] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (mode !== "enroll") return;
    auth
      .enroll()
      .then(async ({ secret, uri }) => setEnrol({ secret, qr: await QRCode.toDataURL(uri, { margin: 1, width: 200 }) }))
      .catch(setError);
  }, [mode]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await auth.verify(code.trim());
      onDone();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <form className="card narrow" onSubmit={submit} data-testid="totp-form">
      <h1>{mode === "enroll" ? t("totpEnrollTitle") : t("totpVerifyTitle")}</h1>
      {mode === "enroll" && (
        <>
          <p>{t("totpEnrollHelp")}</p>
          {enrol && (
            <div className="qr">
              <img src={enrol.qr} alt="QR" width={200} height={200} />
              <p className="muted">
                {t("totpManual")} <code data-testid="totp-secret">{enrol.secret}</code>
              </p>
            </div>
          )}
        </>
      )}
      <ErrorBanner error={error} />
      <Field label={t("totpCode")}>
        <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required data-testid="totp-code" />
      </Field>
      <button className="primary" data-testid="totp-submit">
        {t("verify")}
      </button>
    </form>
  );
}
