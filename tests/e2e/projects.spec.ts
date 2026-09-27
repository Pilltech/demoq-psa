// E2E for Sprint 3 (specs/commercial/accept-scope.md, change-orders.md, specs/projects/*.md, specs/tasks/tasks.md) —
// the S3 demo script, automated: accept a sent quote → gated project → work refused until the gates are met →
// bypass request in the Ops inbox → gates met, project active → the owner starts and finishes her task → an
// additive change order grows the scope and adds a task. Synthetic seed only (packages/testkit/src/seed.ts).
import { expect, test, type Page } from "@playwright/test";
import { card, enrolTotp, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });

const DEAL = "Harvest festival campaign"; // Sokha's, Kampot Pepper Co. (seed: quote sent, waiting for acceptance)
const QUOTE = "Harvest festival launch";
const PROJECT = "Kampot Pepper Co. — Harvest festival launch";
const TASK = "Harvest key visual";
const BYPASS_REASON = "Client briefed the launch for next week; contract and PO are in their legal review.";
const MISSING = ["contract", "deposit_terms", "purchase_order"];

let projectUrl = "";

async function signedIn(page: Page, email: string) {
  await signIn(page, email);
  await expect(page.getByTestId("sign-out")).toBeVisible();
}

/** Call an op and return the status and body even when it is refused. */
async function apiRaw(page: Page, name: string, input: unknown) {
  const res = await page.request.post(`/api/v1/ops/${name}`, { data: input, headers: { "x-psa-csrf": "1" } });
  return { status: res.status(), body: (await res.json()) as { code?: string } & Record<string, unknown> };
}

const taskCard = (page: Page, column: "todo" | "in_progress" | "done", title: string) =>
  page.getByTestId(`task-column-${column}`).locator(`[data-title="${title}"]`);

test("[COM-AC-01][COM-AC-02][COM-AC-03][COM-AC-04][PRJ-GT-01] the account lead accepts the sent quote: the deal is Won and a gated project waits for contract, PO and deposit terms", async ({
  page,
}) => {
  await signedIn(page, "sokha@demoq.test");
  await card(page, DEAL).getByRole("button", { name: DEAL }).click();
  await page
    .getByTestId("deal-quotes")
    .getByRole("link", { name: new RegExp(QUOTE) })
    .click();
  await expect(page.getByTestId("quote-status")).toHaveAttribute("data-status", "sent");

  await page.getByTestId("accept-quote").click();
  const modal = page.getByTestId("accept-modal");
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("accept-pm")).toHaveValue(/.+/); // defaults to the quote owner (D-AC-1)
  await expect(page.getByTestId("accept-project-type")).not.toHaveValue(""); // the quote's project type
  await expect(page.getByTestId("accept-confirm")).toBeDisabled(); // a win reason is required (COM-AC-01)
  await page.getByTestId("accept-win-reason").selectOption("creative");
  await page.getByTestId("accept-pm").selectOption({ label: "Pisey PM" });
  await page.getByTestId("accept-confirm").click();

  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  projectUrl = new URL(page.url()).pathname;
  await expect(page.getByTestId("project-name")).toHaveText(PROJECT);
  await expect(page.getByTestId("project-status")).toHaveAttribute("data-status", "gated");
  await expect(page.getByTestId("project-missing-gates")).toHaveAttribute("data-gates", MISSING.join(","));
  await expect(page.getByTestId("gate-scope")).toHaveAttribute("data-status", "satisfied");
  await expect(page.getByTestId("gate-quote")).toHaveAttribute("data-status", "satisfied");
  for (const g of MISSING) await expect(page.getByTestId(`gate-${g}`)).toHaveAttribute("data-status", "missing");
  await expect(page.getByTestId("missing-gates")).toHaveText("Missing: Contract, Deposit terms, Purchase order");
  await expect(page.getByTestId("members-panel")).toContainText("Pisey PM");
  // COM-AC-03: the quote is the scope, one item per line.
  await expect(page.getByTestId("scope-value")).toHaveText("$1,300.00");
  await expect(page.getByTestId("scope-items").locator("tbody tr")).toHaveCount(2);
  // The account lead is not the PM: no gate or activation buttons.
  await expect(page.getByTestId("gate-satisfy-contract")).toHaveCount(0);
  await expect(page.getByTestId("project-activate")).toHaveCount(0);

  // COM-AC-02: the deal closed as Won.
  await page.getByTestId("nav-pipeline").click();
  await expect(page.getByTestId("column-won").locator(`[data-title="${DEAL}"]`)).toBeVisible();
});

