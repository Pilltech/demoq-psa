import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { acceptedProject, createTestDb, line, makeUser, projectTypeId, runAs, sentQuote, type TestDb } from "@demoq/testkit";
import { DomainError, type Ctx, type OpDef, type UserActor } from "../kernel";
import { projectSetMember } from "../projects";
import { applyTemplate, templateList, templateSave } from "../tasks";
import { quoteAccept, scopeGet } from "./accept";
import { rateCardItemUpsert, rateCardUpsert } from "./config";
import { retainerTick } from "./retainers";

let t: TestDb;
let lead: UserActor, otherLead: UserActor, ops: UserActor, pm: UserActor, admin: UserActor, staff: UserActor;
const job = { type: "job" as const, name: "test-job", grants: ["project.jobs" as const] };

beforeAll(async () => {
  t = await createTestDb();
  lead = await makeUser(t.db, { roles: ["account_lead"], name: "Sokha Lead" });
  otherLead = await makeUser(t.db, { roles: ["account_lead"], name: "Dara Lead" });
  ops = await makeUser(t.db, { roles: ["ops_lead"], name: "Vanna Ops" });
  pm = await makeUser(t.db, { roles: ["project_manager"], name: "Piseth PM" });
  admin = await makeUser(t.db, { roles: ["admin"] });
  staff = await makeUser(t.db, { roles: ["staff"] });
});
afterAll(() => t.destroy());
afterEach(() => t.clock.set("2026-10-19T02:00:00Z"));

const run = <T>(a: UserActor | typeof job, op: OpDef, input: unknown) => runAs<T>(t, a, op, input);
const expectCode = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
const accept = (a: UserActor, q: { id: string; version: number }, extra: Record<string, unknown> = {}) =>
  run<{ projectId: string; scopeId: string; tasksCreated: number; status: string }>(a, quoteAccept, {
    id: q.id,
    expectedVersion: q.version,
    winReasonCode: "creative",
    plannedStart: "2026-11-02",
    ...extra,
  });

