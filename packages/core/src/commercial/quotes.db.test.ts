import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, engagementTypeId, line, makeClient, makeDeal, makeUser, meta, type TestDb } from "@demoq/testkit";
import { approvalDecide } from "../approvals";
import { DomainError, execute, type OpDef, type RequestMeta, type UserActor } from "../kernel";
import { fxRateSet, rateCardItemUpsert, rateCardUpsert } from "./config";
import { quoteCreate, quoteGet, quoteList, quoteMarkRejected, quoteRevise, quoteSave, quoteSend, quoteSubmit } from "./quotes";

let t: TestDb;
let lead: UserActor, otherLead: UserActor, ops: UserActor, finance: UserActor, viewer: UserActor, admin: UserActor;
let campaign: string;

beforeAll(async () => {
  t = await createTestDb();
  lead = await makeUser(t.db, { roles: ["account_lead"], name: "Sokha Lead" });
  otherLead = await makeUser(t.db, { roles: ["account_lead"], name: "Dara Lead" });
  ops = await makeUser(t.db, { roles: ["ops_lead"], name: "Vanna Ops" });
  finance = await makeUser(t.db, { roles: ["finance"], name: "Sreymom Finance" });
  viewer = await makeUser(t.db, { roles: ["viewer"], name: "Viewer" });
  admin = await makeUser(t.db, { roles: ["admin"] });
  campaign = await engagementTypeId(t.db, "campaign");
});
afterAll(() => t.destroy());

const run = <T>(a: UserActor, op: OpDef, input: unknown, extra: Partial<RequestMeta> = {}) =>
  execute(t.kernel, meta(a, extra.channel ?? "web", extra), op, input) as Promise<T>;
const expectCode = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);

async function newQuote(opts: { currency?: "USD" | "KHR"; lines?: unknown[] } = {}) {
  const client = await makeClient(t.db, lead.id);
  const deal = await makeDeal(t.db, client.id, lead.id);
  const q = await run<{ id: string; version: number }>(lead, quoteCreate, {
    dealId: deal.id,
    title: "Launch campaign",
    currency: opts.currency ?? "USD",
    engagementTypeId: campaign,
  });
  const saved = await run<{ version: number }>(lead, quoteSave, {
    id: q.id,
    expectedVersion: q.version,
    lines: opts.lines ?? [line("fee", 10, 5000, 3000)],
  });
  return { id: q.id, version: saved.version, dealId: deal.id };
}
const get = (a: UserActor, id: string) =>
  run<{
    status: string;
    version: number;
    totalMinor: string;
    costs: null | { feeMarginBp: number; belowFloor: boolean };
    lines: { unitCostMinor: string | null; listPriceMinor: string | null; linePriceMinor: string }[];
  }>(a, quoteGet, { id });

