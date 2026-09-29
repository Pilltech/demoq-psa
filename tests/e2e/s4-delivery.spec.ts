// E2E for Sprint 4 delivery (specs/tasks/delivery.md, specs/approvals/engine.md APR-EN-13) — the S4 demo, automated:
// mark-sent is refused until someone other than the owner approves the QC; rounds 1–3 start at once and QC loops keep
// the round; a round-4 request waits in the account lead's inbox with Absorb / Change order / Reject; absorb starts
// round 4; round 5 is a hard stop. Synthetic seed (packages/testkit/src/seed.ts): Bopha's client-facing task
// "Craft fair key visual" is in progress on Pisey's active project for Lotus Demo Crafts (account lead: Dara).
import { expect, test, type Page } from "@playwright/test";
import { apiRaw, apiSession, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });

const PROJECT = "Lotus Demo Crafts — Craft fair launch";
const TASK = "Craft fair key visual";

type Task = {
  id: string;
  version: number;
  status: string;
  revision_round: number;
  qc: { approvalId: string; status: string } | null;
  revisionRequest: { approvalId: string; status: string; outcome: string | null } | null;
};

async function signedIn(page: Page, email: string) {
  await page.context().clearCookies(); // switch person within a test
  await signIn(page, email);
  await expect(page.getByTestId("sign-out")).toBeVisible();
}

const column = (page: Page, col: string) => page.getByTestId(`task-column-${col}`).locator(`[data-title="${TASK}"]`);

/** The task as the server sees it (through someone's API session). */
async function task(s: Awaited<ReturnType<typeof apiSession>>): Promise<Task> {
  const projects = await s.op<{ id: string; name: string }[]>("project.list", { mine: false });
  const p = projects.find((x) => x.name === PROJECT)!;
  const board = await s.op<{ tasks: (Task & { title: string })[] }>("task.board", { projectId: p.id });
  return board.tasks.find((x) => x.title === TASK)!;
}

/** One full delivery loop through the API: QC by the owner, approved by the PM, sent — back in client_review. */
async function deliverRound(owner: Awaited<ReturnType<typeof apiSession>>, pm: Awaited<ReturnType<typeof apiSession>>) {
  let k = await task(owner);
  await owner.op("task.submit_qc", { id: k.id, expectedVersion: k.version });
  k = await task(owner);
  await pm.op("approval.decide", { id: k.qc!.approvalId, decision: "approve" });
  k = await task(owner);
  await owner.op("task.mark_sent", { id: k.id, expectedVersion: k.version, sentReference: `KV v${k.revision_round + 1}` });
  return task(owner);
}

test("[TSK-DL-03][TSK-DL-06][TSK-DL-12] the owner submits her task for QC: mark sent stays disabled and the server refuses it", async ({
  page,
}) => {
  await signedIn(page, "bopha@demoq.test");
  await page.getByTestId("nav-tasks").click();
  const card = column(page, "in_progress");
  await expect(card.getByTestId("task-round")).toHaveText("Round 0 of 4");
  // TSK-DL-01: a client-facing task cannot simply be finished.
  await expect(card.getByTestId("task-move-done")).toHaveCount(0);
  await card.getByTestId("task-action-submit_qc").click();

  const review = column(page, "internal_review");
  await expect(review).toBeVisible();
  await expect(review.getByTestId("task-qc")).toHaveAttribute("data-status", "pending");
  await expect(review.getByTestId("task-action-mark_sent")).toBeDisabled();
  await expect(review.getByTestId("task-blocked")).toContainText("Waiting for the internal quality check");

  // INV-10 on the server: no mark-sent before the QC, and the owner can never decide her own QC.
  const me = await apiSession("bopha@demoq.test");
  const k = await task(me);
  const sent = await apiRaw(page, "task.mark_sent", { id: k.id, expectedVersion: k.version, sentReference: "too early" });
  expect(sent.status).toBe(409);
  const self = await apiRaw(page, "approval.decide", { id: k.qc!.approvalId, decision: "approve" });
  expect(self.status).toBe(403);
  expect(self.body.code).toBe("SELF_APPROVAL");
  await me.dispose();

  // Her inbox shows the request as hers, with nothing to decide.
  await page.getByTestId("nav-inbox").click();
  await page.getByTestId("inbox-tab-recent").click();
  const qc = page.locator('[data-kind="quality_check"]').filter({ hasText: TASK });
  await expect(qc).toContainText("Your request");
  await expect(qc.getByTestId("approve-approval")).toHaveCount(0);
});

