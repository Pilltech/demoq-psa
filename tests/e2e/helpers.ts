import { expect, request, type Page } from "@playwright/test";
import { Secret, TOTP } from "otpauth";

export const PASSWORD = "demoq-demo-2026"; // synthetic seed (packages/testkit/src/seed.ts)

export async function signIn(page: Page, email: string) {
  await page.goto("/");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(PASSWORD);
  await page.getByTestId("login-submit").click();
}

/** Complete TOTP enrolment the way a person would: read the key shown, type the current code. */
export async function enrolTotp(page: Page) {
  await expect(page.getByTestId("totp-form")).toBeVisible();
  const secret = (await page.getByTestId("totp-secret").textContent())!.trim();
  const code = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate();
  await page.getByTestId("totp-code").fill(code);
  await page.getByTestId("totp-submit").click();
  return secret;
}

export const card = (page: Page, title: string) => page.locator(`[data-title="${title}"]`);

const TOTP_PERIOD_MS = 30_000;
export const totpStep = (at = Date.now()) => Math.floor(at / TOTP_PERIOD_MS);

/**
 * A code from a later 30-second step than `afterStep` (the server refuses a replayed step), waiting for the
 * next step if needed. Returns the code and its step, to chain further codes.
 */
export async function freshTotpCode(secret: string, afterStep: number) {
  while (totpStep() <= afterStep) await new Promise((r) => setTimeout(r, 500));
  const now = Date.now();
  const code = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate({ timestamp: now });
  return { code, step: totpStep(now) };
}

/** Call an op as the signed-in browser user (shares the page's session cookie). */
export async function api<T = unknown>(page: Page, name: string, input: unknown = {}): Promise<T> {
  const res = await page.request.post(`/api/v1/ops/${name}`, { data: input, headers: { "x-psa-csrf": "1" } });
  const body = await res.text();
  expect(res.ok(), `${name} → ${res.status()} ${body}`).toBeTruthy();
  return JSON.parse(body) as T;
}

/** Call an op and return the status and body even when it is refused. */
export async function apiRaw(page: Page, name: string, input: unknown = {}) {
  const res = await page.request.post(`/api/v1/ops/${name}`, { data: input, headers: { "x-psa-csrf": "1" } });
  return { status: res.status(), body: (await res.json()) as { code?: string } & Record<string, unknown> };
}

/** A signed-in API session for another person (no browser), for steps that are not what a test is about. */
export async function apiSession(email: string, baseURL = "http://127.0.0.1:3100") {
  const ctx = await request.newContext({ baseURL, extraHTTPHeaders: { "x-psa-csrf": "1" } });
  const login = await ctx.post("/api/v1/auth/login", { data: { email, password: PASSWORD } });
  expect(login.ok(), `login ${email} → ${login.status()}`).toBeTruthy();
  const raw = async (name: string, input: unknown = {}) => {
    const res = await ctx.post(`/api/v1/ops/${name}`, { data: input });
    return { status: res.status(), body: (await res.json()) as Record<string, unknown> & { code?: string } };
  };
  return {
    raw,
    op: async <T = Record<string, unknown>>(name: string, input: unknown = {}): Promise<T> => {
      const r = await raw(name, input);
      expect(r.status < 300, `${email} ${name} → ${r.status} ${JSON.stringify(r.body)}`).toBeTruthy();
      return r.body as T;
    },
    dispose: () => ctx.dispose(),
  };
}

/** No horizontal page scroll (a string, so the root tsconfig without the DOM lib does not type-check it). */
export const noSideScroll = (page: Page) =>
  page.evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth + 1");

/** Today in Phnom Penh (YYYY-MM-DD), where business dates live. */
export const ppToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Phnom_Penh" }).format(new Date());
export const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const mondayOf = (d: string) => {
  const w = new Date(`${d}T00:00:00Z`).getUTCDay();
  return addDays(d, 1 - (w === 0 ? 7 : w));
};
