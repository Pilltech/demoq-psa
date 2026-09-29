// E2E for Sprint 4 time (specs/time/attendance.md, timesheets.md, leave-holidays.md) — the S4 demo, automated: clock in
// and out on a phone; last week pre-filled and confirmed with one tap, timed from opening the page (M2 #10: < 120 s);
// a confirmed week is locked; the team lead sees it and reopens it with a reason; leave requested and approved from the
// inbox. Synthetic seed: Nary Writer (staff, Creative) with a started internal task; Chanthy Lead leads Creative.
import { expect, test, type Page } from "@playwright/test";
import { addDays, apiRaw, mondayOf, noSideScroll, ppToday, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });

async function signedIn(page: Page, email: string) {
  await page.context().clearCookies(); // switch person within a test
  await signIn(page, email);
  await expect(page.getByTestId("sign-out")).toBeVisible();
}

test("@phone [TIM-AT-01][TIM-AT-02][TIM-AT-06] clock in and out from the header on a phone; the running time and today's total show", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await signedIn(page, "nary@demoq.test");
  const clock = page.getByTestId("clock");
  await expect(clock).toBeVisible();
  // A previous run may have left the clock running: close it first (it is at least a minute old then).
  if ((await clock.getAttribute("data-running")) === "true") {
    await page.getByTestId("clock-out").click();
    await expect(page.getByTestId("clock-in")).toBeVisible();
  }
  const todayBefore = Number(await page.getByTestId("clock-today").getAttribute("data-minutes"));
  await page.getByTestId("clock-in").click();
  const startedAt = Date.now();
  await expect(clock).toHaveAttribute("data-running", "true");
  await expect(page.getByTestId("clock-running")).toHaveText("0m");
  expect(await noSideScroll(page)).toBe(true);

  // TIM-AT-02: one open session per person.
  const again = await apiRaw(page, "attendance.clock_in", {});
  expect(again.status).toBe(409);
  expect(again.body.code).toBe("CLOCK_RUNNING");
  // Less than a minute is not attendance: the server refuses and the header says why.
  await page.getByTestId("clock-out").click();
  await expect(page.getByTestId("clock-error")).toHaveText("Clock out at least a minute after clocking in.");
  await expect(clock).toHaveAttribute("data-running", "true");

  // The clock is reachable from every page (here: My tasks).
  await page.getByTestId("nav-tasks").click();
  await expect(page.getByTestId("clock-out")).toBeVisible();
  await page.waitForTimeout(Math.max(0, 61_000 - (Date.now() - startedAt)));
  await page.getByTestId("clock-out").click();
  await expect(page.getByTestId("clock-in")).toBeVisible();
  await expect(clock).toHaveAttribute("data-running", "false");
  const todayAfter = Number(await page.getByTestId("clock-today").getAttribute("data-minutes"));
  expect(todayAfter).toBeGreaterThanOrEqual(todayBefore + 1);
  expect(await noSideScroll(page)).toBe(true);
});

test("[TIM-TS-04][TIM-TS-05][TIM-TS-10] last week is pre-filled and confirmed with one tap, under two minutes from opening the page", async ({
  page,
}) => {
  await signedIn(page, "nary@demoq.test");
  const lastMonday = addDays(mondayOf(ppToday()), -7);

  const opened = Date.now();
  await page.getByTestId("nav-time").click();
  await expect(page.getByTestId("week")).toHaveAttribute("data-week", mondayOf(ppToday()));
  await page.getByTestId("week-prev").click();
  const week = page.getByTestId("week");
  await expect(week).toHaveAttribute("data-week", lastMonday);
  await expect(page.getByTestId("week-status")).toHaveAttribute("data-status", "open");
  // D-TM-2: no history, so her started task carries the week; days off are not pre-filled.
  await expect(page.getByTestId("week-basis")).toHaveAttribute("data-basis", "open_tasks");
  await expect(page.getByTestId("week-row-0")).toHaveAttribute("data-label", "Craft fair captions");
  await expect(page.getByTestId(`week-day-${addDays(lastMonday, 6)}`)).toHaveAttribute("data-working", "false"); // Sunday
  expect(Number(await page.getByTestId("week-total").getAttribute("data-minutes"))).toBeGreaterThan(0);

  await page.getByTestId("week-confirm").click(); // the one tap
  await expect(page.getByTestId("week-status")).toHaveAttribute("data-status", "confirmed");
  const elapsed = (Date.now() - opened) / 1000;
  console.log(`week confirmation: ${elapsed.toFixed(1)} s from opening the page (M2 #10 target < 120 s)`);
  expect(elapsed).toBeLessThan(120);
  // The server measured it too, from timesheet.open to the first confirmation (TIM-TS-10).
  const serverSeconds = Number(await page.getByTestId("week-confirm-seconds").getAttribute("data-seconds"));
  expect(serverSeconds).toBeLessThan(120);
});

