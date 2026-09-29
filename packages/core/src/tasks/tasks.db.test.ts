import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptedProject,
  createTestDb,
  line,
  makeTeam,
  makeUser,
  runAs,
  type AcceptedProject,
  type TestDb,
} from "@demoq/testkit";
import { approvalDecide } from "../approvals";
import { DomainError, type OpDef, type UserActor } from "../kernel";
import { gateSatisfy } from "../projects";
import { taskBoard, taskCancel, taskCreate, taskGet, taskMine, taskMove, taskSetDependency, taskUpdate } from "./tasks";

let t: TestDb;
let lead: UserActor,
  pm: UserActor,
  otherPm: UserActor,
  teamLead: UserActor,
  designer: UserActor,
  outsider: UserActor,
  ops: UserActor;

beforeAll(async () => {
  t = await createTestDb();
  const team = await makeTeam(t.db, "Design");
  const other = await makeTeam(t.db, "Video");
  lead = await makeUser(t.db, { roles: ["account_lead"], name: "Sokha Lead" });
  pm = await makeUser(t.db, { roles: ["project_manager"], name: "Piseth PM" });
  otherPm = await makeUser(t.db, { roles: ["project_manager"] });
  teamLead = await makeUser(t.db, { roles: ["team_lead"], teamId: team.id, name: "Rith Lead" });
  designer = await makeUser(t.db, { roles: ["staff"], teamId: team.id, name: "Designer" });
  outsider = await makeUser(t.db, { roles: ["staff"], teamId: other.id });
  ops = await makeUser(t.db, { roles: ["ops_lead"] });
});
afterAll(() => t.destroy());

const run = <T>(a: UserActor, op: OpDef, input: unknown, channel?: "web" | "mcp") => runAs<T>(t, a, op, input, channel);
const expectCode = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);

type Task = { id: string; version: number; status: string; oosApprovalId?: string | null; oos_status?: string };
const project = () => acceptedProject(t, lead, { pmId: pm.id });
async function openProject() {
  const p = await project();
  for (const gate of ["contract", "purchase_order", "deposit_terms"])
    await run(pm, gateSatisfy, { projectId: p.projectId, gate, evidence: `REF-${gate}` });
  return p;
}
const scopeItem = async (p: AcceptedProject) =>
  (
    await t.db
      .selectFrom("scope_items")
      .select("id")
      .where("scope_id", "=", p.scopeId)
      .orderBy("created_at")
      .executeTakeFirstOrThrow()
  ).id;
const newTask = async (p: AcceptedProject, extra: Record<string, unknown> = {}) =>
  run<Task>(pm, taskCreate, {
    projectId: p.projectId,
    title: "Design key visual",
    ownerId: designer.id,
    estimateMinutes: 240,
    dueDate: "2026-11-05",
    scopeItemId: await scopeItem(p),
    ...extra,
  });
const baseInput = async (p: AcceptedProject) => ({
  projectId: p.projectId,
  title: "Design key visual",
  ownerId: designer.id,
  estimateMinutes: 240,
  dueDate: "2026-11-05",
  scopeItemId: await scopeItem(p),
});
const version = async (id: string) =>
  (await t.db.selectFrom("tasks").select("version").where("id", "=", id).executeTakeFirstOrThrow()).version;

