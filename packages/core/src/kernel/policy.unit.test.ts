import { describe, expect, it } from "vitest";
import { can, rowFilter, scopesFor } from "./policy";
import type { UserActor } from "./types";

const user = (roles: UserActor["roles"], id = "u1", teamId: string | null = "t1"): UserActor => ({
  type: "user",
  id,
  name: "Test",
  roles,
  teamId,
});

describe("policy", () => {
  it("[CRM-CR-10] account leads manage only their own deals; ops/director/ceo manage any", () => {
    const lead = user(["account_lead"]);
    expect(can(lead, "deal.manage", { ownerIds: ["u1"] })).toBe(true);
    expect(can(lead, "deal.manage", { ownerIds: ["someone-else"] })).toBe(false);
    expect(can(lead, "deal.manage")).toBe(false);
    for (const r of ["ops_lead", "director", "ceo"] as const) {
      expect(can(user([r]), "deal.manage", { ownerIds: ["someone-else"] })).toBe(true);
    }
    for (const r of ["staff", "team_lead", "project_manager", "finance", "viewer", "admin", "influencer_manager"] as const) {
      expect(can(user([r]), "deal.manage", { ownerIds: ["u1"] })).toBe(false);
    }
  });

  it("team scope matches only the actor's team", () => {
    const tl = user(["team_lead"], "u1", "t1");
    expect(can(tl, "task.manage", { teamIds: ["t1"] })).toBe(true);
    expect(can(tl, "task.manage", { teamIds: ["t2"] })).toBe(false);
    expect(can(user(["team_lead"], "u1", null), "task.manage", { teamIds: [null] })).toBe(false);
  });

  it("assigned scope matches assignees", () => {
    const pm = user(["project_manager"]);
    expect(can(pm, "project.activate", { assigneeIds: ["u1"] })).toBe(true);
    expect(can(pm, "project.activate", { assigneeIds: ["u2"] })).toBe(false);
  });

  it("combines scopes across roles and picks the widest for lists", () => {
    const both = user(["account_lead", "ops_lead"]);
    expect(scopesFor(both, "deal.manage")).toEqual(new Set(["own", "any"]));
    expect(rowFilter(both, "deal.manage")).toEqual({ kind: "any" });
    expect(rowFilter(user(["staff"]), "deal.view")).toBeNull();
  });

  it("non-user actors hold no permissions", () => {
    expect(can({ type: "job", name: "job:x" }, "deal.view")).toBe(false);
    expect(can({ type: "anonymous", name: "x" }, "client.view")).toBe(false);
  });

  it("[ID-US-01] only admin manages users and teams; admin makes no business decisions", () => {
    expect(can(user(["admin"]), "user.manage")).toBe(true);
    expect(can(user(["ceo"]), "user.manage")).toBe(false);
    expect(can(user(["admin"]), "deal.manage", { ownerIds: ["u1"] })).toBe(false);
    expect(can(user(["admin"]), "quote.approve_below_floor")).toBe(false);
  });

  it("[CRM-CL-03] every internal role can view clients", () => {
    for (const r of [
      "ceo",
      "director",
      "ops_lead",
      "finance",
      "account_lead",
      "project_manager",
      "team_lead",
      "staff",
      "influencer_manager",
      "viewer",
    ] as const) {
      expect(can(user([r]), "client.view")).toBe(true);
    }
  });
});
