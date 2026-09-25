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