test("[TSK-DL-04][TSK-DL-06] the PM (not the owner) approves the QC in the inbox; the owner marks it sent with what was sent", async ({
  page,
}) => {
  await signedIn(page, "pisey@demoq.test");
  await page.getByTestId("nav-inbox").click();
  const qc = page.locator('[data-kind="quality_check"]').filter({ hasText: TASK });
  await expect(qc).toContainText("Quality check");
  await expect(qc.getByTestId("approval-open-subject")).toHaveText("Open task");
  await qc.getByTestId("approve-approval").click();
  await expect(qc).toHaveCount(0);

  await signedIn(page, "bopha@demoq.test");
  await page.getByTestId("nav-tasks").click();
  const ready = column(page, "client_ready");
  await expect(ready.getByTestId("task-qc")).toHaveAttribute("data-status", "approved");
  await ready.getByTestId("task-action-mark_sent").click();
  await expect(page.getByTestId("sent-modal")).toBeVisible();
  await expect(page.getByTestId("sent-submit")).toBeDisabled(); // what was sent is required
  await page.getByTestId("sent-reference").fill("KV_final_v1.pdf by email");
  await page.getByTestId("sent-submit").click();
  const withClient = column(page, "client_review");
  await expect(withClient.getByTestId("task-sent")).toContainText("KV_final_v1.pdf by email");
});

test("[TSK-DL-07][TSK-DL-05] a client revision starts round 1 at once; a QC sent back keeps the round; rounds 2 and 3 follow", async ({
  page,
}) => {
  await signedIn(page, "bopha@demoq.test");
  await page.getByTestId("nav-tasks").click();
  await column(page, "client_review").getByTestId("task-action-request_revision").click();
  await expect(page.getByTestId("revision-modal")).toBeVisible();
  await expect(page.getByTestId("revision-oos-help")).toHaveCount(0); // rounds 1–3 need no decision
  await page.getByTestId("revision-note").fill("Bigger logo, warmer colours");
  await page.getByTestId("revision-submit").click();
  const doing = column(page, "in_progress");
  await expect(doing.getByTestId("task-round")).toHaveText("Round 1 of 4");

  const owner = await apiSession("bopha@demoq.test");
  const pm = await apiSession("pisey@demoq.test");
  // TSK-DL-05: a QC sent back returns the task to in progress without changing the round.
  let k = await task(owner);
  await owner.op("task.submit_qc", { id: k.id, expectedVersion: k.version });
  k = await task(owner);
  await pm.op("approval.decide", { id: k.qc!.approvalId, decision: "reject", note: "Logo is cut off on mobile" });
  k = await task(owner);
  expect(k).toMatchObject({ status: "in_progress", revision_round: 1 });

  k = await deliverRound(owner, pm);
  await owner.op("task.request_revision", { id: k.id, expectedVersion: k.version, note: "Round 2 changes" });
  await deliverRound(owner, pm);
  k = await task(owner);
  await owner.op("task.request_revision", { id: k.id, expectedVersion: k.version, note: "Round 3 changes" });
  k = await deliverRound(owner, pm);
  expect(k).toMatchObject({ status: "client_review", revision_round: 3 });
  await owner.dispose();
  await pm.dispose();

  await page.reload();
  await expect(column(page, "client_review").getByTestId("task-round")).toHaveText("Round 3 of 4");
  // The task view lists its rounds (TSK-DL-12).
  await column(page, "client_review").getByTestId("task-open").click();
  const rounds = page.getByTestId("task-rounds");
  await expect(rounds.locator('[data-kind="client"]')).toHaveCount(3);
  await expect(rounds.locator('[data-kind="internal"]')).toHaveCount(5);
  await page.getByTestId("task-details-close").click();
});

