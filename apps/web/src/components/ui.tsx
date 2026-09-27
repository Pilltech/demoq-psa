import { useEffect, useRef, type ReactNode } from "react";
import { ApiError } from "../api";
import { useI18n } from "../i18n";
import { Link, usePath } from "../router";
import type { QuoteStatus } from "../types";

export function ErrorBanner({ error }: { error: unknown }) {
  const { err } = useI18n();
  if (!error) return null;
  const text = error instanceof ApiError ? err(error.code) : err("INTERNAL");
  const code = error instanceof ApiError ? error.code : "INTERNAL";
  return (
    <div role="alert" className="error" data-testid="error" data-code={code}>
      {text}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} onCancel={onClose} data-testid={testId} aria-label={title}>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function QuoteStatusBadge({ status, testId }: { status: QuoteStatus; testId?: string }) {
  const { t } = useI18n();
  return (
    <span className={`badge status-${status}`} data-status={status} data-testid={testId}>
      {t(`status.${status}`)}
    </span>
  );
}

/** Sub-navigation between sibling pages (e.g. Admin → Users / Pricing). */
export function Tabs({ items }: { items: { to: string; label: string; testId: string }[] }) {
  const path = usePath();
  return (
    <nav className="tabs">
      {items.map((it) => (
        <Link key={it.to} to={it.to} testId={it.testId} className={path === it.to ? "active" : ""}>
          {it.label}
        </Link>
      ))}
    </nav>
  );
}
