// Finance → FX rates (COM-CF-05/06): today's USD→KHR rate, and the recent ones.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { hasPerm, op, type Me } from "../api";
import { ErrorBanner, Field } from "../components/ui";
import { microsToRate, phnomPenhToday } from "../format";
import { useI18n } from "../i18n";
import type { FxRate } from "../types";

export function FxRates({ me }: { me: Me }) {
  const { t, date } = useI18n();
  const qc = useQueryClient();
  const rates = useQuery({
    queryKey: ["fx-rates"],
    enabled: hasPerm(me, "pricing.view"),
    queryFn: () => op<FxRate[]>("fx_rate.list", { limit: 30 }),
  });
  const [rateDate, setRateDate] = useState(phnomPenhToday());
  const [rate, setRate] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const valid = /^\d{1,6}(\.\d{1,6})?$/.test(rate.trim()) && !/^0+(\.0+)?$/.test(rate.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await op("fx_rate.set", { rateDate, khrPerUsd: rate.trim() });
      setRate("");
      setSaved(true);
      await qc.invalidateQueries({ queryKey: ["fx-rates"] });
    } catch (err) {
      setError(err);
    }
  };

  return (
    <section>
      <div className="toolbar">
        <h1>{t("fxRates")}</h1>
      </div>
      <div className="grid2">
        <form className="card" onSubmit={submit} data-testid="fx-form">
          <p className="muted">{t("fxHelp")}</p>
          <ErrorBanner error={error} />
          {saved && (
            <p className="ok" role="status" data-testid="fx-saved">
              {t("saved")}
            </p>
          )}
          <div className="row">
            <Field label={t("rateDate")}>
              <input type="date" value={rateDate} onChange={(e) => setRateDate(e.target.value)} required data-testid="fx-date" />
            </Field>
            <Field label={t("khrPerUsd")}>
              <input
                inputMode="decimal"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="4100"
                aria-invalid={rate !== "" && !valid}
                required
                data-testid="fx-rate"
              />
            </Field>
          </div>
          <button className="primary" disabled={!valid} data-testid="fx-submit">
            {t("saveRate")}
          </button>
        </form>
        <div className="card">
          <h2>{t("recentRates")}</h2>
          <table className="table" data-testid="fx-list">
            <thead>
              <tr>
                <th>{t("rateDate")}</th>
                <th className="num">{t("khrPerUsd")}</th>
                <th className="muted small" />
              </tr>
            </thead>
            <tbody>
              {rates.data?.map((r) => (
                <tr key={r.id} data-testid={`fx-${r.rate_date}`}>
                  <td>{r.rate_date}</td>
                  <td className="num">{microsToRate(r.rate_micros)}</td>
                  <td className="muted small">{date(r.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rates.data?.length === 0 && <p className="muted">{t("noItems")}</p>}
        </div>
      </div>
    </section>
  );
}