test("[PRJ-PJ-01][PRJ-PJ-04][TSK-TP-02][TSK-TK-01][TSK-TK-02][TSK-TK-05] the PM adds a designer and gives her a task linked to a scope item", async ({
  page,
}) => {
  await signedIn(page, "pisey@demoq.test");
  await page.getByTestId("nav-projects").click();
  await expect(page.getByTestId("projects-mine")).toHaveAttribute("aria-selected", "true");
  const row = page.locator(`[data-name="${PROJECT}"]`);
  await expect(row.getByTestId("project-row-status")).toHaveAttribute("data-status", "gated");
  await expect(row.getByTestId("project-row-gates")).toHaveAttribute("data-gates", MISSING.join(","));
  await row.getByTestId("project-link").click();
  await expect(page).toHaveURL(projectUrl);

  await page.getByTestId("member-user").selectOption({ label: "Bopha Designer" });
  await page.getByTestId("member-role").fill("designer");
  await page.getByTestId("member-add").click();
  await expect(page.getByTestId("member-Bopha Designer")).toContainText("designer");

  await page.getByTestId("project-tab-tasks").click();
  // TSK-TP-02: the campaign template's tasks, with their dependencies (TSK-TK-05).
  await expect(taskCard(page, "todo", "Kick-off and brief")).toBeVisible();
  await expect(taskCard(page, "todo", "Creative concept").getByTestId("task-blocked")).toContainText(
    "Waiting for: Kick-off and brief",
  );
  await expect(taskCard(page, "todo", "Kick-off and brief").getByTestId("task-blocked")).toContainText(
    "Waiting for gates: Contract, Deposit terms, Purchase order",
  );

  await page.getByTestId("task-new").click();
  await expect(page.getByTestId("task-modal")).toBeVisible();
  await page.getByTestId("task-title").fill(TASK);
  await page.getByTestId("task-owner").selectOption({ label: "Bopha Designer · designer" });
  await page.getByTestId("task-estimate").fill("4");
  // TSK-TK-02: client work links a scope item, or is non-deliverable, or asks for an out-of-scope decision.
  await expect(page.getByTestId("task-submit")).toBeDisabled();
  await page.getByTestId("task-scope-item").selectOption({ label: "Social media post ($900.00)" });
  await page.getByTestId("task-submit").click();
  await expect(page.getByTestId("task-modal")).toHaveCount(0);
  const t = taskCard(page, "todo", TASK);
  await expect(t).toContainText("Bopha Designer");
  await expect(t).toContainText("4h");
  await expect(t.getByTestId("task-move-in_progress")).toHaveCount(0); // only the owner moves it

  // TSK-TK-01 / TSK-TK-02 on the server too.
  const projectId = projectUrl.split("/").pop();
  const noOwner = await apiRaw(page, "task.create", {
    projectId,
    title: "No owner",
    estimateMinutes: 60,
    dueDate: "2026-12-01",
    nonDeliverable: true,
  });
  expect(noOwner.status).toBe(422);
  expect(noOwner.body.code).toBe("TASK_INCOMPLETE");
  const me = (await (await page.request.get("/api/v1/auth/me")).json()) as { user: { id: string } };
  const unlinked = await apiRaw(page, "task.create", {
    projectId,
    title: "Unlinked",
    ownerId: me.user.id,
    estimateMinutes: 60,
    dueDate: "2026-12-01",
  });
  expect(unlinked.body.code).toBe("OUT_OF_SCOPE_REQUIRED");
});

test("[PRJ-GT-04][TSK-TK-04] staff cannot start a task while gates are missing: the refusal lists the missing gates", async ({
  page,
}) => {
  await signedIn(page, "bopha@demoq.test");
  await page.getByTestId("nav-tasks").click();
  const t = taskCard(page, "todo", TASK);
  await expect(t).toContainText(PROJECT);
  await expect(t.getByTestId("task-blocked")).toContainText("Waiting for gates: Contract, Deposit terms, Purchase order");
  await t.getByTestId("task-move-in_progress").click();

  const error = page.getByTestId("error");
  await expect(error).toHaveAttribute("data-code", "GATE_BLOCKED");
  await expect(error).toContainText("Work can't start yet: some project gates are still missing.");
  await expect(page.getByTestId("gate-blocked-gates")).toHaveText("Missing: Contract, Deposit terms, Purchase order");
  await expect(taskCard(page, "todo", TASK)).toBeVisible();
  await expect(taskCard(page, "in_progress", TASK)).toHaveCount(0);
});