describe("commercial/accept-scope", () => {
  it("[COM-AC-01] accept needs a sent quote, an active win reason and a planned start", async () => {
    const q = await sentQuote(t, lead);
    await expectCode(accept(lead, q, { winReasonCode: null }), "WIN_REASON_REQUIRED");
    await expectCode(accept(lead, q, { winReasonCode: "competitor" }), "CLOSE_REASON_INVALID"); // a lost reason
    await expectCode(accept(lead, q, { winReasonCode: "nope" }), "CLOSE_REASON_INVALID");
    await expect(accept(lead, q, { plannedStart: undefined })).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainError && e.code === "VALIDATION",
    );
    const r = await accept(lead, q);
    expect(r.status).toBe("accepted");
    await expectCode(accept(lead, { id: q.id, version: q.version + 1 }), "INVALID_TRANSITION");
  });

  it("[COM-AC-02] one transaction: quote accepted, other open versions superseded, deal Won with the reason in history", async () => {
    const q = await sentQuote(t, lead);
    // Another draft version on the same deal.
    const draft = await t.db
      .insertInto("quotes")
      .values({
        deal_id: q.dealId,
        client_id: q.clientId,
        owner_id: lead.id,
        engagement_type_id: (
          await t.db.selectFrom("quotes").select("engagement_type_id").where("id", "=", q.id).executeTakeFirstOrThrow()
        ).engagement_type_id,
        version_no: 9,
        title: "Alt",
        currency: "USD",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await accept(lead, q, { note: "Signed at the meeting" });
    const quotes = await t.db
      .selectFrom("quotes")
      .select(["id", "status", "win_reason_code"])
      .where("deal_id", "=", q.dealId)
      .execute();
    expect(quotes.find((x) => x.id === q.id)).toMatchObject({ status: "accepted", win_reason_code: "creative" });
    expect(quotes.find((x) => x.id === draft.id)?.status).toBe("superseded");
    const deal = await t.db.selectFrom("deals").selectAll().where("id", "=", q.dealId).executeTakeFirstOrThrow();
    expect(deal).toMatchObject({
      stage: "won",
      close_reason_code: "creative",
      close_reason_kind: "won",
      close_note: "Signed at the meeting",
    });
    const h = await t.db
      .selectFrom("deal_stage_history")
      .selectAll()
      .where("deal_id", "=", q.dealId)
      .where("to_stage", "=", "won")
      .executeTakeFirstOrThrow();
    expect(h).toMatchObject({ close_reason_code: "creative", changed_by: lead.id });
    // Accepted is final: the DB refuses any move away from it.
    await expect(sql`UPDATE quotes SET status = 'sent' WHERE id = ${q.id}`.execute(t.db)).rejects.toThrow(/QUOTE_LOCKED/);
  });

  it("[COM-AC-03] the quote becomes the scope: one insert-only item per line with qty, price and quoted minutes", async () => {
    const p = await acceptedProject(t, lead);
    const s = await run<{
      valueMinor: string;
      items: { kind: string; qty_milli: number; line_price_minor: string; quoted_minutes: number | null; source_type: string }[];
    }>(staff, scopeGet, { projectId: p.projectId });
    expect(s.items).toHaveLength(2);
    expect(s.items[0]).toMatchObject({
      kind: "fee",
      qty_milli: 10_000,
      line_price_minor: "50000",
      quoted_minutes: 600,
      source_type: "quote",
    });
    expect(s.items[1]).toMatchObject({ kind: "pass_through", line_price_minor: "110000" });
    expect(s.valueMinor).toBe("160000");
  });

  it("[COM-AC-04] a gated client project with five gates; scope and quote satisfied by the acceptance; PM defaults to the quote owner", async () => {
    const p = await acceptedProject(t, lead);
    const proj = await t.db.selectFrom("projects").selectAll().where("id", "=", p.projectId).executeTakeFirstOrThrow();
    expect(proj).toMatchObject({
      kind: "client",
      status: "gated",
      pm_id: lead.id,
      planned_start: "2026-11-02",
      client_id: p.clientId,
      deal_id: p.dealId,
    });
    expect(proj.project_type_id).toBe(await projectTypeId(t, "campaign"));
    const gates = await t.db
      .selectFrom("project_gates")
      .select(["gate", "status", "evidence"])
      .where("project_id", "=", p.projectId)
      .orderBy("gate")
      .execute();
    expect(gates.map((g) => [g.gate, g.status])).toEqual([
      ["contract", "missing"],
      ["deposit_terms", "missing"],
      ["purchase_order", "missing"],
      ["quote", "satisfied"],
      ["scope", "satisfied"],
    ]);
    const withPm = await acceptedProject(t, lead, { pmId: pm.id });
    expect(
      (await t.db.selectFrom("projects").select("pm_id").where("id", "=", withPm.projectId).executeTakeFirstOrThrow()).pm_id,
    ).toBe(pm.id);
  });

  it("[COM-AC-05] the app role can never update or delete scope items or scopes", async () => {
    const p = await acceptedProject(t, lead);
    await expect(sql`UPDATE scope_items SET line_price_minor = 1 WHERE scope_id = ${p.scopeId}`.execute(t.db)).rejects.toThrow(
      /permission denied|INSERT_ONLY/,
    );
    await expect(sql`DELETE FROM scope_items WHERE scope_id = ${p.scopeId}`.execute(t.db)).rejects.toThrow(
      /permission denied|INSERT_ONLY/,
    );
    await expect(sql`UPDATE scopes SET currency = 'KHR' WHERE id = ${p.scopeId}`.execute(t.db)).rejects.toThrow(
      /permission denied|INSERT_ONLY/,
    );
    // Even the migrator hits the trigger.
    await expect(sql`DELETE FROM scope_items WHERE scope_id = ${p.scopeId}`.execute(t.migrator)).rejects.toThrow(/INSERT_ONLY/);
  });

  it("[COM-AC-06] only the deal owner or ops_lead accepts; the acceptance is audited by name with the win reason", async () => {
    const q = await sentQuote(t, lead);
    for (const a of [otherLead, pm, staff, admin]) await expectCode(accept(a, q), "FORBIDDEN");
    const r = await accept(ops, q);
    expect(r.status).toBe("accepted");
    const ev = await t.db
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "=", "quote.accept")
      .where("subject_id", "=", q.id)
      .where("outcome", "=", "ok")
      .executeTakeFirstOrThrow();
    expect(ev.actor_name).toBe("Vanna Ops");
    expect(JSON.stringify(ev.input)).toContain("creative");
  });
});

