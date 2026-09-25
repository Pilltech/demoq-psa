// E2E for crm/close-reason (specs/crm/close-reason.md) — the S1 demo script, automated.
import { expect, test } from "@playwright/test";
import { card, enrolTotp, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });

test("[CRM-CR-01] an account lead drags a deal to Lost: a reason is demanded, cancel keeps it open, a reason closes it", async ({ page }) => {
  await signIn(page, "sokha@demoq.test");
  const title = "Khmer New Year TikTok campaign";
  await expect(card(page, title)).toBeVisible();
  await expect(page.getByTestId("column-proposal").locator(`[data-title="${title}"]`)).toBeVisible();

  await card(page, title).dragTo(page.getByTestId("column-lost"));
  await expect(page.getByTestId("lost-modal")).toBeVisible();
  await expect(page.getByTestId("lost-confirm")).toBeDisabled();
  await page.getByTestId("lost-cancel").click();
  await expect(page.getByTestId("column-proposal").locator(`[data-title="${title}"]`)).toBeVisible();

  await card(page, title).dragTo(page.getByTestId("column-lost"));
  await page.getByTestId("lost-reason").selectOption("competitor");
  await page.getByTestId("lost-note").fill("Chose a regional network agency");
  await page.getByTestId("lost-confirm").click();
  await expect(page.getByTestId("column-lost").locator(`[data-title="${title}"]`)).toBeVisible();

  await card(page, title).getByRole("button", { name: title }).click();
  const history = page.getByTestId("history");
  await expect(history).toContainText("competitor");
  await expect(history).toContainText("Chose a regional network agency");
  await expect(history).toContainText("Sokha Lead");
});

test("[CRM-CR-03] dropping on Won is refused with the reason why", async ({ page }) => {
  await signIn(page, "sokha@demoq.test");
  await card(page, "Q1 always-on social").dragTo(page.getByTestId("column-won"));
  await expect(page.getByTestId("error")).toHaveAttribute("data-code", "WIN_REQUIRES_QUOTE");
  await expect(page.getByTestId("column-qualified").locator('[data-title="Q1 always-on social"]')).toBeVisible();
});

test("[CRM-CR-07] Khmer: labels and the server's error message switch to Khmer", async ({ page }) => {
  await signIn(page, "sokha@demoq.test");
  await page.getByTestId("toggle-locale").click();
  await expect(page.getByTestId("column-lost").locator("h3")).toContainText("ចាញ់");
  await card(page, "Q1 always-on social").dragTo(page.getByTestId("column-won"));
  await expect(page.getByTestId("error")).toContainText(/[ក-៿]/);
  await page.getByTestId("toggle-locale").click(); // leave English for later tests
});

test("[CRM-CR-10] another account lead cannot drag Sokha's deals", async ({ page }) => {
  await signIn(page, "dara@demoq.test");
  const c = card(page, "5G launch influencer push");
  await expect(c).toBeVisible();
  await expect(c).toHaveAttribute("draggable", "false");
  await expect(page.locator('[data-testid^="move-"]').first()).toBeVisible(); // Dara's own deals are movable
  await expect(c.locator("select")).toHaveCount(0);
});

test("[ID-AU-06][AUD-04] ops signs in with TOTP, reopens the lost deal, and sees who did what on which channel", async ({ page }) => {
  await signIn(page, "ops@demoq.test");
  await enrolTotp(page);
  const title = "Khmer New Year TikTok campaign";
  await card(page, title).getByRole("button", { name: title }).click();
  const audit = page.getByTestId("audit");
  await expect(audit).toContainText("deal.move");
  await expect(audit).toContainText("Sokha Lead");
  await expect(audit).toContainText("web");
  await page.getByTestId("reopen-reason").fill("Client asked for a revised proposal");
  await page.getByTestId("reopen-submit").click();
  await expect(page.getByTestId("drawer-stage")).toHaveText("Qualified");
  await expect(audit).toContainText("deal.reopen");
  await expect(audit).toContainText("Vanna Ops");
});

test("[CRM-CL-03] staff see clients but not the pipeline, and cannot create clients", async ({ page }) => {
  await signIn(page, "bopha@demoq.test");
  await expect(page.getByTestId("client-table")).toContainText("Angkor Beverages");
  await expect(page.getByTestId("nav-pipeline")).toHaveCount(0);
  await expect(page.getByTestId("new-client")).toHaveCount(0);
});

test("[CRM-CL-01][CRM-CL-04] an account lead creates a client with a Khmer name, adds a contact, and finds it by Khmer search", async ({ page }) => {
  await signIn(page, "dara@demoq.test");
  await page.getByTestId("nav-clients").click();
  await page.getByTestId("new-client").click();
  await page.getByTestId("client-name").fill("Tonle Sap Fisheries");
  await page.getByTestId("client-name-km").fill("ជលផលទន្លេសាប");
  await page.getByTestId("client-submit").click();
  await expect(page.getByTestId("client-title")).toContainText("Tonle Sap Fisheries");
  await page.getByTestId("contact-name").fill("Keo Sophea");
  await page.getByTestId("contact-submit").click();
  await expect(page.getByTestId("contacts")).toContainText("Keo Sophea");
  await page.getByTestId("nav-clients").click();
  await page.getByTestId("client-search").fill("ទន្លេសាប");
  await expect(page.getByTestId("client-table")).toContainText("Tonle Sap Fisheries");
});

test("@phone [CRM-CR-09] on a phone, deals move with the stage menu", async ({ page }) => {
  await signIn(page, "dara@demoq.test");
  const title = "Store opening event";
  const c = card(page, title);
  await c.locator("select").selectOption("qualified");
  await expect(page.getByTestId("column-qualified").locator(`[data-title="${title}"]`)).toBeVisible();
  await page.getByTestId("column-qualified").locator(`[data-title="${title}"] select`).selectOption("lead");
  await expect(page.getByTestId("column-lead").locator(`[data-title="${title}"]`)).toBeVisible();
});