describe("commercial/quote-builder", () => {
  it("[COM-QB-01] only the deal owner or ops edits; lines need positive quantities; retainers need months", async () => {
    const q = await newQuote();
    await expectCode(run(otherLead, quoteSave, { id: q.id, expectedVersion: q.version, title: "Hijack" }), "FORBIDDEN");
    await expectCode(
      run(lead, quoteSave, { id: q.id, expectedVersion: q.version, lines: [{ ...line("fee", 1, 1, 1), qtyMilli: 0 }] }),
      "VALIDATION",
    );
    await expectCode(run(lead, quoteSave, { id: q.id, expectedVersion: q.version, billingModel: "retainer" }), "VALIDATION");
    const r = await run<{ version: number }>(ops, quoteSave, {
      id: q.id,
      expectedVersion: q.version,
      billingModel: "retainer",
      periodMonths: 6,
    });
    expect(r.version).toBe(q.version + 1);
  });

  it("[COM-QB-02] the server stores margin from the shared function, whatever the browser claims", async () => {
    const q = await newQuote({ lines: [line("fee", 10, 5000, 3000), line("pass_through", 1, 110_000, 100_000)] });
    const row = await t.db.selectFrom("quotes").selectAll().where("id", "=", q.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      fee_price_minor: 50_000n,
      fee_cost_minor: 30_000n,
      pt_price_minor: 110_000n,
      fee_margin_bp: 4000,
      pt_markup_bp: 1000,
      below_floor: false,
      total_minor: 160_000n,
    });
  });

  it("[COM-QB-03] lines round half-up per line; discounts come off the line; fees and pass-through never net", async () => {
    const q = await newQuote({
      lines: [{ ...line("fee", 1, 333, 101), qtyMilli: 1500, discountBp: 1250 }, line("pass_through", 1, 1000, 1200)],
    });
    const d = await get(ops, q.id);
    expect(d.lines[0]!.linePriceMinor).toBe("437");
    expect(d.totalMinor).toBe("1437");
    const row = await t.db
      .selectFrom("quotes")
      .select(["fee_price_minor", "pt_price_minor", "pt_cost_minor", "discount_minor"])
      .where("id", "=", q.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ fee_price_minor: 437n, pt_price_minor: 1000n, pt_cost_minor: 1200n, discount_minor: 63n });
  });

  it("[COM-QB-04] costs and margin reach only finance.view_costs holders, on every channel", async () => {
    const q = await newQuote();
    for (const a of [lead, finance, ops]) expect((await get(a, q.id)).costs?.feeMarginBp).toBe(4000);
    const v = await get(viewer, q.id);
    expect(v.costs).toBeNull();
    expect(v.lines[0]!.unitCostMinor).toBeNull();
    const viaMcp = await run<{ costs: unknown }>(viewer, quoteGet, { id: q.id }, { channel: "mcp" });
    expect(viaMcp.costs).toBeNull();
    const list = await run<{ costs: unknown }[]>(viewer, quoteList, { dealId: q.dealId });
    expect(list.every((x) => x.costs === null)).toBe(true);
  });

  it("[COM-QB-05] at or above floor → ready; below → margin_review with a margin_floor approval bound to the hash", async () => {
    const ok = await newQuote();
    const r1 = await run<{ status: string; approvalId: string | null }>(lead, quoteSubmit, {
      id: ok.id,
      expectedVersion: ok.version,
    });
    expect(r1).toMatchObject({ status: "ready", approvalId: null });

    const low = await newQuote({ lines: [line("fee", 10, 5000, 4100)] }); // 18% < 25%
    const r2 = await run<{ status: string; approvalId: string }>(lead, quoteSubmit, { id: low.id, expectedVersion: low.version });
    expect(r2.status).toBe("margin_review");
    const a = await t.db.selectFrom("approvals").selectAll().where("id", "=", r2.approvalId).executeTakeFirstOrThrow();
    const q = await t.db
      .selectFrom("quotes")
      .select(["content_sha256", "version"])
      .where("id", "=", low.id)
      .executeTakeFirstOrThrow();
    expect(a).toMatchObject({
      kind: "margin_floor",
      subject_hash: q.content_sha256,
      subject_version: q.version,
      required_permission: "quote.approve_below_floor",
      requested_by: lead.id,
    });

    const empty = await newQuote({ lines: [] });
    await expectCode(run(lead, quoteSubmit, { id: empty.id, expectedVersion: empty.version }), "QUOTE_EMPTY");
  });

  it("[COM-QB-06] a below-floor quote cannot be sent without Finance/Ops approval for its current content — no role is exempt", async () => {
    const low = await newQuote({ lines: [line("fee", 10, 5000, 4100)] });
    const s = await run<{ approvalId: string; version: number }>(lead, quoteSubmit, { id: low.id, expectedVersion: low.version });
    // Force it to ready without an approval (simulating a bug): send must still refuse.
    await t.migrator.updateTable("quotes").set({ status: "ready" }).where("id", "=", low.id).execute();
    await expectCode(run(ops, quoteSend, { id: low.id, expectedVersion: s.version }), "MARGIN_BELOW_FLOOR");
    await expectCode(run(lead, approvalDecide, { id: s.approvalId, decision: "approve" }), "SELF_APPROVAL");
  });

  it("[COM-QB-07] editing after submit returns to draft and supersedes the pending approval", async () => {
    const low = await newQuote({ lines: [line("fee", 10, 5000, 4100)] });
    const s = await run<{ approvalId: string; version: number }>(lead, quoteSubmit, { id: low.id, expectedVersion: low.version });
    const e = await run<{ status: string }>(lead, quoteSave, {
      id: low.id,
      expectedVersion: s.version,
      lines: [line("fee", 10, 5000, 4200)],
    });
    expect(e.status).toBe("draft");
    const a = await t.db.selectFrom("approvals").select("status").where("id", "=", s.approvalId).executeTakeFirstOrThrow();
    expect(a.status).toBe("superseded");
    await expectCode(run(finance, approvalDecide, { id: s.approvalId, decision: "approve" }), "ALREADY_DECIDED");
  });

  it("[COM-QB-08] with 'send when approved', approval queues a send as the requester", async () => {
    const low = await newQuote({ lines: [line("fee", 10, 5000, 4100)] });
    const s = await run<{ approvalId: string }>(lead, quoteSubmit, {
      id: low.id,
      expectedVersion: low.version,
      sendOnApproval: true,
    });
    const m = meta(finance);
    await execute(t.kernel, m, approvalDecide, { id: s.approvalId, decision: "approve" });
    const q = await t.db.selectFrom("quotes").select("status").where("id", "=", low.id).executeTakeFirstOrThrow();
    expect(q.status).toBe("ready");
    const evt = await t.db
      .selectFrom("outbox")
      .selectAll()
      .where("request_id", "=", m.requestId)
      .where("event", "=", "quote.send_requested")
      .executeTakeFirstOrThrow();
    expect(evt.payload).toMatchObject({ quoteId: low.id, requesterId: lead.id, approvalId: s.approvalId });
  });

  it("[COM-QB-09] send freezes FX, locks, supersedes the earlier sent version, and moves the deal to proposal", async () => {
    const khr = await newQuote({ currency: "KHR", lines: [line("fee", 1, 4_000_000, 1_000_000)] });
    const s = await run<{ version: number }>(lead, quoteSubmit, { id: khr.id, expectedVersion: khr.version });
    await expectCode(run(lead, quoteSend, { id: khr.id, expectedVersion: s.version }), "FX_RATE_MISSING");
    await run(finance, fxRateSet, { rateDate: "2026-10-17", khrPerUsd: "4105" });
    const sent = await run<{ status: string; version: number; fxRateDate: string }>(lead, quoteSend, {
      id: khr.id,
      expectedVersion: s.version,
    });
    expect(sent).toMatchObject({ status: "sent", fxRateDate: "2026-10-17" });
    const row = await t.db.selectFrom("quotes").selectAll().where("id", "=", khr.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ fx_rate_micros: 4_105_000_000n, pdf_status: "pending", sent_by: lead.id });
    const deal = await t.db.selectFrom("deals").select("stage").where("id", "=", khr.dealId).executeTakeFirstOrThrow();
    expect(deal.stage).toBe("proposal");
    await expectCode(run(lead, quoteSave, { id: khr.id, expectedVersion: sent.version, title: "Changed" }), "QUOTE_LOCKED");

    const v2 = await run<{ id: string; version: number }>(lead, quoteRevise, { id: khr.id });
    const s2 = await run<{ version: number }>(lead, quoteSubmit, { id: v2.id, expectedVersion: v2.version });
    await run(lead, quoteSend, { id: v2.id, expectedVersion: s2.version });
    const v1 = await t.db.selectFrom("quotes").select("status").where("id", "=", khr.id).executeTakeFirstOrThrow();
    expect(v1.status).toBe("superseded");
  });

  it("[COM-QB-10] DB backstop: the app role cannot change a sent quote's money or lines, nor un-accept", async () => {
    const q = await newQuote();
    const s = await run<{ version: number }>(lead, quoteSubmit, { id: q.id, expectedVersion: q.version });
    await run(lead, quoteSend, { id: q.id, expectedVersion: s.version });
    await expect(t.db.updateTable("quotes").set({ total_minor: 1n }).where("id", "=", q.id).execute()).rejects.toThrow(
      /QUOTE_LOCKED/,
    );
    await expect(sql`UPDATE quote_lines SET unit_price_minor = 1 WHERE quote_id = ${q.id}`.execute(t.db)).rejects.toThrow(
      /QUOTE_LOCKED/,
    );
    await expect(sql`DELETE FROM quote_lines WHERE quote_id = ${q.id}`.execute(t.db)).rejects.toThrow(/QUOTE_LOCKED/);
    await t.migrator.updateTable("quotes").set({ status: "accepted" }).where("id", "=", q.id).execute();
    await expect(t.db.updateTable("quotes").set({ status: "sent" }).where("id", "=", q.id).execute()).rejects.toThrow(
      /QUOTE_LOCKED/,
    );
  });

  it("[COM-QB-11] revise copies a sent/rejected quote into the next draft version; reject records the client's no", async () => {
    const q = await newQuote({ lines: [line("fee", 2, 5000, 1000), line("pass_through", 1, 1000, 900)] });
    const s = await run<{ version: number }>(lead, quoteSubmit, { id: q.id, expectedVersion: q.version });
    await expectCode(run(lead, quoteRevise, { id: q.id }), "INVALID_TRANSITION"); // ready: not yet sent
    const sent = await run<{ version: number }>(lead, quoteSend, { id: q.id, expectedVersion: s.version });
    const rej = await run<{ status: string }>(lead, quoteMarkRejected, {
      id: q.id,
      expectedVersion: sent.version,
      reason: "Budget moved to Q1",
    });
    expect(rej.status).toBe("rejected");
    const v2 = await run<{ id: string; versionNo: number }>(lead, quoteRevise, { id: q.id });
    expect(v2.versionNo).toBe(2);
    const d = await get(lead, v2.id);
    expect(d.status).toBe("draft");
    expect(d.lines).toHaveLength(2);
    expect(d.totalMinor).toBe("11000");
  });

  it("[COM-QB-12] every step is audited by name and channel", async () => {
    const q = await newQuote();
    const s = await run<{ version: number }>(lead, quoteSubmit, { id: q.id, expectedVersion: q.version }, { channel: "mcp" });
    await run(lead, quoteSend, { id: q.id, expectedVersion: s.version });
    const rows = await t.db
      .selectFrom("audit_events")
      .select(["action", "actor_name", "channel"])
      .where("subject_id", "=", q.id)
      .orderBy("id")
      .execute();
    expect(rows.map((r) => [r.action, r.channel])).toEqual([
      ["quote.create", "web"],
      ["quote.save", "web"],
      ["quote.submit", "mcp"],
      ["quote.send", "web"],
    ]);
    expect(rows.every((r) => r.actor_name === "Sokha Lead")).toBe(true);
  });

  it("[COM-QB-13] a rate-card item sets the list price and default cost", async () => {
    const card = await run<{ id: string }>(admin, rateCardUpsert, { name: "Quote test card", currency: "USD" });
    const item = await run<{ id: string }>(admin, rateCardItemUpsert, {
      rateCardId: card.id,
      serviceCode: "SOC-POST",
      kind: "fee",
      labelEn: "Social post",
      labelKm: "ប្រកាស",
      unit: "post",
      unitPriceMinor: "15000",
      unitCostMinor: "6000",
    });
    const client = await makeClient(t.db, lead.id);
    const deal = await makeDeal(t.db, client.id, lead.id);
    const q = await run<{ id: string; version: number }>(lead, quoteCreate, {
      dealId: deal.id,
      title: "Posts",
      engagementTypeId: campaign,
      rateCardId: card.id,
    });
    await run(lead, quoteSave, {
      id: q.id,
      expectedVersion: q.version,
      lines: [
        {
          kind: "fee",
          rateCardItemId: item.id,
          descriptionEn: "8 posts",
          qtyMilli: 8000,
          unitPriceMinor: "12000",
          discountBp: 0,
        },
      ],
    });
    const d = await get(lead, q.id);
    expect(d.lines[0]).toMatchObject({ listPriceMinor: "15000", unitCostMinor: "6000", linePriceMinor: "96000" });
  });
});
