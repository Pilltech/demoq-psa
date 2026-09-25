// Minimal path router (history API). Enough for S1; swap for TanStack Router when routes grow.
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

const listeners = new Set<() => void>();
export function navigate(to: string) {
  window.history.pushState(null, "", to);
  listeners.forEach((l) => l());
}
export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return path;
}
export function Link({ to, children, className, testId }: { to: string; children: ReactNode; className?: string; testId?: string }) {
  const onClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} className={className} data-testid={testId}>
      {children}
    </a>
  );
}
