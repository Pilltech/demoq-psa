import fc from "fast-check";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptedProject, createTestDb, line, makeUser, runAs, type AcceptedProject, type TestDb } from "@demoq/testkit";
import { approvalDecide } from "../approvals";
import { DomainError, type OpDef, type UserActor } from "../kernel";
import { scopeValue } from "./accept";
import {
  changeOrderAccept,
  changeOrderCreate,
  changeOrderGet,
  changeOrderList,
  changeOrderRateCard,
  changeOrderReject,
  changeOrderSave,
  changeOrderSend,
  changeOrderSubmit,
  changeOrderVoid,
} from "./change-orders";
import { rateCardItemUpsert, rateCardUpsert } from "./config";

let t: TestDb;
let lead: UserActor,
  otherLead: UserActor,
  ops: UserActor,
  pm: UserActor,
  otherPm: UserActor,
  finance: UserActor,
  staff: UserActor,
  admin: UserActor;

beforeAll(async () => {
  t = await createTestDb();
  lead = await makeUser(t.db, { roles: ["account_lead"], name: "Sokha Lead" });
  otherLead = await makeUser(t.db, { roles: ["account_lead"] });
  ops = await makeUser(t.db, { roles: ["ops_lead"], name: "Vanna Ops" });
  pm = await makeUser(t.db, { roles: ["project_manager"], name: "Piseth PM" });
  otherPm = await makeUser(t.db, { roles: ["project_manager"] });
  finance = await makeUser(t.db, { roles: ["finance"], name: "Sreymom Finance" });
  staff = await makeUser(t.db, { roles: ["staff"] });
  admin = await makeUser(t.db, { roles: ["admin"] });
});
afterAll(() => t.destroy());

const run = <T>(a: UserActor, op: OpDef, input: unknown) => runAs<T>(t, a, op, input);
const expectCode = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);

type Co = { id: string; version: number; status?: string; approvalId?: string | null };
async function draftCo(
  p: AcceptedProject,
  a: UserActor = lead,
  lines: unknown[] = [line("fee", 2, 10_000, 5_000, { quotedMinutes: 240 })],
) {
  const c = await run<Co>(a, changeOrderCreate, { projectId: p.projectId, title: "Extra posts" });
  const s = await run<Co>(a, changeOrderSave, { id: c.id, expectedVersion: c.version, lines });
  return { id: c.id, version: s.version };
}
async function sentCo(p: AcceptedProject, lines?: unknown[]) {
  const d = await draftCo(p, lead, lines);
  const s = await run<Co>(lead, changeOrderSubmit, { id: d.id, expectedVersion: d.version });
  expect(s.status).toBe("ready");
  const sent = await run<Co>(lead, changeOrderSend, { id: d.id, expectedVersion: s.version });
  return { id: d.id, version: sent.version };
}

