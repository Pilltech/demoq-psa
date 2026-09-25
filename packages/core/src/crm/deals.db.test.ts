import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, makeClient, makeDeal, makeUser, meta, type TestDb } from "@demoq/testkit";
import { errorMessage, ERROR_CODES } from "@demoq/shared";
import { DomainError, execute, type UserActor } from "../kernel";
import { closeReasonList, dealCreate, dealGet, dealList, dealMove, dealReopen } from "./deals";

let t: TestDb;
let lead: UserActor;
let otherLead: UserActor;
let ops: UserActor;
let staff: UserActor;
let clientId: string;

beforeAll(async () => {
  t = await createTestDb();
  lead = await makeUser(t.db, { roles: ["account_lead"], name: "Sokha Lead" });
  otherLead = await makeUser(t.db, { roles: ["account_lead"], name: "Dara Lead" });
  ops = await makeUser(t.db, { roles: ["ops_lead"], name: "Vanna Ops" });
  staff = await makeUser(t.db, { roles: ["staff"], name: "Bopha Staff" });
  clientId = (await makeClient(t.db, lead.id, "Angkor Beverages")).id;
});
afterAll(() => t.destroy());

const run = <T>(actor: UserActor, op: Parameters<typeof execute>[2], input: unknown, channel: "web" | "mcp" = "web") =>
  execute(t.kernel, meta(actor, channel), op, input) as Promise<T>;

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

async function freshDeal() {
  return makeDeal(t.db, clientId, lead.id);
}

