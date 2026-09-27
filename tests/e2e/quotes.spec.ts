// E2E for commercial/quote-builder and approvals/engine (specs/commercial/quote-builder.md,
// specs/approvals/engine.md) — the S2 demo script, automated, plus pricing admin, FX and profile screens.
import { expect, test, type Page } from "@playwright/test";
import { api, card, enrolTotp, freshTotpCode, signIn, totpStep } from "./helpers";

test.describe.configure({ mode: "serial" });

const DEAL = "5G launch influencer push"; // Sokha's, Mekong Telecom (seed)
const QUOTE_TITLE = "5G launch phase 1";
const APPROVAL_TITLE = `Mekong Telecom — ${QUOTE_TITLE} (v1)`;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Phnom_Penh" }).format(new Date());

let quoteUrl = "";
let financeSecret = "";
let financeStep = 0;

async function signedIn(page: Page, email: string) {
  await signIn(page, email);
  await expect(page.getByTestId("sign-out")).toBeVisible();
}

test("[COM-QB-02][COM-QB-05][COM-QB-13] an account lead builds a quote from the deal, sees the live margin fall below the floor, and submits it for approval", async ({
  page,
}) => {
  await signedIn(page, "sokha@demoq.test");
  await card(page, DEAL).getByRole("button", { name: DEAL }).click();
  await expect(page.getByTestId("deal-drawer")).toBeVisible();
  await page.getByTestId("new-quote").click();
  await page.getByTestId("new-quote-title").fill(QUOTE_TITLE);
  await expect(page.getByTestId("new-quote-rate-card")).toHaveValue(/.+/); // the seeded USD card is preselected
  await page.getByTestId("new-quote-submit").click();

  await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}$/);
  quoteUrl = new URL(page.url()).pathname;
  await expect(page.getByTestId("quote-title")).toHaveText(QUOTE_TITLE);
  await expect(page.getByTestId("quote-status")).toHaveAttribute("data-status", "draft");
  await expect(page.getByTestId("quote-version")).toHaveText("v1");
  await expect(page.getByTestId("quote-client")).toHaveText("Mekong Telecom");

  // A line from the rate card brings its price; its cost is the item's cost by default (COM-QB-13).
  await page.getByTestId("rate-card-pick").selectOption({ label: "SOC-POST — Social media post ($150.00 / post)" });
  await expect(page.getByTestId("line-desc-0")).toHaveValue("Social media post");
  await expect(page.getByTestId("line-price-0")).toHaveValue("150.00");
  await page.getByTestId("save-quote").click();
  await expect(page.getByTestId("quote-flash")).toBeVisible();
  await expect(page.getByTestId("line-cost-0")).toHaveValue("60.00");
  await expect(page.getByTestId("fee-margin")).toHaveText("60.00%");
  await expect(page.getByTestId("below-floor-warning")).toHaveCount(0);

  // Live margin on every keystroke, from the shared pricing function (COM-QB-02).
  await page.getByTestId("line-desc-0").fill("Launch campaign management");
  await page.getByTestId("line-price-0").fill("1,000");
  await page.getByTestId("line-cost-0").fill("700");
  await expect(page.getByTestId("fee-margin")).toHaveText("30.00%");
  await expect(page.getByTestId("below-floor-warning")).toHaveCount(0);
  await page.getByTestId("line-cost-0").fill("820");
  await expect(page.getByTestId("fee-margin")).toHaveText("18.00%");
  await expect(page.getByTestId("line-total-0")).toHaveText("$1,000.00");
  await expect(page.getByTestId("quote-total")).toHaveText("$1,000.00");
  await expect(page.getByTestId("below-floor-warning")).toHaveText("Below floor (25%) — needs Finance or Ops approval");

  // Typed floats are refused, not rounded.
  await page.getByTestId("line-qty-0").fill("1.2345");
  await expect(page.getByTestId("line-qty-0")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("save-quote")).toBeDisabled();
  await page.getByTestId("line-qty-0").fill("1");

  await page.getByTestId("save-quote").click();
  await expect(page.getByTestId("quote-flash")).toBeVisible();
  await expect(page.getByTestId("fee-margin")).toHaveText("18.00%"); // the server's figures agree
  await expect(page.getByTestId("send-on-approval")).not.toBeChecked();
  await page.getByTestId("submit-quote").click();

  await expect(page.getByTestId("quote-status")).toHaveAttribute("data-status", "margin_review");
  await expect(page.getByTestId("approval-status")).toHaveAttribute("data-status", "pending");
  await expect(page.getByTestId("send-quote")).toHaveCount(0);
});