describe("commercial/retainers", () => {
  const retainerLines = () => [
    line("fee", 1, 200_000, 100_000, { perPeriod: true, quotedMinutes: 1200, descriptionEn: "Monthly social" }),
    line("fee", 1, 50_000, 20_000, { perPeriod: false, descriptionEn: "Setup" }),
  ];

  it("[COM-RT-01] accepting a retainer creates period 1 from the planned start's month with the per-period lines", async () => {
    const p = await acceptedProject(t, lead, {
      billingModel: "retainer",
      periodMonths: 3,
      lines: retainerLines(),
      plannedStart: "2026-11-10",
    });
    const periods = await t.db.selectFrom("scope_periods").selectAll().where("scope_id", "=", p.scopeId).execute();
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ period_no: 1, period_start: "2026-11-01", period_end: "2026-11-30", status: "upcoming" });
    const items = await t.db
      .selectFrom("scope_items")
      .select(["description_en", "scope_period_id"])
      .where("scope_id", "=", p.scopeId)
      .orderBy("description_en")
      .execute();
    expect(items).toEqual([
      { description_en: "Monthly social", scope_period_id: periods[0]!.id },
      { description_en: "Setup", scope_period_id: null },
    ]);
  });

  it("[COM-RT-02] the daily job opens the next period 7 days ahead, once, until the contracted months", async () => {
    const p = await acceptedProject(t, lead, {
      billingModel: "retainer",
      periodMonths: 2,
      lines: retainerLines(),
      plannedStart: "2026-11-01",
    });
    const count = async () =>
      (await t.db.selectFrom("scope_periods").select("period_no").where("scope_id", "=", p.scopeId).execute()).length;
    t.clock.set("2026-11-23T02:00:00Z"); // 8 days before Dec 1
    await run(job, retainerTick, {});
    expect(await count()).toBe(1);
    t.clock.set("2026-11-24T02:00:00Z"); // 7 days before
    await run(job, retainerTick, {});
    await run(job, retainerTick, {});
    expect(await count()).toBe(2);
    const p2 = await t.db
      .selectFrom("scope_periods")
      .selectAll()
      .where("scope_id", "=", p.scopeId)
      .where("period_no", "=", 2)
      .executeTakeFirstOrThrow();
    expect(p2).toMatchObject({ period_start: "2026-12-01", period_end: "2026-12-31" });
    const items = await t.db.selectFrom("scope_items").selectAll().where("scope_period_id", "=", p2.id).execute();
    expect(items.map((i) => [i.description_en, i.source_type])).toEqual([["Monthly social", "retainer_period"]]);
    t.clock.set("2026-12-24T02:00:00Z");
    await run(job, retainerTick, {});
    expect(await count()).toBe(2); // contracted 2 months
    // Jobs only: people cannot run it.
    await expectCode(run(ops, retainerTick, {}), "FORBIDDEN");
    t.clock.set("2026-10-19T02:00:00Z");
  });

  it("[COM-RT-03] periods go upcoming → active on their first day and active → closed after their last", async () => {
    const p = await acceptedProject(t, lead, {
      billingModel: "retainer",
      periodMonths: 2,
      lines: retainerLines(),
      plannedStart: "2026-11-01",
    });
    const status = async (n: number) =>
      (
        await t.db
          .selectFrom("scope_periods")
          .select("status")
          .where("scope_id", "=", p.scopeId)
          .where("period_no", "=", n)
          .executeTakeFirst()
      )?.status;
    expect(await status(1)).toBe("upcoming");
    t.clock.set("2026-11-01T01:00:00Z"); // 08:00 in Phnom Penh
    await run(job, retainerTick, {});
    expect(await status(1)).toBe("active");
    t.clock.set("2026-12-01T01:00:00Z");
    await run(job, retainerTick, {});
    expect(await status(1)).toBe("closed");
    expect(await status(2)).toBe("active");
    t.clock.set("2026-10-19T02:00:00Z");
  });
});

