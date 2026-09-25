import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makeClient, makeDeal, makeUser, meta, type TestDb } from "@demoq/testkit";
import { DomainError, execute, type UserActor } from ".";
import { auditTimeline } from "../audit/queries";
import { dealMove } from "../crm";

let t: TestDb;
let ops: UserActor;
let lead: UserActor;
beforeAll(async () => {
  t = await createTestDb();
  ops = await makeUser(t.db, { roles: ["ops_lead"], name: "Vanna Ops" });
  lead = await makeUser(t.db, { roles: ["account_lead"], name: "Sokha Lead" });
});
afterAll(() => t.destroy());

describe("kernel/audit", () => {
  it("[AUD-01] the app role cannot update, delete or truncate audit rows", async () => {
    await sql`INSERT INTO audit_events (action, actor_type, actor_name, channel, request_id) VALUES ('x', 'job', 'job:test', 'job', 'r1')`.execute(t.db);
    for (const stmt of [sql`UPDATE audit_events SET action = 'y'`, sql`DELETE FROM audit_events`, sql`TRUNCATE audit_events`, sql`UPDATE audit_changes SET op = 'DELETE'`]) {
      await expect(stmt.execute(t.db)).rejects.toThrow(/permission denied/);
    }
  });

  it("[AUD-02] even the schema owner cannot rewrite audit history", async () => {
    await expect(sql`UPDATE audit_events SET action = 'y'`.execute(t.migrator)).rejects.toThrow(/AUDIT_APPEND_ONLY/);
    await expect(sql`DELETE FROM audit_changes`.execute(t.migrator)).rejects.toThrow(/AUDIT_APPEND_ONLY/);
    await expect(sql`TRUNCATE audit_events`.execute(t.migrator)).rejects.toThrow(/AUDIT_APPEND_ONLY/);
  });

  it("[AUD-03] row changes carry the actor's name, channel and request id, with secrets masked", async () => {
    const client = await makeClient(t.db, lead.id);
    const deal = await makeDeal(t.db, client.id, lead.id);
    const m = meta(lead, "mcp");
    await execute(t.kernel, m, dealMove, { id: deal.id, expectedVersion: 1, toStage: "qualified" });
    const [change] = await t.db.selectFrom("audit_changes").selectAll().where("request_id", "=", m.requestId).where("table_name", "=", "deals").execute();
    expect(change).toMatchObject({ op: "UPDATE", actor_id: lead.id, actor_name: "Sokha Lead", channel: "mcp", row_id: deal.id });
    expect((change!.old_row as { stage: string }).stage).toBe("lead");
    expect((change!.new_row as { stage: string }).stage).toBe("qualified");
    const userChange = await t.db.selectFrom("audit_changes").select("new_row").where("table_name", "=", "users").where("row_id", "=", lead.id).executeTakeFirstOrThrow();
    expect((userChange.new_row as { password_hash: string }).password_hash).toBe("[redacted]");
  });

  it("[AUD-04] the timeline shows who did what, newest first, to audit.view holders only", async () => {
    const client = await makeClient(t.db, lead.id);
    const deal = await makeDeal(t.db, client.id, lead.id);
    await execute(t.kernel, meta(lead, "web"), dealMove, { id: deal.id, expectedVersion: 1, toStage: "qualified" });
    await execute(t.kernel, meta(ops, "mcp"), dealMove, { id: deal.id, expectedVersion: 2, toStage: "proposal" });
    const rows = await execute(t.kernel, meta(ops), auditTimeline, { subjectType: "deal", subjectId: deal.id });
    expect(rows.map((r: { actor_name: string; channel: string; action: string }) => [r.actor_name, r.channel, r.action])).toEqual([
      ["Vanna Ops", "mcp", "deal.move"],
      ["Sokha Lead", "web", "deal.move"],
    ]);
    await expect(execute(t.kernel, meta(lead), auditTimeline, { subjectType: "deal", subjectId: deal.id })).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainError && e.code === "FORBIDDEN",
    );
  });
});
