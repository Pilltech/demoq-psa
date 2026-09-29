// E2E for Sprint 4 influencers (specs/influencers/links.md) — the S4 demo, automated: the influencer manager adds an
// influencer and assigns them to a deliverable of an active project, issues a link (shown once), the influencer submits
// from a phone with no account, the submission waits until the PM approves it in the inbox, approved counts against
// the contract, and a revoked link shows the expired state. Synthetic seed: Malis Influencer (influencer manager), Pisey
// PM on "Lotus Demo Crafts — Craft fair launch" (active, with an "Influencer post" deliverable).
import { devices, expect, test, type Browser, type Page } from "@playwright/test";
import { noSideScroll, ppToday, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });

const PROJECT = "Lotus Demo Crafts — Craft fair launch";
const INFLUENCER = "Demo Creator Rotha";
const POST = "https://www.tiktok.com/@demo.rotha/video/7400000000000000001";
let linkUrl = "";

async function signedIn(page: Page, email: string) {
  await page.context().clearCookies(); // switch person within a test
  await signIn(page, email);
  await expect(page.getByTestId("sign-out")).toBeVisible();
}

async function openProjectInfluencers(page: Page) {
  await page.getByTestId("nav-projects").click();
  await page.getByTestId("projects-all").click();
  await page.locator(`[data-name="${PROJECT}"]`).getByTestId("project-link").click();
  await page.getByTestId("project-tab-influencers").click();
  await expect(page.getByTestId("project-influencers")).toBeVisible();
}

/** A fresh phone browser with no cookies: what an influencer has. Records every API call it makes. */
async function influencerPhone(browser: Browser) {
  const ctx = await browser.newContext({ ...devices["Pixel 7"] });
  const page = await ctx.newPage();
  const calls: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/")) calls.push(u.pathname);
  });
  return { ctx, page, calls };
}

test("[INF-RS-01][INF-RS-02] the influencer manager adds an influencer to the roster and assigns them to a deliverable of an active project", async ({
  page,
}) => {
  await signedIn(page, "malis@demoq.test");
  await page.getByTestId("nav-influencers").click();
  await expect(page.getByTestId("influencer-Demo Creator Sreyneang")).toContainText("@demo.sreyneang");
  await page.getByTestId("influencer-name").fill(INFLUENCER);
  await page.getByTestId("influencer-handle-0").fill("@demo.rotha");
  await page.getByTestId("influencer-submit").click();
  await expect(page.getByTestId(`influencer-${INFLUENCER}`)).toContainText("TikTok @demo.rotha");

  await openProjectInfluencers(page);
  await page.getByTestId("assignment-new").click();
  await page.getByTestId("assignment-influencer").selectOption({ label: INFLUENCER });
  await page.getByTestId("assignment-scope-item").selectOption({ label: "Influencer post ($1,200.00)" });
  await page.getByTestId("assignment-posts").fill("2");
  await page.getByTestId("assignment-per-post").fill("350");
  await page.getByTestId("assignment-submit").click();
  const a = page.getByTestId(`assignment-${INFLUENCER}`);
  await expect(a).toContainText("2 posts contracted");
  await expect(a).toContainText("$350.00 per post");
  await expect(page.getByTestId(`summary-${INFLUENCER}`)).toContainText("0 / 2");
});

test("[INF-LK-01][INF-LK-02][INF-LK-03][INF-LK-05] a link is issued for the assignment and shown once, with a copy button", async ({
  page,
}) => {
  await signedIn(page, "malis@demoq.test");
  await openProjectInfluencers(page);
  const a = page.getByTestId(`assignment-${INFLUENCER}`);
  await a.getByTestId("link-issue").click();
  const issued = a.getByTestId("link-issued");
  await expect(issued).toContainText("It will not be shown again");
  await expect(a.getByTestId("link-copy")).toBeVisible();
  linkUrl = (await a.getByTestId("link-url").textContent())!.trim();
  expect(linkUrl).toMatch(/^http:\/\/127\.0\.0\.1:3100\/l\/[A-Za-z0-9_-]{43}$/);
  const row = a.getByTestId("link-row");
  await expect(row).toHaveAttribute("data-state", "active");
  await expect(row).toContainText("0 of 10 used"); // D13 defaults
  await a.getByTestId("link-done").click();
  await expect(a.getByTestId("link-issued")).toHaveCount(0);
  // Never again: the list and a reload show the state, not the token.
  await page.reload();
  await expect(page.getByTestId(`assignment-${INFLUENCER}`).getByTestId("link-row")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(linkUrl.split("/l/")[1]!);
});

test("[INF-LK-06][INF-LK-08][INF-LK-10] the influencer opens the link on a phone with no account, submits a post and sees it waiting for review", async ({
  browser,
}) => {
  const { ctx, page, calls } = await influencerPhone(browser);
  await page.goto(linkUrl);
  const view = page.getByTestId("link-page");
  await expect(view).toHaveAttribute("data-state", "active");
  await expect(page.getByTestId("link-title")).toHaveText("Log your posts for DemoQ");
  await expect(page.getByTestId("link-influencer")).toHaveText(INFLUENCER);
  await expect(page.getByTestId("link-deliverable")).toHaveText("Influencer post");
  await expect(page.getByTestId("link-remaining")).toContainText("Submissions left on this link: 10 of 10");
  await expect(page.getByTestId("link-expires")).toContainText("This link works until");
  await expect(page.getByTestId("sign-out")).toHaveCount(0); // no app chrome
  expect(await noSideScroll(page)).toBe(true);

  // Khmer switch, and back.
  await page.getByTestId("link-locale").click();
  await expect(page.getByTestId("link-title")).toContainText("DemoQ");
  await expect(page.getByTestId("link-title")).toContainText(/[ក-៿]/);
  await page.getByTestId("link-locale").click();

  // Client-side check first: a bad URL is marked, nothing is sent.
  await page.getByTestId("link-post-url").fill("not a link");
  await page.getByTestId("link-submit").click();
  await expect(page.getByTestId("link-error-msg")).toBeVisible();
  await expect(page.getByTestId("link-post-url")).toHaveAttribute("aria-invalid", "true");

  await page.getByTestId("link-post-url").fill(POST);
  await page.getByTestId("link-posted-on").fill(ppToday());
  await page.getByTestId("link-metric-views").fill("12000");
  await page.getByTestId("link-metric-likes").fill("900");
  await page.getByTestId("link-proof-0").fill("https://drive.example.com/s/rotha-insights-1");
  await page.getByTestId("link-add-proof").click();
  await page.getByTestId("link-proof-1").fill("https://drive.example.com/s/rotha-insights-2");
  await page.getByTestId("link-note").fill("Posted at 7pm <b>not bold</b>");
  await page.getByTestId("link-submit").click();

  await expect(page.getByTestId("link-thanks")).toContainText("Your post is waiting for DemoQ's review");
  const mine = page.getByTestId("link-mine").locator(`[data-url="${POST}"]`);
  await expect(mine).toHaveAttribute("data-status", "submitted");
  await expect(mine).toContainText("Waiting for review");
  await expect(page.getByTestId("link-remaining")).toContainText("9 of 10");
  expect(await noSideScroll(page)).toBe(true);
  // INF-LK-06: only the link API, never a staff route.
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((p) => p.startsWith("/api/v1/link/"))).toBe(true);
  await ctx.close();
});

