import { sql } from "kysely";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makeUser, meta, type TestDb } from "@demoq/testkit";
import { defineCommand, defineQuery, DomainError, execute, redact, type UserActor } from ".";
import { clientList } from "../crm";

let t: TestDb;
let ops: UserActor;
beforeAll(async () => {
  t = await createTestDb();
  ops = await makeUser(t.db, { roles: ["ops_lead"], name: "Vanna Ops" });
});
afterAll(() => t.destroy());

const probe = defineCommand({
  name: "test.probe",
  summary: "test",
  permission: "client.manage",
  input: z.object({ name: z.string().min(2), password: z.string().optional(), fail: z.boolean().default(false) }),
  exposeTo: ["web"],
  async run(ctx, input) {
    const row = await ctx.tx.insertInto("teams").values({ name: input.name }).returning("id").executeTakeFirstOrThrow();
    ctx.emit("test.probed", { teamId: row.id, amount: 5n });
    if (input.fail) throw new DomainError("CONFLICT");
    return row;
  },
  subject: (_i, r) => ({ type: "team", id: r.id }),
});

const expectCode = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);

describe("kernel/command-pipeline", () => {
  it("[KER-01] a command changes data, writes its audit row and outbox event, and records row changes with the actor", async () => {
    const m = meta(ops);
    const r = await execute(t.kernel, m, probe, { name: "Alpha" });
    const audit = await t.db.selectFrom("audit_events").selectAll().where("request_id", "=", m.requestId).execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "test.probe", actor_name: "Vanna Ops", subject_id: r.id });
    const outbox = await t.db.selectFrom("outbox").selectAll().where("request_id", "=", m.requestId).execute();
    expect(outbox.map((o) => o.event)).toEqual(["test.probed"]);
    const changes = await t.db.selectFrom("audit_changes").selectAll().where("request_id", "=", m.requestId).execute();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ table_name: "teams", op: "INSERT", actor_name: "Vanna Ops", channel: "web" });
  });

  it("[KER-02] a command is refused on channels outside exposeTo", async () => {
    await expectCode(execute(t.kernel, meta(ops, "mcp"), probe, { name: "Beta" }), "FORBIDDEN");
  });

  it("[KER-03] invalid input is refused with field issues before any DB work", async () => {
    const err = await execute(t.kernel, meta(ops), probe, { name: "x" }).catch((e) => e as DomainError);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe("VALIDATION");
    expect((err as DomainError).params.issues).toEqual([expect.objectContaining({ path: "name" })]);
  });

  it("[KER-04] a failure rolls back the change, the audit row and the outbox event", async () => {
    const m = meta(ops);
    await expectCode(execute(t.kernel, m, probe, { name: "Gamma", fail: true }), "CONFLICT");
    expect(await t.db.selectFrom("teams").select("id").where("name", "=", "Gamma").execute()).toEqual([]);
    expect(await t.db.selectFrom("audit_events").select("id").where("request_id", "=", m.requestId).execute()).toEqual([]);
    expect(await t.db.selectFrom("outbox").select("id").where("request_id", "=", m.requestId).execute()).toEqual([]);
  });

  it("[KER-05] a permission refusal is audited as denied", async () => {
    const staff = await makeUser(t.db, { roles: ["staff"], name: "Bopha Staff" });
    const m = meta(staff);
    await expectCode(execute(t.kernel, m, probe, { name: "Delta" }), "FORBIDDEN");
    const rows = await t.db.selectFrom("audit_events").selectAll().where("request_id", "=", m.requestId).execute();
    expect(rows).toEqual([expect.objectContaining({ outcome: "denied", actor_name: "Bopha Staff", action: "test.probe" })]);
  });

  it("[KER-06] audit input masks secrets and serialises bigints", async () => {
    expect(redact({ password: "p", nested: { totpCode: "123456", token: "t", amount: 10n }, name: "ok" })).toEqual({
      password: "[redacted]",
      nested: { totpCode: "[redacted]", token: "[redacted]", amount: "10" },
      name: "ok",
    });
    const m = meta(ops);
    await execute(t.kernel, m, probe, { name: "Epsilon", password: "hunter2hunter2" });
    const row = await t.db
      .selectFrom("audit_events")
      .select("input")
      .where("request_id", "=", m.requestId)
      .executeTakeFirstOrThrow();
    expect(row.input).toMatchObject({ password: "[redacted]", name: "Epsilon" });
  });

  it("[KER-07] emitted events reach the outbox in the same transaction", async () => {
    const m = meta(ops);
    await execute(t.kernel, m, probe, { name: "Zeta" });
    const [evt] = await t.db.selectFrom("outbox").selectAll().where("request_id", "=", m.requestId).execute();
    expect(evt?.payload).toMatchObject({ amount: "5" });
    expect(evt?.delivered_at).toBeNull();
  });

  it("[KER-08] queries are read-only, and audited on MCP but not on web", async () => {
    const writer = defineQuery({
      name: "test.sneaky_write",
      summary: "test",
      permission: "client.view",
      input: z.object({}),
      exposeTo: ["web"],
      async run(ctx) {
        await sql`INSERT INTO teams (name) VALUES ('sneaky')`.execute(ctx.tx);
      },
    });
    await expect(execute(t.kernel, meta(ops), writer, {})).rejects.toThrow(/read-only/);
    const web = meta(ops, "web");
    const mcp = meta(ops, "mcp", { mcpClient: "claude-code" });
    await execute(t.kernel, web, clientList, {});
    await execute(t.kernel, mcp, clientList, {});
    expect(await t.db.selectFrom("audit_events").select("id").where("request_id", "=", web.requestId).execute()).toEqual([]);
    const mcpRows = await t.db.selectFrom("audit_events").selectAll().where("request_id", "=", mcp.requestId).execute();
    expect(mcpRows).toEqual([
      expect.objectContaining({ action: "client.list", channel: "mcp", mcp_client: "claude-code", actor_name: "Vanna Ops" }),
    ]);
  });
});
