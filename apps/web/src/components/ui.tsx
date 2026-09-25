import { useEffect, useRef, type ReactNode } from "react";
import { ApiError } from "../api";
import { useI18n } from "../i18n";

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