test("[PRJ-BP-01] the PM requests a bypass with a named owner, a 30+ character reason and an expiry within 30 days", async ({
  page,
}) => {
  await signedIn(page, "pisey@demoq.test");
  await page.goto(projectUrl);
  await page.getByTestId("bypass-new").click();
  for (const g of MISSING) await expect(page.getByTestId(`bypass-gate-${g}`)).toBeChecked();
  await expect(page.getByTestId("bypass-owner")).toHaveValue(/.+/); // the requester by default
  await page.getByTestId("bypass-reason").fill("Client is in a hurry.");
  await expect(page.getByTestId("bypass-submit")).toBeDisabled(); // under 30 characters
  await page.getByTestId("bypass-reason").fill(BYPASS_REASON);
  await page.getByTestId("bypass-submit").click();

  await expect(page.getByTestId("bypass-flash")).toBeVisible();
  const list = page.getByTestId("bypass-list");
  await expect(list.locator('[data-status="requested"]')).toHaveCount(1);
  await expect(list).toContainText(BYPASS_REASON);
  await expect(list).toContainText("Owner: Pisey PM");
  // Requested is not approved: the gates still block work.
  await expect(page.getByTestId("project-missing-gates")).toHaveAttribute("data-gates", MISSING.join(","));
});

test("[PRJ-BP-02][PRJ-BP-03] the bypass request waits in the Ops inbox; Ops approves it and the bypass opens", async ({
  page,
}) => {
  await signIn(page, "kosal@demoq.test");
  await enrolTotp(page);
  await page.getByTestId("nav-inbox").click();
  const c = page.locator('[data-kind="gate_bypass"]');
  await expect(c).toHaveCount(1);
  await expect(c).toContainText("Gate bypass");
  await expect(c).toContainText(PROJECT);
  await expect(c).toContainText("Requested by Pisey PM");
  await expect(c.getByTestId("approval-gates")).toHaveText("Contract, Deposit terms, Purchase order");
  await expect(c.getByTestId("approval-reason")).toHaveText(BYPASS_REASON);
  await c.getByTestId("approve-approval").click();
  await expect(c).toHaveCount(0);

  await page.getByTestId("inbox-tab-recent").click();
  const decided = page.locator('[data-kind="gate_bypass"]');
  await expect(decided.getByTestId("approval-decided")).toContainText("Approved by Kosal Ops");
  await decided.getByTestId("approval-open-subject").click();
  await expect(page).toHaveURL(projectUrl);
  await expect(page.getByTestId("bypass-list").locator('[data-status="open"]')).toHaveCount(1);
  await expect(page.getByTestId("gates-covered")).toContainText("Contract, Deposit terms, Purchase order");
  await expect(page.getByTestId("project-missing-gates")).toHaveCount(0);
  // A bypass allows work, never activation (PRJ-PJ-02): the gates themselves are still missing.
  await expect(page.getByTestId("project-status")).toHaveAttribute("data-status", "gated");
  await expect(page.getByTestId("project-activate")).toBeDisabled();
});

test("[PRJ-GT-02][PRJ-PJ-02] the PM records contract, PO and deposit-terms evidence, then activates the project", async ({
  page,
}) => {
  await signedIn(page, "pisey@demoq.test");
  await page.goto(projectUrl);
  await expect(page.getByTestId("project-activate")).toBeDisabled();
  const evidence: [string, string][] = [
    ["contract", "KPC-2026-014 signed contract"],
    ["purchase_order", "PO-7781"],
    ["deposit_terms", "50% deposit agreed by email, 2 Oct"],
  ];
  for (const [gate, text] of evidence) {
    await expect(page.getByTestId(`gate-satisfy-${gate}`)).toBeDisabled(); // evidence first
    await page.getByTestId(`gate-evidence-${gate}`).fill(text);
    await page.getByTestId(`gate-satisfy-${gate}`).click();
    await expect(page.getByTestId(`gate-${gate}`)).toHaveAttribute("data-status", "satisfied");
    await expect(page.getByTestId(`gate-evidence-text-${gate}`)).toContainText(`${text} · Pisey PM`);
  }
  await expect(page.getByTestId("gates-all-met")).toBeVisible();
  await page.getByTestId("project-activate").click();
  await expect(page.getByTestId("project-status")).toHaveAttribute("data-status", "active");
  await expect(page.getByTestId("project-hold")).toBeVisible();
});

