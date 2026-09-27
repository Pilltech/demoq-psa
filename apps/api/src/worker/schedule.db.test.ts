import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makeUser, type TestDb } from "@demoq/testkit";
import { firstWorkingDay, newScheduleState, runSchedule } from "./schedule";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb("2026-10-30T02:00:00Z");
});
afterAll(() => t.destroy());

describe("worker schedule", () => {
  it("[PRJ-BP-05] the monthly review runs on the first working day of the month, once; sweep hourly; retainer tick daily", async () => {
    expect(firstWorkingDay("2026-11-17")).toBe("2026-11-02"); // Nov 1 2026 is a Sunday
    expect(firstWorkingDay("2026-12-09")).toBe("2026-12-01");
    const ceo = await makeUser(t.db, { roles: ["ceo"] });
    await makeUser(t.db, { roles: ["director"] });
    const logged: string[] = [];
    const state = newScheduleState();
    const tick = () => runSchedule(t.kernel, state, { reviewRequesterId: ceo.id, log: (m) => logged.push(m) });
    await tick();
    expect(logged).toEqual(["bypass_sweep", "retainer_tick"]);
    t.clock.advance(10 * 60_000);
    await tick();
    expect(logged).toHaveLength(2); // same hour, same day
    t.clock.set("2026-11-02T01:00:00Z"); // 08:00 Monday in Phnom Penh
    await tick();
    await tick();
    expect(logged.filter((m) => m === "bypass_monthly_review")).toHaveLength(1);
    const reviews = await t.db.selectFrom("approvals").select("subject_hash").where("kind", "=", "bypass_review").execute();
    expect(reviews).toEqual([{ subject_hash: "2026-10-01" }]);
  });
});