describe("commercial/change-orders", () => {
  it("[COM-CO-01] lines are additive only: a reduction is refused, also by the DB", async () => {
    const p = await acceptedProject(t, lead);
    const c = await run<Co>(lead, changeOrderCreate, { projectId: p.projectId, title: "Fewer posts" });
    await expectCode(
      run(lead, changeOrderSave, { id: c.id, expectedVersion: c.version, lines: [line("fee", -1, 10_000, 5_000)] }),
      "CHANGE_ORDER_NOT_ADDITIVE",
    );
    await expectCode(
      run(lead, changeOrderSave, { id: c.id, expectedVersion: c.version, lines: [line("fee", 1, -10_000, 5_000)] }),
      "CHANGE_ORDER_NOT_ADDITIVE",
    );
    await expect(
      sql`INSERT INTO change_order_lines (change_order_id, position, kind, description_en, qty_milli, unit_price_minor, unit_cost_minor, line_price_minor, line_cost_minor)
          VALUES (${c.id}, 0, 'fee', 'x', -1000, 100, 0, 0, 0)`.execute(t.db),
    ).rejects.toThrow(/change_order_lines_additive_qty/);
    // A project without scope (internal) cannot take a CO.
    await expectCode(run(ops, changeOrderCreate, { projectId: (await internalProject()).id, title: "x" }), "VALIDATION");
  });

  it("[COM-CO-02] below the floor on its own lines → margin_review + margin_floor approval bound to the hash; send needs it", async () => {
    const p = await acceptedProject(t, lead);
    const d = await draftCo(p, lead, [line("fee", 1, 10_000, 8_000)]); // 20% < 25% campaign floor (within step-up gap)
    const s = await run<Co>(lead, changeOrderSubmit, { id: d.id, expectedVersion: d.version });
    expect(s.status).toBe("margin_review");
    const a = await t.db.selectFrom("approvals").selectAll().where("id", "=", s.approvalId!).executeTakeFirstOrThrow();
    const co = await t.db.selectFrom("change_orders").select("content_sha256").where("id", "=", d.id).executeTakeFirstOrThrow();
    expect(a).toMatchObject({
      kind: "margin_floor",
      subject_type: "change_order",
      subject_id: d.id,
      subject_hash: co.content_sha256,
    });
    await expectCode(run(lead, changeOrderSend, { id: d.id, expectedVersion: s.version }), "INVALID_TRANSITION");
    // The DB backstop refuses a direct send too.
    await expect(sql`UPDATE change_orders SET status = 'sent' WHERE id = ${d.id}`.execute(t.db)).rejects.toThrow(/QUOTE_LOCKED/);
    await sql`UPDATE change_orders SET status = 'ready' WHERE id = ${d.id}`.execute(t.db);
    await expect(sql`UPDATE change_orders SET status = 'sent' WHERE id = ${d.id}`.execute(t.db)).rejects.toThrow(
      /MARGIN_BELOW_FLOOR/,
    );
    await sql`UPDATE change_orders SET status = 'margin_review' WHERE id = ${d.id}`.execute(t.db);
    await run(finance, approvalDecide, { id: a.id, decision: "approve" });
    const ready = await run<{ status: string; version: number }>(lead, changeOrderGet, { id: d.id });
    expect(ready.status).toBe("ready");
    const sent = await run<Co>(lead, changeOrderSend, { id: d.id, expectedVersion: ready.version });
    expect(sent.status).toBe("sent");
  });

  it("[COM-CO-03] states: draft → ready → sent → accepted/rejected; void before sending; sent COs are locked; retainer COs target a period", async () => {
    const p = await acceptedProject(t, lead);
    const s = await sentCo(p);
    await expectCode(run(lead, changeOrderSave, { id: s.id, expectedVersion: s.version, title: "Changed" }), "QUOTE_LOCKED");
    await expectCode(run(lead, changeOrderVoid, { id: s.id, expectedVersion: s.version }), "INVALID_TRANSITION");
    await expect(sql`UPDATE change_orders SET total_minor = 1 WHERE id = ${s.id}`.execute(t.db)).rejects.toThrow(/QUOTE_LOCKED/);
    await expect(sql`DELETE FROM change_order_lines WHERE change_order_id = ${s.id}`.execute(t.db)).rejects.toThrow(
      /QUOTE_LOCKED/,
    );
    const rej = await run<Co>(lead, changeOrderReject, { id: s.id, expectedVersion: s.version });
    expect(rej.status).toBe("rejected");
    await expectCode(run(lead, changeOrderAccept, { id: s.id, expectedVersion: rej.version }), "INVALID_TRANSITION");
    const d = await draftCo(p);
    expect((await run<Co>(lead, changeOrderVoid, { id: d.id, expectedVersion: d.version })).status).toBe("void");

    const r = await acceptedProject(t, lead, {
      billingModel: "retainer",
      periodMonths: 3,
      lines: [line("fee", 1, 200_000, 100_000, { perPeriod: true })],
    });
    await expectCode(run(lead, changeOrderCreate, { projectId: r.projectId, title: "More" }), "VALIDATION");
    const period = await t.db
      .selectFrom("scope_periods")
      .select("id")
      .where("scope_id", "=", r.scopeId)
      .executeTakeFirstOrThrow();
    const c = await run<Co>(lead, changeOrderCreate, { projectId: r.projectId, title: "More", scopePeriodId: period.id });
    expect(c.id).toBeTruthy();
  });

  it("[COM-CO-04] accepting appends scope items (existing ones untouched) and one task per fee line: PM, quoted minutes else 60, due +7 days", async () => {
    const p = await acceptedProject(t, lead, { pmId: pm.id });
    const before = await t.db
      .selectFrom("scope_items")
      .selectAll()
      .where("scope_id", "=", p.scopeId)
      .orderBy("created_at")
      .execute();
    const s = await sentCo(p, [
      line("fee", 2, 10_000, 5_000, { quotedMinutes: 240, descriptionEn: "Two extra reels" }),
      line("fee", 1, 8_000, 4_000, { descriptionEn: "Extra story" }),
      line("pass_through", 1, 11_000, 10_000, { descriptionEn: "Boost budget" }),
    ]);
    const r = await run<{ status: string; scopeItems: number; tasksCreated: number }>(lead, changeOrderAccept, {
      id: s.id,
      expectedVersion: s.version,
    });
    expect(r).toMatchObject({ status: "accepted", scopeItems: 3, tasksCreated: 2 });
    const after = await t.db
      .selectFrom("scope_items")
      .selectAll()
      .where("scope_id", "=", p.scopeId)
      .orderBy("created_at")
      .execute();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).map((i) => [i.source_type, i.source_id, i.description_en])).toEqual([
      ["change_order", s.id, "Two extra reels"],
      ["change_order", s.id, "Extra story"],
      ["change_order", s.id, "Boost budget"],
    ]);
    const tasks = await t.db
      .selectFrom("tasks")
      .selectAll()
      .where("project_id", "=", p.projectId)
      .where("estimate_source", "=", "change_order")
      .orderBy("title")
      .execute();
    expect(tasks.map((x) => [x.title, x.owner_id, x.estimate_minutes, x.due_date])).toEqual([
      ["Extra story", pm.id, 60, "2026-10-26"],
      ["Two extra reels", pm.id, 240, "2026-10-26"],
    ]);
    expect(tasks.every((x) => x.scope_item_id && after.some((i) => i.id === x.scope_item_id))).toBe(true);
  });

  it("[COM-CO-05] scope value = quote + accepted COs and never decreases over any sequence of CO actions (property)", async () => {
    const p = await acceptedProject(t, lead);
    const ctx = { tx: t.db } as never;
    const actions = fc.array(
      fc.record({
        act: fc.constantFrom("accept", "reject", "void", "leave"),
        qty: fc.integer({ min: 1, max: 5 }),
        price: fc.integer({ min: 1, max: 50_000 }), // a zero-priced fee line is below any floor
      }),
      {
        minLength: 1,
        maxLength: 6,
      },
    );
    await fc.assert(
      fc.asyncProperty(actions, async (seq) => {
        let last = await scopeValue(ctx, p.scopeId);
        let expected = last;
        for (const a of seq) {
          const lines = [line("fee", a.qty, a.price, 0)];
          if (a.act === "void") {
            const d = await draftCo(p, lead, lines);
            await run(lead, changeOrderVoid, { id: d.id, expectedVersion: d.version });
          } else {
            const s = await sentCo(p, lines);
            if (a.act === "accept") {
              await run(lead, changeOrderAccept, { id: s.id, expectedVersion: s.version });
              expected += BigInt(a.qty * a.price);
            } else if (a.act === "reject") await run(lead, changeOrderReject, { id: s.id, expectedVersion: s.version });
          }
          const now = await scopeValue(ctx, p.scopeId);
          expect(now).toBeGreaterThanOrEqual(last);
          last = now;
        }
        expect(last).toBe(expected);
      }),
      { numRuns: 8 },
    );
    const q = await t.db.selectFrom("quotes").select("total_minor").where("id", "=", p.id).executeTakeFirstOrThrow();
    const cos = await t.db
      .selectFrom("change_orders")
      .select((eb) => eb.fn.coalesce(eb.fn.sum<string>("total_minor"), eb.val("0")).as("v"))
      .where("project_id", "=", p.projectId)
      .where("status", "=", "accepted")
      .executeTakeFirstOrThrow();
    expect(await scopeValue(ctx, p.scopeId)).toBe(q.total_minor + BigInt(cos.v));
  });

  it("[COM-CO-06] managed by the account lead (own), the project's PM (assigned) or ops; others refused; costs hidden from the PM", async () => {
    const p = await acceptedProject(t, lead, { pmId: pm.id });
    for (const a of [otherLead, otherPm, staff, admin])
      await expectCode(run(a, changeOrderCreate, { projectId: p.projectId, title: "x" }), "FORBIDDEN");
    const byOps = await run<Co>(ops, changeOrderCreate, { projectId: p.projectId, title: "Ops CO" });
    const c = await run<Co>(pm, changeOrderCreate, { projectId: p.projectId, title: "PM CO" });
    // D-CO-2: without cost visibility, the PM adds only rate-card lines at the card's cost.
    await expectCode(
      run(pm, changeOrderSave, { id: c.id, expectedVersion: c.version, lines: [line("fee", 1, 10_000, 1)] }),
      "FORBIDDEN",
    );
    const card = await run<{ id: string }>(admin, rateCardUpsert, { name: `CO card ${Date.now()}`, currency: "USD" });
    const item = await run<{ id: string }>(admin, rateCardItemUpsert, {
      rateCardId: card.id,
      kind: "fee",
      serviceCode: "REEL",
      labelEn: "Reel",
      labelKm: "KM-DRAFT: Reel",
      unit: "item",
      unitPriceMinor: "30000",
      unitCostMinor: "12000",
    });
    const cardProject = await acceptedProject(t, lead, { pmId: pm.id, rateCardId: card.id });
    const c2 = await run<Co>(pm, changeOrderCreate, { projectId: cardProject.projectId, title: "PM CO" });
    const { unitCostMinor: _omit, ...noCost } = line("fee", 1, 30_000, 0);
    const saved = await run<Co>(pm, changeOrderSave, {
      id: c2.id,
      expectedVersion: c2.version,
      lines: [{ ...noCost, rateCardItemId: item.id }],
    });
    const asPm = await run<{ costs: unknown; lines: { unitCostMinor: string | null; rateCardItemId: string | null }[] }>(
      pm,
      changeOrderGet,
      {
        id: c2.id,
      },
    );
    expect(asPm.costs).toBeNull();
    expect(asPm.lines[0]!).toMatchObject({ unitCostMinor: null, rateCardItemId: item.id });
    // The PM can pick from the project's rate card (prices, no costs); the lead sees costs; others are refused.
    const cardForPm = await run<{
      rateCardId: string;
      items: { id: string; unit_price_minor: string; unit_cost_minor: string | null }[];
    }>(pm, changeOrderRateCard, { projectId: cardProject.projectId });
    expect(cardForPm.rateCardId).toBe(card.id);
    expect(cardForPm.items).toEqual([expect.objectContaining({ id: item.id, unit_price_minor: "30000", unit_cost_minor: null })]);
    const cardForLead = await run<{ items: { unit_cost_minor: string | null }[] }>(lead, changeOrderRateCard, {
      projectId: cardProject.projectId,
    });
    expect(cardForLead.items[0]!.unit_cost_minor).toBe("12000");
    await expectCode(run(otherPm, changeOrderRateCard, { projectId: cardProject.projectId }), "FORBIDDEN");
    const asLead = await run<{ costs: { feeMarginBp: number } }>(lead, changeOrderGet, { id: c2.id });
    expect(asLead.costs.feeMarginBp).toBe(6000);
    const list = await run<{ costs: unknown; status: string }[]>(pm, changeOrderList, { projectId: cardProject.projectId });
    expect(list.every((x) => x.costs === null)).toBe(true);
    const ev = await t.db
      .selectFrom("audit_events")
      .select(["actor_name"])
      .where("action", "=", "change_order.create")
      .where("subject_id", "=", byOps.id)
      .executeTakeFirstOrThrow();
    expect(ev.actor_name).toBe("Vanna Ops");
    expect(saved.version).toBeGreaterThan(c2.version);
  });
});

async function internalProject() {
  const pt = (await t.db.selectFrom("project_types").select("id").where("code", "=", "campaign").executeTakeFirstOrThrow()).id;
  return t.migrator
    .insertInto("projects")
    .values({
      kind: "internal",
      name: "Internal",
      project_type_id: pt,
      planned_start: "2026-10-19",
      pm_id: ops.id,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
}