test("[APR-EN-11][APR-EN-10] Finance sees the request in the inbox with the margin against the floor, and approves it", async ({
  page,
}) => {
  await signIn(page, "finance@demoq.test");
  financeSecret = await enrolTotp(page);
  financeStep = totpStep();
  await expect(page.getByTestId("inbox-count")).toHaveText("1");
  await page.getByTestId("nav-inbox").click();

  const c = card(page, APPROVAL_TITLE);
  await expect(c).toBeVisible();
  await expect(c).toHaveAttribute("data-kind", "margin_floor");
  await expect(c).toContainText("Below margin floor");
  await expect(c).toContainText("Requested by Sokha Lead");
  await expect(c.getByTestId("approval-total")).toHaveText("$1,000.00");
  await expect(c.getByTestId("approval-fee-margin")).toHaveText("18.00% vs floor 25.00%");
  await c.getByTestId("decision-note").fill("Launch pricing, one-off");
  await c.getByTestId("approve-approval").click();

  await expect(c).toHaveCount(0);
  await expect(page.getByTestId("inbox-count")).toHaveCount(0);
  await page.getByTestId("inbox-tab-recent").click();
  await expect(card(page, APPROVAL_TITLE).getByTestId("approval-decided")).toContainText("Approved by Sreymom Finance");
});

test("[COM-QB-06][COM-QB-09] the account lead sends the approved quote and it locks", async ({ page }) => {
  await signedIn(page, "sokha@demoq.test");
  await page.goto(quoteUrl);
  await expect(page.getByTestId("quote-status")).toHaveAttribute("data-status", "ready");
  await expect(page.getByTestId("approval-status")).toHaveAttribute("data-status", "approved");
  await page.getByTestId("send-quote").click();

  await expect(page.getByTestId("quote-status")).toHaveAttribute("data-status", "sent");
  await expect(page.getByTestId("quote-locked")).toBeVisible();
  await expect(page.getByTestId("save-quote")).toHaveCount(0);
  await expect(page.getByTestId("add-line")).toHaveCount(0);
  await expect(page.getByTestId("line-desc-0")).toHaveCount(0); // read-only: no inputs
  await expect(page.getByTestId("line-0")).toContainText("Launch campaign management");
  await expect(page.getByTestId("quote-total")).toHaveText("$1,000.00");
  await expect(page.getByTestId("revise-quote")).toBeVisible();
  await expect(page.getByTestId("mark-rejected")).toBeVisible();

  await page.getByTestId("nav-pipeline").click();
  await card(page, DEAL).getByRole("button", { name: DEAL }).click();
  await expect(page.getByTestId("deal-quotes")).toContainText(QUOTE_TITLE);
  await expect(page.getByTestId("deal-quotes").locator('[data-status="sent"]')).toBeVisible();
});

test("[COM-QB-04] a viewer and another account lead see prices but never cost fields", async ({ page }) => {
  for (const email of ["viewer@demoq.test", "dara@demoq.test"]) {
    await signedIn(page, email);
    await page.goto(quoteUrl);
    await expect(page.getByTestId("quote-total")).toHaveText("$1,000.00");
    await expect(page.getByTestId("line-0")).toContainText("Launch campaign management");
    await expect(page.getByTestId("cost-header")).toHaveCount(0);
    await expect(page.getByTestId("line-cost-0")).toHaveCount(0);
    await expect(page.getByTestId("fee-margin")).toHaveCount(0);
    await expect(page.getByText("Unit cost")).toHaveCount(0);
    const q = await api<{ costs: unknown; lines: { unitCostMinor: unknown }[] }>(page, "quote.get", {
      id: quoteUrl.split("/").pop(),
    });
    expect(q.costs).toBeNull();
    expect(q.lines[0]!.unitCostMinor).toBeNull();

    await page.getByTestId("nav-pipeline").click();
    await card(page, DEAL).getByRole("button", { name: DEAL }).click();
    await expect(page.getByTestId("deal-quotes")).toContainText(QUOTE_TITLE);
    await expect(page.getByTestId("new-quote")).toHaveCount(0); // not their deal to quote
    await page.getByTestId("drawer-close").click();
    await page.getByTestId("sign-out").click();
  }
});