test("[TIM-TS-06][INV-12] a confirmed week is locked: no inputs, and the server refuses new time in it", async ({ page }) => {
  await signedIn(page, "nary@demoq.test");
  const lastMonday = addDays(mondayOf(ppToday()), -7);
  await page.getByTestId("nav-time").click();
  await page.getByTestId("week-prev").click();
  await expect(page.getByTestId("week-locked")).toContainText("This week is locked");
  await expect(page.getByTestId("week-confirm")).toHaveCount(0);
  await expect(page.locator('[data-testid^="week-input-"]')).toHaveCount(0);
  await expect(page.getByTestId("week-add-row")).toHaveCount(0);
  const late = await apiRaw(page, "time.allocate", {
    date: lastMonday,
    targetType: "internal",
    activityCode: "training",
    minutes: 60,
  });
  expect(late.status).toBe(409);
  expect(late.body.code).toBe("TIMESHEET_CONFIRMED");
});

test("[TIM-TS-08][TIM-TS-07] the team lead sees who confirmed last week and reopens a week with a reason", async ({ page }) => {
  await signedIn(page, "chanthy@demoq.test");
  await page.getByTestId("nav-time").click();
  await page.getByTestId("tab-team").click();
  await page.getByTestId("week-prev").click();
  const row = page.getByTestId("team-row-Nary Writer");
  await expect(row).toHaveAttribute("data-status", "confirmed");
  await expect(page.getByTestId("team-table")).toContainText("Bopha Designer"); // her whole team
  await expect(page.getByTestId("team-table")).not.toContainText("Pisey PM"); // not another team
  await row.getByTestId("team-reopen").click();
  await expect(page.getByTestId("reopen-submit")).toBeDisabled();
  await page.getByTestId("reopen-reason").fill("Friday was a training day");
  await page.getByTestId("reopen-submit").click();
  await expect(row).toHaveAttribute("data-status", "open");

  // Nary sees why, edits a cell and confirms again (the edit is hers, the rest stays pre-filled).
  await signedIn(page, "nary@demoq.test");
  await page.getByTestId("nav-time").click();
  await page.getByTestId("week-prev").click();
  await expect(page.getByTestId("week-reopened")).toContainText("Friday was a training day");
  const friday = addDays(addDays(mondayOf(ppToday()), -7), 4);
  await page.getByTestId("week-add-row").selectOption({ label: "Training" });
  const training = page.locator('[data-testid^="week-row-"][data-label="Training"]');
  const idx = (await training.getAttribute("data-testid"))!.replace("week-row-", "");
  await page.getByTestId(`week-input-${idx}-${friday}`).fill("2");
  await expect(page.getByTestId("week-confirm")).toHaveAttribute("data-edited", "true");
  await page.getByTestId("week-confirm").click();
  await expect(page.getByTestId("week-status")).toHaveAttribute("data-status", "confirmed");
  await expect(page.getByTestId(`week-cell-${idx}-${friday}`)).toHaveAttribute("data-minutes", "120");
});

test("[TIM-LV-03][TIM-LV-05][TIM-LV-01] leave is requested, approved by the team lead from the inbox, and holidays show as unverified", async ({
  page,
}) => {
  const day = addDays(ppToday(), 21);
  await signedIn(page, "nary@demoq.test");
  await page.getByTestId("nav-time").click();
  await page.getByTestId("tab-leave").click();
  await page.getByTestId("leave-type").selectOption("annual");
  await page.getByTestId("leave-start").fill(day);
  await page.getByTestId("leave-end").fill(day);
  await page.getByTestId("leave-half-am").check();
  await page.getByTestId("leave-reason").fill("Family event");
  await page.getByTestId("leave-submit").click();
  await expect(page.getByTestId("leave-flash")).toBeVisible();
  await expect(page.getByTestId(`leave-${day}`)).toHaveAttribute("data-status", "requested");
  await expect(page.getByTestId(`leave-${day}`)).toContainText("Waiting for approval");
  await expect(page.getByTestId(`leave-${day}`)).toContainText("Morning");
  // D-HD-1: the seeded holidays are marked unverified until admin checks them.
  await expect(page.locator('[data-testid^="holiday-"][data-verified="false"]').first()).toContainText("unverified");

  // A second request, cancelled while it waits (TIM-LV-05).
  const other = addDays(day, 7);
  await page.getByTestId("leave-type").selectOption("sick");
  await page.getByTestId("leave-start").fill(other);
  await page.getByTestId("leave-end").fill(other);
  await page.getByTestId("leave-submit").click();
  await expect(page.getByTestId(`leave-${other}`)).toHaveAttribute("data-status", "requested");
  await page.getByTestId(`leave-${other}`).getByTestId("leave-cancel").click();
  await expect(page.getByTestId(`leave-${other}`)).toHaveAttribute("data-status", "cancelled");

  await signedIn(page, "chanthy@demoq.test");
  await page.getByTestId("nav-inbox").click();
  const card = page.locator('[data-kind="leave"]').filter({ hasText: "Nary Writer" });
  await expect(card).toHaveCount(1); // the cancelled one is gone
  await expect(card.getByTestId("approval-leave-type")).toHaveText("Annual leave");
  await expect(card.getByTestId("approval-leave-dates")).toContainText(`${day} · Morning`);
  await card.getByTestId("approve-approval").click();
  await expect(card).toHaveCount(0);

  await signedIn(page, "nary@demoq.test");
  await page.getByTestId("nav-time").click();
  await page.getByTestId("tab-leave").click();
  await expect(page.getByTestId(`leave-${day}`)).toHaveAttribute("data-status", "approved");
});
