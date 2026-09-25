import { describe, expect, it } from "vitest";
import { registry } from "@demoq/core";
import { check } from "../../scripts/matrix-check";
import { coverage } from "../../scripts/spec-coverage";

describe("governance", () => {
  it("[KER-09] the permission matrix in code equals the signed CSV", () => {
    expect(check()).toEqual([]);
  });

  it("[KER-10] every operation is uniquely named, summarised and exposed on a channel", () => {
    const names = registry.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
    for (const op of registry) {
      expect(op.summary.length, op.name).toBeGreaterThan(5);
      expect(op.exposeTo.length, op.name).toBeGreaterThan(0);
    }
  });

  it("every spec rule is cited by a test", () => {
    expect(coverage().uncovered).toEqual([]);
  });
});