test("[TSK-TK-03][TSK-TK-07] the owner starts and finishes her task on her own Kanban", async ({ page }) => {
  await signedIn(page, "bopha@demoq.test");
  await page.getByTestId("nav-tasks").click();
  const todo = taskCard(page, "todo", TASK);
  await expect(todo.getByTestId("task-blocked")).toHaveCount(0);
  await todo.getByTestId("task-move-in_progress").click();
  const doing = taskCard(page, "in_progress", TASK);
  await expect(doing).toBeVisible();
  await doing.getByTestId("task-move-done").click();
  await expect(taskCard(page, "done", TASK)).toBeVisible();
  await expect(page.getByTestId("error")).toHaveCount(0);

  // The project's board shows the same (TSK-TK-07).
  await page.goto(`${projectUrl}/tasks`);
  await expect(taskCard(page, "done", TASK)).toBeVisible();
});

test("[COM-CO-01][COM-CO-03][COM-CO-04][COM-CO-05] an additive change order is sent and accepted: the scope grows and a task appears", async ({
  page,
}) => {
  await signedIn(page, "sokha@demoq.test");
  await page.goto(projectUrl);
  await page.getByTestId("project-tab-change-orders").click();
  await page.getByTestId("co-new").click();
  await page.getByTestId("co-title").fill("Extra harvest posts");
  await page.getByTestId("co-create").click();
  await expect(page).toHaveURL(/\/change-orders\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("co-status")).toHaveAttribute("data-status", "draft");

  await page.getByTestId("co-rate-card-pick").selectOption({ label: "SOC-POST — Social media post ($150.00 / post)" });
  await page.getByTestId("co-line-qty-0").fill("4");
  await page.getByTestId("co-line-hours-0").fill("3");
  await expect(page.getByTestId("co-total")).toHaveText("$600.00");
  // COM-CO-01: a reduction cannot even be typed.
  await page.getByTestId("co-line-qty-0").fill("-1");
  await expect(page.getByTestId("co-line-qty-0")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("co-save")).toBeDisabled();
  await page.getByTestId("co-line-qty-0").fill("4");
  await page.getByTestId("co-save").click();
  await expect(page.getByTestId("co-flash")).toBeVisible();
  // Live margin for the cost-holder (the account lead), from the server's rate-card cost.
  await expect(page.getByTestId("co-line-cost-0")).toHaveValue("60.00");
  await expect(page.getByTestId("co-fee-margin")).toHaveText("60.00%");
  await page.getByTestId("co-line-cost-0").fill("130");
  await expect(page.getByTestId("co-fee-margin")).toHaveText("13.33%");
  await expect(page.getByTestId("co-below-floor")).toBeVisible();
  await page.getByTestId("co-line-cost-0").fill("60");
  await expect(page.getByTestId("co-below-floor")).toHaveCount(0);

  await page.getByTestId("co-submit").click();
  await expect(page.getByTestId("co-status")).toHaveAttribute("data-status", "ready");
  await page.getByTestId("co-send").click();
  await expect(page.getByTestId("co-status")).toHaveAttribute("data-status", "sent");
  await expect(page.getByTestId("co-save")).toHaveCount(0); // sent change orders are locked
  await page.getByTestId("co-accept").click();
  await expect(page.getByTestId("co-status")).toHaveAttribute("data-status", "accepted");

  // COM-CO-04/05: lines appended to the scope, value only grows, one task per fee line (owner: the PM).
  await page.getByTestId("project-tab-overview").click();
  await expect(page.getByTestId("scope-value")).toHaveText("$1,900.00");
  await expect(page.getByTestId("scope-items").locator('[data-source="change_order"]')).toContainText("Social media post");
  await page.getByTestId("project-tab-tasks").click();
  const added = taskCard(page, "todo", "Social media post");
  await expect(added).toContainText("Pisey PM");
  await expect(added).toContainText("3h");

  // COM-CO-01 on the server: a negative quantity is refused with its own error.
  const projectId = projectUrl.split("/").pop();
  const co = (await apiRaw(page, "change_order.create", { projectId, title: "Fewer posts" })).body as {
    id: string;
    version: number;
  };
  const cut = await apiRaw(page, "change_order.save", {
    id: co.id,
    expectedVersion: co.version,
    lines: [{ kind: "fee", descriptionEn: "Remove a post", qtyMilli: -1000, unitPriceMinor: "15000", unitCostMinor: "6000" }],
  });
  expect(cut.status).toBe(422);
  expect(cut.body.code).toBe("CHANGE_ORDER_NOT_ADDITIVE");
  expect((await apiRaw(page, "change_order.void", { id: co.id, expectedVersion: co.version })).status).toBe(200);
});

