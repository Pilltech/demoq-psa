// Sprint 4 pages in English and Khmer at phone width: my week, leave and holidays, team time, the delivery board, the
// inbox, the influencer roster and a project's influencers. No untranslated keys and no KM-DRAFT markers reach the
// screen, and nothing scrolls sideways. Runs in the phone project too, so it depends on no other test's state.
import { expect, test, type Page } from "@playwright/test";
import { noSideScroll, signIn } from "./helpers";

const KHMER = /[ក-៿]/;
/** A dictionary key on screen ("taskStatus.done", "adm.holidays") means a missing translation. */
const RAW_KEY = /\b(?:[a-z]+[A-Z][A-Za-z]*|adm)\.[a-z_]+\b/;

async function signedIn(page: Page, email: string) {
  await page.context().clearCookies(); // switch person within a test
  await signIn(page, email);
  await expect(page.getByTestId("sign-out")).toBeVisible();
}

async function checkPage(page: Page, testId: string, khmer: boolean) {
  await expect(page.getByTestId(testId)).toBeVisible();
  await expect(page.locator("main")).not.toContainText("KM-DRAFT");
  const text = await page.locator("body").innerText();
  expect(text, `untranslated key on ${testId}`).not.toMatch(RAW_KEY);
  if (khmer) expect(await page.locator("main h1").first().innerText()).toMatch(KHMER);
  expect(await noSideScroll(page), `${testId} scrolls sideways`).toBe(true);
}

async function setLocale(page: Page, locale: "en" | "km") {
  const current = await page.locator("html").getAttribute("lang");
  if (current !== locale) await page.getByTestId("toggle-locale").click();
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
}

test("@phone [TIM-TS-05][TIM-LV-01][TIM-TS-08][TSK-DL-12] the time, leave, team, task and inbox pages render in English and Khmer on a phone", async ({
  page,
}) => {
  await signedIn(page, "chanthy@demoq.test");
  for (const locale of ["en", "km"] as const) {
    await setLocale(page, locale);
    const km = locale === "km";
    await page.getByTestId("nav-time").click();
    await checkPage(page, "my-week", km);
    await expect(page.getByTestId("week-confirm").or(page.getByTestId("week-locked"))).toBeVisible();
    await expect(page.getByTestId("clock")).toBeVisible();
    await page.getByTestId("tab-leave").click();
    await checkPage(page, "leave-page", km);
    if (km) await expect(page.getByTestId("holiday-list")).toContainText("មិនទាន់ផ្ទៀងផ្ទាត់"); // unverified
    await page.getByTestId("tab-team").click();
    await checkPage(page, "team-time", km);
    await page.getByTestId("nav-tasks").click();
    await checkPage(page, "task-board", km);
    if (km) await expect(page.getByTestId("task-column-internal_review").locator("h3")).toContainText(KHMER);
    await page.getByTestId("nav-inbox").click();
    await checkPage(page, "inbox-tab-pending", km);
  }
  await setLocale(page, "en"); // leave English for later tests
});

test("@phone [INF-RS-01][INF-LK-10] the influencer roster and a project's influencers render in English and Khmer on a phone", async ({
  page,
}) => {
  await signedIn(page, "malis@demoq.test");
  for (const locale of ["en", "km"] as const) {
    await setLocale(page, locale);
    const km = locale === "km";
    await page.getByTestId("nav-influencers").click();
    await checkPage(page, "influencer-roster", km);
    await page.getByTestId("nav-projects").click();
    await page.getByTestId("projects-all").click();
    await page.locator('[data-name="Lotus Demo Crafts — Craft fair launch"]').getByTestId("project-link").click();
    await page.getByTestId("project-tab-influencers").click();
    await expect(page.getByTestId("project-influencers")).toBeVisible();
    await expect(page.locator("main")).not.toContainText("KM-DRAFT");
    expect(await page.locator("body").innerText()).not.toMatch(RAW_KEY);
    if (km) await expect(page.getByTestId("project-tab-influencers")).toContainText(KHMER);
    expect(await noSideScroll(page)).toBe(true);
  }
  await setLocale(page, "en");
});
