import { expect, type Page } from "@playwright/test";
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