test("[INF-LK-10][INV-13] the submission waits in the PM's inbox (not the issuer's) and counts only once approved", async ({
  page,
}) => {
  // The issuer requested it: she sees it, but cannot decide it.
  await signedIn(page, "malis@demoq.test");
  await page.getByTestId("nav-inbox").click();
  const mineCard = page.locator('[data-kind="influencer_work"]').filter({ hasText: INFLUENCER });
  await expect(mineCard).toContainText("Your request");
  await expect(mineCard.getByTestId("approve-approval")).toHaveCount(0);

  await signedIn(page, "pisey@demoq.test");
  await openProjectInfluencers(page);
  await expect(page.getByTestId(`summary-${INFLUENCER}`)).toHaveAttribute("data-pending", "1");
  await expect(page.getByTestId(`summary-${INFLUENCER}`)).toHaveAttribute("data-approved", "0");
  await expect(page.getByTestId(`submission-${POST}`)).toHaveAttribute("data-status", "submitted");
  // Influencer text stays text.
  await expect(page.getByTestId(`submission-${POST}`)).toContainText("Posted at 7pm <b>not bold</b>");

  await page.getByTestId("nav-inbox").click();
  const card = page.locator('[data-kind="influencer_work"]').filter({ hasText: INFLUENCER });
  await expect(card).toContainText("Influencer work");
  await expect(card.getByTestId("approval-post-url")).toHaveAttribute("href", POST);
  await expect(card.getByTestId("approval-proofs").locator("a")).toHaveCount(2);
  await expect(card.getByTestId("approval-post-count")).toContainText("Post 1 of 2 contracted");
  await card.getByTestId("approve-approval").click();
  await expect(card).toHaveCount(0);

  await openProjectInfluencers(page);
  await expect(page.getByTestId(`summary-${INFLUENCER}`)).toHaveAttribute("data-approved", "1");
  await expect(page.getByTestId(`summary-${INFLUENCER}`)).toContainText("1 / 2");
  await expect(page.getByTestId(`submission-${POST}`)).toHaveAttribute("data-status", "approved");
});

test("[INF-LK-04][INF-LK-07] a revoked link shows the expired state on the phone, and an unknown link says not found", async ({
  page,
  browser,
}) => {
  await signedIn(page, "malis@demoq.test");
  await openProjectInfluencers(page);
  const a = page.getByTestId(`assignment-${INFLUENCER}`);
  await a.getByTestId("link-revoke").click();
  await expect(a.getByTestId("link-row")).toHaveAttribute("data-state", "revoked");

  const { ctx, page: phone, calls } = await influencerPhone(browser);
  await phone.goto(linkUrl);
  await expect(phone.getByTestId("link-page")).toHaveAttribute("data-state", "expired");
  await expect(phone.getByTestId("link-expired")).toHaveAttribute("data-reason", "revoked");
  await expect(phone.getByTestId("link-expired")).toContainText("Link expired");
  await expect(phone.getByTestId("link-form")).toHaveCount(0);

  await phone.goto(`${new URL(linkUrl).origin}/l/${"x".repeat(43)}`);
  await expect(phone.getByTestId("link-page")).toHaveAttribute("data-state", "not_found");
  await expect(phone.getByTestId("link-not-found")).toContainText("Link not found");
  await phone.getByTestId("link-locale").click();
  await expect(phone.getByTestId("link-not-found")).toContainText(/[ក-៿]/);
  expect(calls.every((p) => p.startsWith("/api/v1/link/"))).toBe(true);
  await ctx.close();
});
