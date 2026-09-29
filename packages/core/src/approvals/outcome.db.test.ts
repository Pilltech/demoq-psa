import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptedProject, createTestDb, makeUser, runAs, type TestDb } from "@demoq/testkit";
import { DomainError, type OpDef, type UserActor } from "../kernel";
import { taskCreate } from "../tasks";
import { approvalDecide, approvalInbox } from "./commands";

let t: TestDb;
let lead: UserActor, pm: UserActor, ops: UserActor, designer: UserActor;

beforeAll(async () => {
  t = await createTestDb();
  lead = await makeUser(t.db, { roles: ["account_lead"] });
  pm = await makeUser(t.db, { roles: ["project_manager"] });
  ops = await makeUser(t.db, { roles: ["ops_lead"] });
  designer = await makeUser(t.db, { roles: ["staff"] });
});
afterAll(() => t.destroy());

const run = <T>(a: UserActor, op: OpDef, input: unknown, channel?: "web" | "mcp") => runAs<T>(t, a, op, input, channel);
const expectCode = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);

async function oosApproval(): Promise<string> {
  const p = await acceptedProject(t, lead, { pmId: pm.id });
  const task = await run<{ oosApprovalId: string }>(pm, taskCreate, {
    projectId: p.projectId,
    title: "Extra banner",
    ownerId: designer.id,
    estimateMinutes: 60,
    dueDate: "2026-11-05",
    outOfScopeReason: "Client asked for one more banner during the call",
  });
  return task.oosApprovalId;
}
const outcomeOf = async (id: string) =>
  await t.db.selectFrom("approvals").select(["status", "outcome"]).where("id", "=", id).executeTakeFirstOrThrow();

describe("approvals — out-of-scope outcomes", () => {
  it("[APR-EN-13] approve = absorb, reject defaults to reject, change_order is a rejection; mismatches refused", async () => {
    const a = await oosApproval();
    await expectCode(run(ops, approvalDecide, { id: a, decision: "approve", outcome: "reject" }), "VALIDATION");
    await expectCode(run(ops, approvalDecide, { id: a, decision: "reject", outcome: "absorb" }), "VALIDATION");
    await run(ops, approvalDecide, { id: a, decision: "approve" });
    expect(await outcomeOf(a)).toEqual({ status: "approved", outcome: "absorb" });

    const b = await oosApproval();
    await run(ops, approvalDecide, { id: b, decision: "reject" });
    expect(await outcomeOf(b)).toEqual({ status: "rejected", outcome: "reject" });

    const c = await oosApproval();
    await run(ops, approvalDecide, { id: c, decision: "reject", outcome: "change_order" });
    expect(await outcomeOf(c)).toEqual({ status: "rejected", outcome: "change_order" });
  });

  it("[APR-EN-13] the inbox shows the recorded outcome, so a change order is not read as a plain rejection", async () => {
    const a = await oosApproval();
    const pending = await run<{ id: string; outcome: string | null }[]>(ops, approvalInbox, { include: "pending" });
    expect(pending.find((x) => x.id === a)?.outcome).toBeNull();
    await run(ops, approvalDecide, { id: a, decision: "reject", outcome: "change_order" });
    const recent = await run<{ id: string; status: string; outcome: string | null }[]>(ops, approvalInbox, { include: "recent" });
    expect(recent.find((x) => x.id === a)).toMatchObject({ status: "rejected", outcome: "change_order" });
  });

  it("[APR-EN-13] absorb is refused over MCP (INV-19); change order and reject are allowed there", async () => {
    const a = await oosApproval();
    await expectCode(run(ops, approvalDecide, { id: a, decision: "approve" }, "mcp"), "DECIDE_IN_APP");
    await expectCode(run(ops, approvalDecide, { id: a, decision: "approve", outcome: "absorb" }, "mcp"), "DECIDE_IN_APP");
    await run(ops, approvalDecide, { id: a, decision: "reject", outcome: "change_order" }, "mcp");
    expect(await outcomeOf(a)).toEqual({ status: "rejected", outcome: "change_order" });
  });

  it("[APR-EN-13] the DB pins outcome to decided out-of-scope approvals with a matching status", async () => {
    const a = await oosApproval();
    // pending + outcome
    await expect(sql`UPDATE approvals SET outcome = 'absorb' WHERE id = ${a}`.execute(t.db)).rejects.toThrow(/approvals_outcome/);
    await run(ops, approvalDecide, { id: a, decision: "reject" });
    // rejected + absorb
    await expect(sql`UPDATE approvals SET outcome = 'absorb' WHERE id = ${a}`.execute(t.db)).rejects.toThrow(/approvals_outcome/);
    // another kind
    await expect(sql`UPDATE approvals SET kind = 'leave' WHERE id = ${a}`.execute(t.db)).rejects.toThrow();
  });
});