test("[APR-EN-12] when the server asks for step-up, the approver re-enters a TOTP code and the decision goes through", async ({
  page,
}) => {
  test.setTimeout(150_000); // may wait for two fresh 30-second TOTP steps
  // Sokha prepares a second quote, 15 points below the floor, through the same API the screens use.
  await signedIn(page, "sokha@demoq.test");
  const deals = await api<{ id: string; title: string }[]>(page, "deal.list", {});
  const dealId = deals.find((d) => d.title === "Q1 always-on social")!.id;
  const ets = await api<{ id: string; code: string }[]>(page, "engagement_type.list", {});
  const q = await api<{ id: string; version: number }>(page, "quote.create", {
    dealId,
    title: "Always-on pilot",
    engagementTypeId: ets.find((e) => e.code === "campaign")!.id,
  });
  const saved = await api<{ version: number }>(page, "quote.save", {
    id: q.id,
    expectedVersion: q.version,
    lines: [{ kind: "fee", descriptionEn: "Pilot month", qtyMilli: 1000, unitPriceMinor: "100000", unitCostMinor: "90000" }],
  });
  await api(page, "quote.submit", { id: q.id, expectedVersion: saved.version });
  await page.getByTestId("sign-out").click();

  await signIn(page, "finance@demoq.test");
  const login = await freshTotpCode(financeSecret, financeStep);
  await page.getByTestId("totp-code").fill(login.code);
  await page.getByTestId("totp-submit").click();
  await expect(page.getByTestId("nav-inbox")).toBeVisible();

  // Signing in just proved TOTP, so the server would not ask yet; simulate the first answer being STEP_UP_REQUIRED.
  let decideCalls = 0;
  await page.route("**/api/v1/ops/approval.decide", async (route) => {
    decideCalls += 1;
    if (decideCalls > 1) return route.continue();
    return route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ type: "about:blank", title: "Step-up required", status: 401, code: "STEP_UP_REQUIRED" }),
    });
  });
  await page.getByTestId("nav-inbox").click();
  const c = card(page, "Angkor Beverages — Always-on pilot (v1)");
  await expect(c.getByTestId("approval-fee-margin")).toHaveText("10.00% vs floor 25.00%");
  await c.getByTestId("approve-approval").click();

  await expect(page.getByTestId("step-up-modal")).toBeVisible();
  const stepUp = await freshTotpCode(financeSecret, login.step);
  await page.getByTestId("step-up-code").fill(stepUp.code);
  await page.getByTestId("step-up-submit").click(); // the real /auth/step-up, then the decision is retried
  await expect(page.getByTestId("step-up-modal")).toHaveCount(0);
  await expect(c).toHaveCount(0);
  financeStep = stepUp.step;
  expect(decideCalls).toBe(2);
  const after = await api<{ status: string }>(page, "quote.get", { id: q.id });
  expect(after.status).toBe("ready");
});

test("[COM-CF-05] Finance corrects today's USD→KHR rate; one rate per date", async ({ page }) => {
  test.setTimeout(90_000); // may wait for a fresh 30-second TOTP step
  await signIn(page, "finance@demoq.test");
  const login = await freshTotpCode(financeSecret, financeStep);
  financeStep = login.step;
  await page.getByTestId("totp-code").fill(login.code);
  await page.getByTestId("totp-submit").click();
  await page.getByTestId("nav-fx").click();
  const row = page.getByTestId(`fx-${today()}`);
  await expect(row).toContainText("4100"); // seeded
  await expect(page.getByTestId("fx-date")).toHaveValue(today());
  await page.getByTestId("fx-rate").fill("4105.5");
  await page.getByTestId("fx-submit").click();
  await expect(page.getByTestId("fx-saved")).toBeVisible();
  await expect(row).toContainText("4105.5");
  await expect(page.getByTestId(`fx-${today()}`)).toHaveCount(1);

  // Privileged roles only get read tokens (the write scope is disabled for them).
  await page.getByTestId("nav-profile").click();
  await expect(page.getByTestId("token-scope-write")).toBeDisabled();
});

test("[COM-CF-01][COM-CF-04] admin edits an engagement type's floor and sees rate-card prices but not costs", async ({
  page,
}) => {
  await signIn(page, "admin@demoq.test");
  await enrolTotp(page);
  await page.getByTestId("nav-admin").click();
  await page.getByTestId("tab-pricing").click();
  await expect(page.getByTestId("et-fee-floor-campaign")).toHaveValue("25");
  await page.getByTestId("et-fee-floor-one_off").fill("30");
  await page.getByTestId("et-save-one_off").click();
  await expect(page.getByTestId("et-fee-floor-one_off")).toHaveValue("30");
  await page.reload();
  await expect(page.getByTestId("et-fee-floor-one_off")).toHaveValue("30");

  const item = page.getByTestId("item-VID-EDIT-HR");
  await expect(item.getByLabel("Price")).toHaveValue("50.00");
  await expect(item.getByLabel("Cost")).toHaveValue(""); // admin does not hold finance.view_costs
});

test("an account lead links Telegram and creates a personal access token that is shown once", async ({ page }) => {
  await signedIn(page, "sokha@demoq.test");
  await page.getByTestId("nav-profile").click();
  await expect(page.getByTestId("telegram-status")).toHaveAttribute("data-linked", "false");
  await page.getByTestId("telegram-link").click();
  await expect(page.getByTestId("telegram-code-box")).toContainText("Open the DemoQ bot (@DemoQBot) in Telegram and send:");
  await expect(page.getByTestId("telegram-command")).toHaveText(/^\/start [A-Z2-9]{10}$/);

  await page.getByTestId("token-label").fill("Claude Code laptop");
  await expect(page.getByTestId("token-scope-write")).toBeEnabled();
  await page.getByTestId("token-scope-write").check();
  await page.getByTestId("token-create").click();
  const token = (await page.getByTestId("token-value").textContent())!.trim();
  expect(token).toMatch(/^dq_pat_/);
  const snippet = await page.getByTestId("mcp-snippet").textContent();
  expect(snippet).toContain("Bearer ${DEMOQ_PAT}");
  expect(snippet).not.toContain(token);
  const row = page.getByTestId("token-Claude Code laptop");
  await expect(row).toContainText("read + write");
  await page.getByTestId("token-done").click();
  await expect(page.getByTestId("token-value")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("token-list")).not.toContainText(token);
  await row.getByTestId("token-revoke-Claude Code laptop").click();
  await expect(row).toContainText("Revoked");
});