describe("reporting/giveaway", () => {
  it("[REP-GV-01] the giveaway ledger is insert-only for the app role", async () => {
    await expect(sql`UPDATE giveaway_entries SET amount_usd_minor = 0`.execute(t.db)).rejects.toThrow(
      /permission denied|INSERT_ONLY/,
    );
    await expect(sql`DELETE FROM giveaway_entries`.execute(t.db)).rejects.toThrow(/permission denied|INSERT_ONLY/);
  });

  it("[REP-GV-02] accepting writes one discount_vs_ratecard row per fee line priced below the rate card; none without discount", async () => {
    const card = await run<{ id: string }>(admin, rateCardUpsert, { name: `Card ${Date.now()}`, currency: "USD" });
    const item = await run<{ id: string }>(admin, rateCardItemUpsert, {
      rateCardId: card.id,
      kind: "fee",
      serviceCode: "DESIGN-DAY",
      labelEn: "Design day",
      labelKm: "KM-DRAFT: Design day",
      unit: "day",
      unitPriceMinor: "40000",
      unitCostMinor: "20000",
    });
    const p = await acceptedProject(t, lead, {
      rateCardId: card.id,
      lines: [
        { ...line("fee", 2, 40_000, 20_000), rateCardItemId: item.id, discountBp: 1000 }, // 80,000 − 72,000 = 8,000
        { ...line("fee", 1, 40_000, 20_000), rateCardItemId: item.id }, // at list: no row
        line("fee", 1, 10_000, 1_000), // custom line: no list price, no row
      ],
    });
    const rows = await t.db.selectFrom("giveaway_entries").selectAll().where("project_id", "=", p.projectId).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "discount_vs_ratecard",
      amount_usd_minor: 8000n,
      attributed_month: "2026-10-01",
      source_type: "quote",
      source_id: p.id,
      client_id: p.clientId,
    });
  });
});

