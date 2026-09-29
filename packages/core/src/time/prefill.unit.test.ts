import { describe, expect, it } from "vitest";
import { autoCloseAt } from "./attendance";
import { isoWeekday, weekStartOf } from "./calendar";
import { draftHash, round15, splitMinutes, targetKey } from "./prefill";

describe("time/pre-fill arithmetic", () => {
  it("[TIM-TS-04] minutes round to 15 and split by weight in 15-minute slots that add up exactly", () => {
    expect(round15(487)).toBe(480);
    expect(round15(488)).toBe(495);
    expect(round15(-5)).toBe(0);
    expect(splitMinutes(540, [1200, 720])).toEqual([345, 195]); // 62.5 % / 37.5 % of 36 slots → 22.5 / 13.5
    expect(splitMinutes(480, [1, 1, 1])).toEqual([165, 165, 150]);
    expect(splitMinutes(15, [1, 1])).toEqual([15, 0]);
    expect(splitMinutes(480, [])).toEqual([]);
    for (const [total, weights] of [
      [450, [3, 5, 7]],
      [900, [1, 2]],
      [30, [9, 9, 9, 9]],
    ] as const) {
      const parts = splitMinutes(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(parts.every((p) => p % 15 === 0)).toBe(true);
    }
  });

  it("[TIM-TS-09] the draft hash is order-independent and changes with any minute or target", () => {
    const a = {
      date: "2026-10-19",
      targetType: "task" as const,
      taskId: "t1",
      projectId: "p1",
      dealId: null,
      activityCode: null,
      minutes: 240,
    };
    const b = {
      date: "2026-10-19",
      targetType: "internal" as const,
      taskId: null,
      projectId: null,
      dealId: null,
      activityCode: "admin",
      minutes: 240,
    };
    expect(draftHash("2026-10-19", [a, b])).toBe(draftHash("2026-10-19", [b, a]));
    expect(draftHash("2026-10-19", [a, { ...b, minutes: 225 }])).not.toBe(draftHash("2026-10-19", [a, b]));
    expect(draftHash("2026-10-26", [a, b])).not.toBe(draftHash("2026-10-19", [a, b]));
    expect(targetKey(a)).toBe("t1");
    expect(targetKey(b)).toBe("code:admin");
  });

  it("[TIM-AT-05] auto-close is 23:59 Phnom Penh time or 12 h after the start, whichever is first", () => {
    // 08:00 start → 20:00 (12 h) comes before 23:59
    expect(autoCloseAt(new Date("2026-10-19T01:00:00Z")).toISOString()).toBe("2026-10-19T13:00:00.000Z");
    // 18:00 start → 23:59 the same day
    expect(autoCloseAt(new Date("2026-10-19T11:00:00Z")).toISOString()).toBe("2026-10-19T16:59:00.000Z");
    // 23:59:30 start → 12 h later (the next 23:59 is further away)
    expect(autoCloseAt(new Date("2026-10-19T16:59:30Z")).toISOString()).toBe("2026-10-20T04:59:30.000Z");
  });

  it("[TIM-LV-07] ISO weeks start on Monday (D-TM-3)", () => {
    expect(isoWeekday("2026-10-19")).toBe(1);
    expect(isoWeekday("2026-10-25")).toBe(7);
    expect(weekStartOf("2026-10-25")).toBe("2026-10-19");
    expect(weekStartOf("2026-10-19")).toBe("2026-10-19");
  });
});
