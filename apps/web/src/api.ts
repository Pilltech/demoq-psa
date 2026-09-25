// Thin client for the generated REST adapter. All business rules live on the server.
import type { ErrorCode, Problem } from "@demoq/shared";

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.title);
  }
  get code(): ErrorCode {
    return this.problem.code;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-psa-csrf": "1", "accept-language": currentLocale() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data as Problem);
  return data as T;
}

let localeGetter: () => string = () => "en";
export const setLocaleGetter = (fn: () => string) => (localeGetter = fn);
const currentLocale = () => localeGetter();

export const op = <T>(name: string, input: unknown = {}) => request<T>("POST", `/api/v1/ops/${name}`, input);

export interface Me {
  id: string;
  name: string;
  email: string;
  roles: string[];
  teamId: string | null;
  locale: "en" | "km";
  permissions: Record<string, ("any" | "team" | "own" | "assigned")[]>;
}
export type TotpState = "ok" | "verify" | "enroll";

export const auth = {
  me: () => request<{ user: Me; totp: TotpState }>("GET", "/api/v1/auth/me"),
  login: (email: string, password: string) =>
    request<{ user: Me; totp: TotpState }>("POST", "/api/v1/auth/login", { email, password }),
  logout: () => request<{ ok: true }>("POST", "/api/v1/auth/logout", {}),
  enroll: () => request<{ secret: string; uri: string }>("POST", "/api/v1/auth/totp/enroll", {}),
  verify: (code: string) => request<{ ok: true }>("POST", "/api/v1/auth/totp/verify", { code }),
};

export const hasPerm = (me: Me | undefined, p: string) => !!me?.permissions[p]?.length;