describe("tasks/templates", () => {
  it("[TSK-TP-01] admin edits a template; items may depend only on earlier items", async () => {
    const et = (await t.db.selectFrom("engagement_types").select("id").where("code", "=", "one_off").executeTakeFirstOrThrow())
      .id;
    const pt = (
      await t.migrator
        .insertInto("project_types")
        .values({ code: "event", label_en: "Event", label_km: "ព្រឹត្តិការណ៍", default_engagement_type_id: et })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const bad = run(admin, templateSave, {
      projectTypeId: pt,
      name: "Event",
      items: [
        { key: "a", titleEn: "A", offsetDays: 0, estimateMinutes: 60, dependsOnKeys: ["b"] },
        { key: "b", titleEn: "B", offsetDays: 1, estimateMinutes: 60 },
      ],
    });
    await expectCode(bad, "VALIDATION");
    await expectCode(run(lead, templateSave, { projectTypeId: pt, name: "Event", items: [] }), "FORBIDDEN");
    await run(admin, templateSave, {
      projectTypeId: pt,
      name: "Event",
      items: [
        { key: "plan", titleEn: "Plan", titleKm: "ផែនការ", roleHint: "pm", offsetDays: 0, estimateMinutes: 60 },
        { key: "run", titleEn: "Run", roleHint: "producer", offsetDays: 10, estimateMinutes: 480, dependsOnKeys: ["plan"] },
      ],
    });
    await expectCode(run(staff, templateList, {}), "FORBIDDEN");
    const list = await run<{ projectType: { id: string }; template: { items: { key: string }[] } | null }[]>(
      admin, // admin edits templates and holds no project.view
      templateList,
      {},
    );
    expect(list.find((x) => x.projectType.id === pt)?.template?.items.map((i) => i.key)).toEqual(["plan", "run"]);
  });

  it("[TSK-TP-02] a new project gets its template tasks: owner by role hint else PM, due = start + offset, deps, scope link by service code", async () => {
    const pt = await projectTypeId(t, "campaign");
    const tpl = await t.db.selectFrom("task_templates").select("id").where("project_type_id", "=", pt).executeTakeFirstOrThrow();
    await t.migrator
      .updateTable("task_template_items")
      .set({ service_code: "DESIGN-DAY" })
      .where("template_id", "=", tpl.id)
      .where("key", "=", "assets")
      .execute();
    const card = await run<{ id: string }>(admin, rateCardUpsert, { name: `Card2 ${Date.now()}`, currency: "USD" });
    const item = await run<{ id: string }>(admin, rateCardItemUpsert, {
      rateCardId: card.id,
      kind: "fee",
      serviceCode: "DESIGN-DAY",
      labelEn: "Design day",
      labelKm: "KM-DRAFT: Design day",
      unit: "day",
      unitPriceMinor: "40000",
      unitCostMinor: "20000",
    });
    const p = await acceptedProject(t, lead, {
      rateCardId: card.id,
      lines: [{ ...line("fee", 3, 40_000, 20_000), rateCardItemId: item.id }],
      plannedStart: "2026-11-02",
    });
    expect(p.tasksCreated).toBe(4);
    const tasks = await t.db.selectFrom("tasks").selectAll().where("project_id", "=", p.projectId).orderBy("rank").execute();
    expect(tasks.map((x) => [x.title, x.due_date, x.owner_id, x.estimate_source])).toEqual([
      ["Kick-off and brief", "2026-11-02", lead.id, "template"],
      ["Creative concept", "2026-11-07", lead.id, "template"],
      ["Produce assets", "2026-11-14", lead.id, "template"],
      ["Launch and monitor", "2026-11-22", lead.id, "template"],
    ]);
    const scopeItem = await t.db
      .selectFrom("scope_items")
      .select("id")
      .where("scope_id", "=", p.scopeId)
      .executeTakeFirstOrThrow();
    expect(tasks[2]).toMatchObject({ scope_item_id: scopeItem.id, non_deliverable: false });
    expect(tasks[0]).toMatchObject({ scope_item_id: null, non_deliverable: true });
    const deps = await t.db
      .selectFrom("task_dependencies")
      .selectAll()
      .where(
        "task_id",
        "in",
        tasks.map((x) => x.id),
      )
      .execute();
    expect(deps).toHaveLength(3);
    expect(deps.find((d) => d.task_id === tasks[1]!.id)?.depends_on_id).toBe(tasks[0]!.id);
    await t.migrator.updateTable("task_template_items").set({ service_code: null }).where("template_id", "=", tpl.id).execute();
  });

  it("[TSK-TP-02] owners follow the role hint when a member holds that project role", async () => {
    const creative = await makeUser(t.db, { roles: ["staff"], name: "Creative" });
    const p = await acceptedProject(t, lead, { pmId: pm.id });
    await run(pm, projectSetMember, { projectId: p.projectId, userId: creative.id, projectRole: "creative" });
    const project = await t.db.selectFrom("projects").selectAll().where("id", "=", p.projectId).executeTakeFirstOrThrow();
    const before = await t.db.selectFrom("tasks").select("id").where("project_id", "=", p.projectId).execute();
    await applyTemplate({ tx: t.db } as unknown as Ctx, project); // re-apply now that a "creative" member exists
    const again = await t.db
      .selectFrom("tasks")
      .select(["title", "owner_id"])
      .where("project_id", "=", p.projectId)
      .where(
        "id",
        "not in",
        before.map((b) => b.id),
      )
      .orderBy("rank")
      .execute();
    expect(again.map((x) => [x.title, x.owner_id])).toEqual([
      ["Kick-off and brief", pm.id], // hint "pm": the PM member
      ["Creative concept", creative.id],
      ["Produce assets", pm.id], // hint "designer": nobody → PM
      ["Launch and monitor", pm.id],
    ]);
  });

  it("[TSK-TP-03] four starter templates are seeded, one per starter project type", async () => {
    const rows = await t.db
      .selectFrom("task_templates as t")
      .innerJoin("project_types as p", "p.id", "t.project_type_id")
      .select([
        "p.code",
        (eb) =>
          eb
            .selectFrom("task_template_items as i")
            .select((e) => e.fn.countAll<string>().as("n"))
            .whereRef("i.template_id", "=", "t.id")
            .as("items"),
      ])
      .where("p.code", "in", ["campaign", "content_production", "social_management", "influencer_program"])
      .orderBy("p.code")
      .execute();
    expect(rows.map((r) => [r.code, Number(r.items)])).toEqual([
      ["campaign", 4],
      ["content_production", 4],
      ["influencer_program", 4],
      ["social_management", 3],
    ]);
  });
});