describe("crm/close-reason", () => {
  let deal: { id: string; version: number };
  beforeEach(async () => {
    deal = await freshDeal();
  });

  it("[CRM-CR-01] moving to Lost without a reason is refused, on web and MCP", async () => {
    await expectCode(run(lead, dealMove, { id: deal.id, expectedVersion: 1, toStage: "lost" }), "CLOSE_REASON_REQUIRED");
    await expectCode(run(lead, dealMove, { id: deal.id, expectedVersion: 1, toStage: "lost" }, "mcp"), "CLOSE_REASON_REQUIRED");
    const row = await t.db.selectFrom("deals").select(["stage", "version"]).where("id", "=", deal.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ stage: "lead", version: 1 });
  });

  it("[CRM-CR-01] moving to Lost with a lost reason closes the deal", async () => {
    const r = await run<{ stage: string; version: number }>(lead, dealMove, {
      id: deal.id,
      expectedVersion: 1,
      toStage: "lost",
      closeReasonCode: "price",
      note: "Went with a cheaper agency",
    });
    expect(r).toMatchObject({ stage: "lost", version: 2, close_reason_code: "price" });
    const row = await t.db.selectFrom("deals").selectAll().where("id", "=", deal.id).executeTakeFirstOrThrow();
    expect(row.closed_at).toEqual(t.clock.now);
    expect(row.close_note).toBe("Went with a cheaper agency");
  });

  it("[CRM-CR-02] a won reason, an unknown reason, an inactive or import-only reason is refused for Lost", async () => {
    for (const code of ["relationship", "nope", "legacy_unrecorded"]) {
      await expectCode(
        run(lead, dealMove, { id: deal.id, expectedVersion: 1, toStage: "lost", closeReasonCode: code }),
        "CLOSE_REASON_INVALID",
      );
    }
    await t.migrator.updateTable("close_reasons").set({ active: false }).where("code", "=", "timing").execute();
    await expectCode(
      run(lead, dealMove, { id: deal.id, expectedVersion: 1, toStage: "lost", closeReasonCode: "timing" }),
      "CLOSE_REASON_INVALID",
    );
    await t.migrator.updateTable("close_reasons").set({ active: true }).where("code", "=", "timing").execute();
  });

  it("[CRM-CR-03] dragging to Won is refused: Won comes from accepting the quote", async () => {
    await expectCode(
      run(lead, dealMove, { id: deal.id, expectedVersion: 1, toStage: "won", closeReasonCode: "relationship" }),
      "WIN_REQUIRES_QUOTE",
    );
  });

  it("[CRM-CR-09] open stages move freely forwards and backwards; same stage is refused", async () => {
    let v = 1;
    for (const s of ["proposal", "qualified", "negotiation", "lead"] as const) {
      const r = await run<{ stage: string; version: number }>(lead, dealMove, { id: deal.id, expectedVersion: v, toStage: s });
      expect(r.stage).toBe(s);
      v = r.version;
    }
    await expectCode(run(lead, dealMove, { id: deal.id, expectedVersion: v, toStage: "lead" }), "INVALID_TRANSITION");
  });

  it("[CRM-CR-04] a Lost deal does not move; ops can reopen it to Qualified with a real reason", async () => {
    await run(lead, dealMove, { id: deal.id, expectedVersion: 1, toStage: "lost", closeReasonCode: "timing" });
    await expectCode(run(lead, dealMove, { id: deal.id, expectedVersion: 2, toStage: "proposal" }), "INVALID_TRANSITION");
    // Account leads hold no deal.reopen grant.
    await expectCode(run(lead, dealReopen, { id: deal.id, expectedVersion: 2, reason: "Client came back in March" }), "FORBIDDEN");
    await expectCode(run(ops, dealReopen, { id: deal.id, expectedVersion: 2, reason: "ok" }), "REOPEN_REASON_REQUIRED");
    const r = await run<{ stage: string }>(ops, dealReopen, { id: deal.id, expectedVersion: 2, reason: "Client came back in March" });
    expect(r.stage).toBe("qualified");
    const row = await t.db.selectFrom("deals").selectAll().where("id", "=", deal.id).executeTakeFirstOrThrow();
    expect(row.close_reason_code).toBeNull();
    expect(row.closed_at).toBeNull();
  });

  it("[CRM-CR-04] Won is terminal: it cannot be reopened", async () => {
    // Simulate quote.accept (S3) closing as Won — the only legitimate path.
    await t.migrator
      .updateTable("deals")
      .set({ stage: "won", close_reason_code: "creative", close_reason_kind: "won", closed_at: t.clock.now, version: 2 })
      .where("id", "=", deal.id)
      .execute();
    await expectCode(run(ops, dealReopen, { id: deal.id, expectedVersion: 2, reason: "Trying to reopen a won deal" }), "INVALID_TRANSITION");
    await expectCode(run(ops, dealMove, { id: deal.id, expectedVersion: 2, toStage: "lead" }), "INVALID_TRANSITION");
  });

  it("[CRM-CR-05] every stage change appends history naming the user; history is insert-only", async () => {
    const created = await run<{ id: string }>(lead, dealCreate, { clientId, title: "TikTok launch" });
    await run(lead, dealMove, { id: created.id, expectedVersion: 1, toStage: "qualified" });
    await run(lead, dealMove, { id: created.id, expectedVersion: 2, toStage: "lost", closeReasonCode: "budget_cut", note: "Q4 freeze" });
    await run(ops, dealReopen, { id: created.id, expectedVersion: 3, reason: "Budget restored for Q1" });
    const got = await run<{ history: { from_stage: string | null; to_stage: string; close_reason_code: string | null; changed_by_name: string }[] }>(
      ops,
      dealGet,
      { id: created.id },
    );
    expect(got.history.map((h) => [h.from_stage, h.to_stage, h.close_reason_code, h.changed_by_name])).toEqual([
      [null, "lead", null, "Sokha Lead"],
      ["lead", "qualified", null, "Sokha Lead"],
      ["qualified", "lost", "budget_cut", "Sokha Lead"],
      ["lost", "qualified", null, "Vanna Ops"],
    ]);
    await expect(sql`UPDATE deal_stage_history SET note = 'x'`.execute(t.db)).rejects.toThrow(/permission denied/);
    await expect(sql`DELETE FROM deal_stage_history`.execute(t.db)).rejects.toThrow(/permission denied/);
  });

  it("[CRM-CR-06] DB backstop: the app role cannot close without a matching reason, or leave a reason on an open deal", async () => {
    await expect(
      t.db.updateTable("deals").set({ stage: "lost", closed_at: t.clock.now }).where("id", "=", deal.id).execute(),
    ).rejects.toThrow(/deals_close_reason_required/);
    await expect(
      t.db
        .updateTable("deals")
        .set({ stage: "lost", close_reason_code: "relationship", close_reason_kind: "won", closed_at: t.clock.now })
        .where("id", "=", deal.id)
        .execute(),
    ).rejects.toThrow(/deals_close_reason_required/);
    await expect(
      t.db
        .updateTable("deals")
        .set({ stage: "lost", close_reason_code: "relationship", close_reason_kind: "lost", closed_at: t.clock.now })
        .where("id", "=", deal.id)
        .execute(),
    ).rejects.toThrow(/foreign key/);
    await expect(
      t.db.updateTable("deals").set({ close_reason_code: "price", close_reason_kind: "lost" }).where("id", "=", deal.id).execute(),
    ).rejects.toThrow(/deals_close_reason_required/);
  });

  it("[CRM-CR-07] every error code has English and Khmer text", () => {
    for (const code of ERROR_CODES) {
      expect(errorMessage(code, "en")).toBeTruthy();
      expect(errorMessage(code, "km")).toBeTruthy();
      expect(errorMessage(code, "km")).not.toBe(errorMessage(code, "en"));
    }
    expect(errorMessage("CLOSE_REASON_REQUIRED", "km")).toMatch(/[ក-៿]/);
  });

  it("[CRM-CR-08] a successful move writes exactly one audit row naming the actor and channel; a refusal is audited as denied", async () => {
    await run(lead, dealMove, { id: deal.id, expectedVersion: 1, toStage: "qualified" }, "mcp");
    const rows = await t.db.selectFrom("audit_events").selectAll().where("subject_id", "=", deal.id).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "deal.move", actor_name: "Sokha Lead", actor_id: lead.id, channel: "mcp", outcome: "ok" });
    expect(rows[0]!.input).toMatchObject({ toStage: "qualified" });

    await expectCode(run(staff, dealMove, { id: deal.id, expectedVersion: 2, toStage: "proposal" }), "FORBIDDEN");
    const denied = await t.db
      .selectFrom("audit_events")
      .selectAll()
      .where("actor_id", "=", staff.id)
      .where("action", "=", "deal.move")
      .execute();
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ outcome: "denied", error_code: "FORBIDDEN", actor_name: "Bopha Staff" });
  });

  it("[CRM-CR-10] only the owner or ops/director/ceo may move a deal, on every channel", async () => {
    for (const channel of ["web", "mcp"] as const) {
      await expectCode(run(otherLead, dealMove, { id: deal.id, expectedVersion: 1, toStage: "qualified" }, channel), "FORBIDDEN");
      await expectCode(run(staff, dealMove, { id: deal.id, expectedVersion: 1, toStage: "qualified" }, channel), "FORBIDDEN");
    }
    const r = await run<{ stage: string }>(ops, dealMove, { id: deal.id, expectedVersion: 1, toStage: "qualified" });
    expect(r.stage).toBe("qualified");
    // Nor can an account lead open a deal in someone else's name.
    await expectCode(run(lead, dealCreate, { clientId, title: "x", ownerId: otherLead.id }), "FORBIDDEN");
    // Deal moves are not exposed on Telegram in v1.
    await expectCode(execute(t.kernel, meta(ops, "telegram"), dealMove, { id: deal.id, expectedVersion: 2, toStage: "lead" }), "FORBIDDEN");
  });

  it("[CRM-CR-11] a stale version is refused", async () => {
    await run(lead, dealMove, { id: deal.id, expectedVersion: 1, toStage: "qualified" });
    await expectCode(run(lead, dealMove, { id: deal.id, expectedVersion: 1, toStage: "proposal" }), "STALE_VERSION");
  });

  it("[CRM-CR-12] the picker offers active, non-legacy reasons with Khmer labels", async () => {
    const lost = await run<{ code: string; kind: string; label_km: string }[]>(staff, closeReasonList, { kind: "lost" });
    expect(lost.map((r) => r.code)).toContain("price");
    expect(lost.map((r) => r.code)).not.toContain("legacy_unrecorded");
    expect(lost.every((r) => r.kind === "lost" && /[ក-៿]/.test(r.label_km))).toBe(true);
  });

  it("staff cannot see the pipeline; account leads see every deal", async () => {
    await expectCode(run(staff, dealList, {}), "FORBIDDEN");
    const all = await run<{ id: string; canManage: boolean }[]>(otherLead, dealList, {});
    const mine = all.find((d) => d.id === deal.id);
    expect(mine?.canManage).toBe(false);
  });
});