test("[COM-CO-06][COM-QB-04] the PM sees the project's change orders without costs or margin", async ({ page }) => {
  await signedIn(page, "pisey@demoq.test");
  await page.goto(`${projectUrl}/change-orders`);
  await expect(page.getByTestId("co-row-1")).toContainText("Extra harvest posts");
  await expect(page.getByTestId("co-row-1").locator('[data-status="accepted"]')).toBeVisible();
  await expect(page.getByTestId("co-row-2").locator('[data-status="void"]')).toBeVisible();
  await page.getByTestId("co-row-1").getByTestId("co-link").click();
  await expect(page.getByTestId("co-total")).toHaveText("$600.00");
  await expect(page.getByTestId("co-cost-header")).toHaveCount(0);
  await expect(page.getByTestId("co-fee-margin")).toHaveCount(0);
});

test("[TSK-TP-01] admin edits a project type's task template", async ({ page }) => {
  // Nimol is admin + viewer: task_template.list needs project.view, which admin alone lacks (backend gap, see seed).
  await signIn(page, "config@demoq.test");
  await enrolTotp(page);
  await page.getByTestId("nav-admin").click();
  await page.getByTestId("tab-templates").click();
  await page.getByTestId("template-project-type").selectOption({ label: "Content / video production" });
  const editor = page.getByTestId("template-editor");
  await expect(editor).toHaveAttribute("data-project-type", "content_production");
  await expect(page.getByTestId("template-items").locator("tbody tr")).toHaveCount(4);
  await page.getByTestId("template-add").click();
  await page.getByTestId("template-title-4").fill("Client review of the cut");
  await page.getByTestId("template-role-4").fill("pm");
  await page.getByTestId("template-offset-4").fill("12");
  await page.getByTestId("template-hours-4").fill("1.5");
  await page.getByTestId("template-save").click();
  await expect(page.getByTestId("template-saved")).toBeVisible();

  await page.reload();
  await page.getByTestId("template-project-type").selectOption({ label: "Content / video production" });
  await expect(page.getByTestId("template-items").locator("tbody tr")).toHaveCount(5);
  await expect(page.getByTestId("template-title-4")).toHaveValue("Client review of the cut");
  await expect(page.getByTestId("template-hours-4")).toHaveValue("1.5");
});

test("@phone [PRJ-PJ-04][TSK-TK-07] on a phone, the project, its Kanban and My tasks fit the screen, in English and Khmer", async ({
  page,
}) => {
  // Runs in the phone project too, possibly before the demo above: it must not depend on that state.
  // A string, so the root tsconfig (no DOM lib) does not type-check browser globals.
  const noSideScroll = () => page.evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth + 1");
  await signedIn(page, "pisey@demoq.test");
  await page.getByTestId("nav-projects").click();
  await page.getByTestId("projects-all").click();
  await expect(page.getByTestId("project-list")).toBeVisible();
  expect(await noSideScroll()).toBe(true);

  const projects = await (
    await page.request.post("/api/v1/ops/project.list", { data: { mine: false }, headers: { "x-psa-csrf": "1" } })
  ).json();
  if (projects.length > 0) {
    await page.getByTestId("project-link").first().click();
    await expect(page.getByTestId("project-status")).toBeVisible();
    expect(await noSideScroll()).toBe(true);
    await page.getByTestId("project-tab-tasks").click();
    await expect(page.getByTestId("task-board")).toBeVisible();
    expect(await noSideScroll()).toBe(true);

    await page.getByTestId("toggle-locale").click();
    await expect(page.getByTestId("project-tab-tasks")).toHaveText("ការងារ");
    await expect(page.getByTestId("task-column-done").locator("h3")).toContainText("រួចរាល់");
    expect(await noSideScroll()).toBe(true);
    await page.getByTestId("toggle-locale").click(); // leave English for later tests
    await expect(page.getByTestId("project-tab-tasks")).toHaveText("Tasks");
  }

  await page.getByTestId("nav-tasks").click();
  await expect(page.getByTestId("task-board")).toBeVisible();
  expect(await noSideScroll()).toBe(true);
});