test("[TSK-DL-07][TSK-DL-08][APR-EN-13] a round-4 request needs rework hours and a note, then waits in the account lead's inbox with Absorb / Change order / Reject; absorb starts round 4", async ({
  page,
}) => {
  await signedIn(page, "bopha@demoq.test");
  await page.getByTestId("nav-tasks").click();
  await column(page, "client_review").getByTestId("task-action-request_revision").click();
  await expect(page.getByTestId("revision-oos-help")).toContainText("Round 4 is outside the quote");
  await expect(page.getByTestId("revision-submit")).toBeDisabled();
  await page.getByTestId("revision-hours").fill("3");
  await expect(page.getByTestId("revision-submit")).toBeDisabled(); // and a note
  await page.getByTestId("revision-note").fill("Client wants a fourth version with the new product shot");
  await page.getByTestId("revision-submit").click();
  await expect(page.getByTestId("revision-modal")).toHaveCount(0);

  // D2: nothing starts yet; the request is pending and a second one is not possible.
  const waiting = column(page, "client_review");
  await expect(waiting.getByTestId("task-round")).toHaveText("Round 3 of 4");
  await expect(waiting.getByTestId("task-round4")).toHaveAttribute("data-status", "pending");
  await expect(waiting.getByTestId("task-round4")).toContainText("waiting for an out-of-scope decision");
  await expect(waiting.getByTestId("task-action-request_revision")).toBeDisabled();

  await signedIn(page, "dara@demoq.test");
  await expect(page.getByTestId("inbox-count")).toBeVisible();
  await page.getByTestId("nav-inbox").click();
  const oos = page.locator('[data-kind="out_of_scope"]').filter({ hasText: `${TASK} (revision round 4)` });
  await expect(oos).toContainText("Out of scope");
  await expect(oos.getByTestId("approval-rework")).toHaveText("3h");
  await expect(oos.getByTestId("approval-reason")).toHaveText("Client wants a fourth version with the new product shot");
  for (const o of ["absorb", "change_order", "reject"]) await expect(oos.getByTestId(`decide-${o}`)).toBeVisible();
  await expect(oos.getByTestId("decide-absorb")).toHaveText("Absorb");
  await expect(oos.getByTestId("decide-change_order")).toHaveText("Change order");
  await expect(oos.getByTestId("decide-reject")).toHaveText("Reject");
  await oos.getByTestId("decision-note").fill("Goodwill for the launch");
  await oos.getByTestId("decide-absorb").click();
  await expect(oos).toHaveCount(0);
  await page.getByTestId("inbox-tab-recent").click();
  await expect(
    page.locator('[data-kind="out_of_scope"]').filter({ hasText: TASK }).getByTestId("approval-decided"),
  ).toContainText("Absorbed by Dara Lead");

  await signedIn(page, "bopha@demoq.test");
  await page.getByTestId("nav-tasks").click();
  const round4 = column(page, "in_progress");
  await expect(round4.getByTestId("task-round")).toHaveText("Round 4 of 4");
  await expect(round4.getByTestId("task-round4")).toHaveAttribute("data-outcome", "absorb");
  await expect(round4.getByTestId("task-round4")).toContainText("Round 4 absorbed by DemoQ");
});

test("[TSK-DL-10] round 5 is refused: the button is disabled with the hard-stop message and the server answers REVISION_HARD_STOP; the client accepts", async ({
  page,
}) => {
  const owner = await apiSession("bopha@demoq.test");
  const pm = await apiSession("pisey@demoq.test");
  const k = await deliverRound(owner, pm);
  expect(k).toMatchObject({ status: "client_review", revision_round: 4 });
  await pm.dispose();

  await signedIn(page, "bopha@demoq.test");
  await page.getByTestId("nav-tasks").click();
  const card = column(page, "client_review");
  await expect(card.getByTestId("task-action-request_revision")).toBeDisabled();
  await expect(card.getByTestId("task-hard-stop")).toHaveText(
    "No more revision rounds: round 5 is not possible. More work needs an accepted change order.",
  );
  const five = await owner.raw("task.request_revision", { id: k.id, expectedVersion: k.version, note: "One more?" });
  expect(five.status).toBe(409);
  expect(five.body.code).toBe("REVISION_HARD_STOP");
  await owner.dispose();

  await card.getByTestId("task-action-client_accept").click();
  await expect(column(page, "done")).toBeVisible();
});