describe("tasks/tasks", () => {
  it("[TSK-TK-01] a task always has one active owner, an estimate and a due date", async () => {
    const p = await project();
    await expect(
      run(pm, taskCreate, {
        projectId: p.projectId,
        title: "No owner",
        estimateMinutes: 60,
        dueDate: "2026-11-05",
        nonDeliverable: true,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DomainError && e.code === "TASK_INCOMPLETE" && JSON.stringify(e.params.missing) === '["ownerId"]',
    );
    await expectCode(
      run(pm, taskCreate, { projectId: p.projectId, title: "x", ownerId: designer.id, nonDeliverable: true }),
      "TASK_INCOMPLETE",
    );
    const gone = await makeUser(t.db, { roles: ["staff"] });
    await t.migrator.updateTable("users").set({ active: false }).where("id", "=", gone.id).execute();
    await expectCode(
      run(pm, taskCreate, {
        projectId: p.projectId,
        title: "x",
        ownerId: gone.id,
        estimateMinutes: 60,
        dueDate: "2026-11-05",
        nonDeliverable: true,
      }),
      "TASK_INCOMPLETE",
    );
    await expect(sql`UPDATE tasks SET estimate_minutes = 0 WHERE project_id = ${p.projectId}`.execute(t.db)).rejects.toThrow(
      /check/i,
    );
    await expect(sql`UPDATE tasks SET due_date = NULL WHERE project_id = ${p.projectId}`.execute(t.db)).rejects.toThrow(/null/i);
    const ok = await newTask(p);
    expect(ok.status).toBe("todo");
  });

  it("[TSK-TK-02] client tasks link a scope item, are non-deliverable, or ask out-of-scope (approval; cannot start until granted)", async () => {
    const p = await openProject();
    await expectCode(
      run(pm, taskCreate, {
        projectId: p.projectId,
        title: "Free extra",
        ownerId: designer.id,
        estimateMinutes: 60,
        dueDate: "2026-11-05",
      }),
      "OUT_OF_SCOPE_REQUIRED",
    );
    const other = await project();
    await expectCode(newTask(p, { scopeItemId: await scopeItem(other) }), "VALIDATION");
    const oos = await run<Task>(pm, taskCreate, {
      projectId: p.projectId,
      title: "Extra banner",
      ownerId: designer.id,
      estimateMinutes: 90,
      dueDate: "2026-11-05",
      outOfScopeReason: "Client asked for one more banner during the call",
    });
    expect(oos).toMatchObject({ status: "todo", oos_status: "pending" });
    const a = await t.db.selectFrom("approvals").selectAll().where("id", "=", oos.oosApprovalId!).executeTakeFirstOrThrow();
    expect(a).toMatchObject({
      kind: "out_of_scope",
      subject_type: "task",
      subject_id: oos.id,
      required_permission: "scope.oos.decide",
    });
    await expectCode(
      run(designer, taskMove, { id: oos.id, expectedVersion: oos.version, to: "in_progress" }),
      "OUT_OF_SCOPE_REQUIRED",
    );
    await expect(sql`UPDATE tasks SET status = 'in_progress' WHERE id = ${oos.id}`.execute(t.db)).rejects.toThrow(
      /tasks_scope_link|OUT_OF_SCOPE/,
    );
    await expect(
      sql`INSERT INTO tasks (project_id, title, owner_id, estimate_minutes, due_date) VALUES (${p.projectId}, 'Sneaky', ${designer.id}, 60, '2026-11-05')`.execute(
        t.db,
      ),
    ).rejects.toThrow(/tasks_scope_link|OUT_OF_SCOPE/);
    await run(lead, approvalDecide, { id: a.id, decision: "approve" }); // the client's account lead (own)
    const started = await run<Task>(designer, taskMove, {
      id: oos.id,
      expectedVersion: await version(oos.id),
      to: "in_progress",
    });
    expect(started.status).toBe("in_progress");
    const nd = await newTask(p, { scopeItemId: null, nonDeliverable: true, title: "Internal review" });
    expect(nd.status).toBe("todo");
  });

  it("[TSK-TK-02] INV-20: a non-deliverable task is never client-facing (create, update, DB CHECK as the app role)", async () => {
    const p = await openProject();
    const unscopedDeliverable = { scopeItemId: null, nonDeliverable: true, clientFacing: true, title: "Unscoped deliverable" };
    await expect(newTask(p, unscopedDeliverable)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DomainError && e.code === "OUT_OF_SCOPE_REQUIRED" && e.params.reason === "client_facing_non_deliverable",
    );
    // The same on MCP, and even with an out-of-scope reason (the reason asks for the approval, it never skips it).
    await expectCode(
      run(pm, taskCreate, { ...(await baseInput(p)), ...unscopedDeliverable, outOfScopeReason: "Asked on the call" }, "mcp"),
      "OUT_OF_SCOPE_REQUIRED",
    );
    const internal = await newTask(p, { scopeItemId: null, nonDeliverable: true, title: "Internal review" });
    await expectCode(
      run(pm, taskUpdate, { id: internal.id, expectedVersion: await version(internal.id), clientFacing: true }),
      "OUT_OF_SCOPE_REQUIRED",
    );
    const linked = await newTask(p, { clientFacing: true, title: "Linked deliverable" });
    await expectCode(
      run(pm, taskUpdate, { id: linked.id, expectedVersion: await version(linked.id), scopeItemId: null, nonDeliverable: true }),
      "OUT_OF_SCOPE_REQUIRED",
    );
    // DB backstop: the combination cannot be stored, whatever the app does.
    await expect(
      sql`UPDATE tasks SET scope_item_id = NULL, non_deliverable = true WHERE id = ${linked.id}`.execute(t.db),
    ).rejects.toThrow(/tasks_non_deliverable_internal/);
    await expect(sql`UPDATE tasks SET client_facing = true WHERE id = ${internal.id}`.execute(t.db)).rejects.toThrow(
      /tasks_non_deliverable_internal/,
    );
  });

  it("[TSK-TK-08] a task linked to a scope item may be made client-facing (over quantity asks out-of-scope), before delivery", async () => {
    const p = await acceptedProject(t, lead, { pmId: pm.id, lines: [line("fee", 1, 5000, 3000, { quotedMinutes: 600 })] });
    for (const gate of ["contract", "purchase_order", "deposit_terms"])
      await run(pm, gateSatisfy, { projectId: p.projectId, gate, evidence: `REF-${gate}` });
    const tpl = await t.db
      .selectFrom("tasks")
      .select(["id", "version", "client_facing", "non_deliverable"])
      .where("project_id", "=", p.projectId)
      .where("title", "=", "Creative concept")
      .executeTakeFirstOrThrow();
    expect(tpl).toMatchObject({ client_facing: false, non_deliverable: true }); // TSK-TP-02: no matching scope item
    const item = await scopeItem(p);
    const made = await run<{ version: number }>(pm, taskUpdate, {
      id: tpl.id,
      expectedVersion: tpl.version,
      scopeItemId: item,
      clientFacing: true,
    });
    expect(await t.db.selectFrom("tasks").selectAll().where("id", "=", tpl.id).executeTakeFirstOrThrow()).toMatchObject({
      scope_item_id: item,
      non_deliverable: false,
      client_facing: true,
      oos_status: "none",
    });
    // The item (quantity 1) is now used: making another linked task client-facing asks out-of-scope.
    const other = await newTask(p, { title: "Second visual" });
    await expectCode(
      run(pm, taskUpdate, { id: other.id, expectedVersion: await version(other.id), clientFacing: true }),
      "OUT_OF_SCOPE_REQUIRED",
    );
    const asked = await run<{ version: number }>(pm, taskUpdate, {
      id: other.id,
      expectedVersion: await version(other.id),
      clientFacing: true,
      outOfScopeReason: "The client asked for a variant",
    });
    expect(asked.version).toBeGreaterThan(other.version);
    expect(
      (await t.db.selectFrom("tasks").select("oos_status").where("id", "=", other.id).executeTakeFirstOrThrow()).oos_status,
    ).toBe("pending");
    // Not once delivery has started: review states belong to the delivery flow.
    await t.migrator.updateTable("tasks").set({ status: "internal_review" }).where("id", "=", tpl.id).execute();
    await expectCode(
      run(pm, taskUpdate, { id: tpl.id, expectedVersion: made.version, clientFacing: false }),
      "INVALID_TRANSITION",
    );
  });

  it("[TSK-TK-03] todo → in_progress → done; in_progress → todo; open → cancelled; nothing else", async () => {
    const p = await openProject();
    const x = await newTask(p);
    await expectCode(run(designer, taskMove, { id: x.id, expectedVersion: x.version, to: "done" }), "INVALID_TRANSITION");
    const s = await run<Task>(designer, taskMove, { id: x.id, expectedVersion: x.version, to: "in_progress" });
    const back = await run<Task>(designer, taskMove, { id: x.id, expectedVersion: s.version, to: "todo" });
    const s2 = await run<Task>(designer, taskMove, { id: x.id, expectedVersion: back.version, to: "in_progress" });
    const d = await run<Task>(designer, taskMove, { id: x.id, expectedVersion: s2.version, to: "done" });
    expect(d.status).toBe("done");
    await expectCode(run(designer, taskMove, { id: x.id, expectedVersion: d.version, to: "todo" }), "INVALID_TRANSITION");
    await expectCode(run(pm, taskCancel, { id: x.id, expectedVersion: d.version }), "INVALID_TRANSITION");
    const y = await newTask(p);
    expect((await run<Task>(pm, taskCancel, { id: y.id, expectedVersion: y.version })).status).toBe("cancelled");
    await expectCode(run(designer, taskMove, { id: x.id, expectedVersion: 1, to: "todo" }), "STALE_VERSION");
  });

  it("[TSK-TK-04] starting needs the project's gates and every dependency done", async () => {
    const gated = await project();
    const g = await newTask(gated);
    await expectCode(run(designer, taskMove, { id: g.id, expectedVersion: g.version, to: "in_progress" }), "GATE_BLOCKED");
    const p = await openProject();
    const first = await newTask(p, { title: "Brief" });
    const second = await newTask(p, { title: "Design", dependsOn: [first.id] });
    await expect(
      run(designer, taskMove, { id: second.id, expectedVersion: await version(second.id), to: "in_progress" }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DomainError && e.code === "DEPENDENCY_OPEN" && JSON.stringify(e.params.openDependencies) === '["Brief"]',
    );
    const s = await run<Task>(designer, taskMove, { id: first.id, expectedVersion: first.version, to: "in_progress" });
    await run(designer, taskMove, { id: first.id, expectedVersion: s.version, to: "done" });
    expect(
      (await run<Task>(designer, taskMove, { id: second.id, expectedVersion: await version(second.id), to: "in_progress" }))
        .status,
    ).toBe("in_progress");
  });

  it("[TSK-TK-05] dependencies stay in one project and never form a cycle; a task cannot depend on itself", async () => {
    const p = await project();
    const a = await newTask(p, { title: "A" });
    const b = await newTask(p, { title: "B", dependsOn: [a.id] });
    const c = await newTask(p, { title: "C", dependsOn: [b.id] });
    await expectCode(run(pm, taskSetDependency, { taskId: a.id, dependsOnId: c.id }), "DEPENDENCY_CYCLE");
    await expectCode(run(pm, taskSetDependency, { taskId: a.id, dependsOnId: a.id }), "DEPENDENCY_CYCLE");
    await expect(
      sql`INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (${a.id}, ${a.id})`.execute(t.db),
    ).rejects.toThrow(/task_dependencies_not_self/);
    const q = await project();
    const foreign = await newTask(q);
    await expectCode(run(pm, taskSetDependency, { taskId: a.id, dependsOnId: foreign.id }), "VALIDATION");
    await run(pm, taskSetDependency, { taskId: c.id, dependsOnId: b.id, remove: true });
    await run(pm, taskSetDependency, { taskId: a.id, dependsOnId: c.id }); // no longer a cycle
    expect((await run<{ dependsOn: string[] }>(pm, taskGet, { id: a.id })).dependsOn).toEqual([c.id]);
  });

  it("[TSK-TK-06] the PM (assigned) or the owner's team lead manages tasks; the owner moves their own; others are refused", async () => {
    const p = await openProject();
    const x = await newTask(p);
    for (const a of [otherPm, outsider, lead, ops]) {
      await expectCode(run(a, taskUpdate, { id: x.id, expectedVersion: x.version, title: "Hijack" }), "FORBIDDEN");
    }
    const u = await run<Task>(teamLead, taskUpdate, { id: x.id, expectedVersion: x.version, estimateMinutes: 300 });
    // A team lead cannot hand the task to someone outside their team.
    await expectCode(run(teamLead, taskUpdate, { id: x.id, expectedVersion: u.version, ownerId: outsider.id }), "FORBIDDEN");
    await expectCode(run(pm, taskMove, { id: x.id, expectedVersion: u.version, to: "in_progress" }), "FORBIDDEN"); // not the owner
    await expectCode(run(outsider, taskMove, { id: x.id, expectedVersion: u.version, to: "in_progress" }), "FORBIDDEN");
    await run(designer, taskMove, { id: x.id, expectedVersion: u.version, to: "in_progress" });
    await expectCode(run(designer, taskCancel, { id: x.id, expectedVersion: await version(x.id) }), "FORBIDDEN");
    const r = await run<{ owner_id: string }>(pm, taskUpdate, {
      id: x.id,
      expectedVersion: await version(x.id),
      ownerId: outsider.id,
    });
    expect(r.owner_id).toBe(outsider.id);
  });

  it("[TSK-TK-07] Kanban per project and per person; every task change is audited", async () => {
    const p = await openProject();
    const x = await newTask(p, { title: "Board task" });
    await run(designer, taskMove, { id: x.id, expectedVersion: x.version, to: "in_progress" });
    const board = await run<{ tasks: { id: string; status: string; canMove: boolean }[]; canManage: boolean }>(
      designer,
      taskBoard,
      { projectId: p.projectId },
    );
    expect(board.canManage).toBe(false);
    expect(board.tasks.find((y) => y.id === x.id)).toMatchObject({ status: "in_progress", canMove: true });
    expect(board.tasks.filter((y) => y.status === "todo").length).toBeGreaterThan(0); // template tasks
    expect((await run<{ canManage: boolean }>(pm, taskBoard, { projectId: p.projectId })).canManage).toBe(true);
    const mine = await run<{ id: string; project_name: string }[]>(designer, taskMine, {});
    expect(mine.map((y) => y.id)).toContain(x.id);
    expect(mine.every((y) => y.project_name)).toBe(true);
    const viaMcp = await run<{ id: string }[]>(designer, taskMine, {}, "mcp");
    expect(viaMcp.length).toBe(mine.length);
    const audit = await t.db
      .selectFrom("audit_events")
      .select(["action", "actor_name"])
      .where("subject_id", "=", x.id)
      .orderBy("id")
      .execute();
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["task.create", "task.move"]));
    const rows = await t.db
      .selectFrom("audit_changes")
      .select("op")
      .where("table_name", "=", "tasks")
      .where("row_id", "=", x.id)
      .orderBy("id")
      .execute();
    expect(rows.map((r) => r.op)).toEqual(["INSERT", "UPDATE"]);
  });
});
