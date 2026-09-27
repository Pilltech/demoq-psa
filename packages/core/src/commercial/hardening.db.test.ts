// Regression tests for the S2 security review. Each cites the rule it protects.
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, engagementTypeId, line, makeClient, makeDeal, makeUser, meta, type TestDb } from "@demoq/testkit";
import { approvalDecide, approvalInbox } from "../approvals";
import { userSetRoles } from "../identity";
import { DomainError, execute, type OpDef, type RequestMeta, type UserActor } from "../kernel";
import { profileGet, tokenCreate } from "../profile";
import { engagementTypeUpsert, rateCardItemUpsert, rateCardUpsert } from "./config";
import { quoteCreate, quoteGet, quoteSave, quoteSend, quoteSubmit } from "./quotes";

let t: TestDb;
let lead: UserActor, finance: UserActor, ops: UserActor, admin: UserActor, viewer: UserActor, admin2: UserActor;
let campaign: string;
beforeAll(async () => {
  t = await createTestDb();
  lead = await makeUser(t.db, { roles: ["account_lead"], name: "Sokha Lead" });
  finance = await makeUser(t.db, { roles: ["finance"], name: "Aaa Finance" });
  ops = await makeUser(t.db, { roles: ["ops_lead"], name: "Vanna Ops" });
  admin = await makeUser(t.db, { roles: ["admin"], name: "Sys Admin" });
  admin2 = await makeUser(t.db, { roles: ["admin"], name: "Other Admin" });
  viewer = await makeUser(t.db, { roles: ["viewer"] });
  campaign = await engagementTypeId(t.db, "campaign");
});
afterAll(() => t.destroy());

const run = <T>(a: UserActor, op: OpDef, input: unknown, extra: Partial<RequestMeta> = {}) =>
  execute(t.kernel, meta(a, extra.channel ?? "web", extra), op, input) as Promise<T>;
const expectCode = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);

async function deal() {
  const c = await makeClient(t.db, lead.id);
  return makeDeal(t.db, c.id, lead.id);
}
async function quote(opts: { currency?: "USD" | "KHR"; rateCardId?: string; lines?: unknown[] } = {}) {
  const d = await deal();
  const q = await run<{ id: string; version: number }>(lead, quoteCreate, {
    dealId: d.id,
    title: "Q",
    currency: opts.currency ?? "USD",
    engagementTypeId: campaign,
    rateCardId: opts.rateCardId,
  });
  const s = await run<{ version: number }>(lead, quoteSave, {
    id: q.id,
    expectedVersion: q.version,
    lines: opts.lines ?? [line("fee", 10, 5000, 3000)],
  });
  return { id: q.id, version: s.version, dealId: d.id };
}

describe("S2 review regressions", () => {
  it("[COM-QB-13] rate-card items must come from the quote's own card, be active and match kind; costs never below the card", async () => {
    const usd = await run<{ id: string }>(admin, rateCardUpsert, { name: "USD card", currency: "USD" });
    const khr = await run<{ id: string }>(admin, rateCardUpsert, { name: "KHR card", currency: "KHR" });
    const item = await run<{ id: string }>(admin, rateCardItemUpsert, {
      rateCardId: usd.id,
      serviceCode: "EDIT",
      kind: "fee",
      labelEn: "Edit",
      labelKm: "កែ",
      unit: "hour",
      unitPriceMinor: "5000",
      unitCostMinor: "2500",
    });
    // A KHR quote cannot use a USD card, nor a USD item.
    const d = await deal();
    await expectCode(
      run(lead, quoteCreate, { dealId: d.id, title: "x", currency: "KHR", engagementTypeId: campaign, rateCardId: usd.id }),
      "VALIDATION",
    );
    const k = await run<{ id: string; version: number }>(lead, quoteCreate, {
      dealId: d.id,
      title: "k",
      currency: "KHR",
      engagementTypeId: campaign,
      rateCardId: khr.id,
    });
    const useItem = (extra: Record<string, unknown> = {}) => ({
      kind: "fee",
      rateCardItemId: item.id,
      descriptionEn: "Edit",
      qtyMilli: 1000,
      unitPriceMinor: "410000",
      ...extra,
    });
    await expectCode(run(lead, quoteSave, { id: k.id, expectedVersion: k.version, lines: [useItem()] }), "VALIDATION");
    // On its own card: kind must match, cost cannot go below the card (D-QB-2), inactive items are refused.
    const u = await quote({ rateCardId: usd.id, lines: [] });
    await expectCode(
      run(lead, quoteSave, { id: u.id, expectedVersion: u.version, lines: [useItem({ kind: "pass_through" })] }),
      "VALIDATION",
    );
    await expectCode(
      run(lead, quoteSave, {
        id: u.id,
        expectedVersion: u.version,
        lines: [useItem({ unitPriceMinor: "5000", unitCostMinor: "0" })],
      }),
      "VALIDATION",
    );
    const ok = await run<{ version: number }>(lead, quoteSave, {
      id: u.id,
      expectedVersion: u.version,
      lines: [useItem({ unitPriceMinor: "5000", unitCostMinor: "3000" })],
    });
    await t.migrator.updateTable("rate_card_items").set({ active: false }).where("id", "=", item.id).execute();
    await expectCode(
      run(lead, quoteSave, { id: u.id, expectedVersion: ok.version, lines: [useItem({ unitPriceMinor: "5000" })] }),
      "VALIDATION",
    );
    // Inactive engagement types cannot be used.
    const et = await run<{ id: string }>(admin, engagementTypeUpsert, {
      code: "legacy_low",
      labelEn: "Legacy",
      labelKm: "ចាស់",
      commercialModel: "one_off",
      feeMarginFloorBp: 0,
      active: false,
    });
    await expectCode(run(lead, quoteCreate, { dealId: (await deal()).id, title: "x", engagementTypeId: et.id }), "VALIDATION");
  });

  it("[COM-QB-09] two versions of one deal can never both be sent (concurrent sends)", async () => {
    const d = await deal();
    const mk = async () => {
      const q = await run<{ id: string; version: number }>(lead, quoteCreate, {
        dealId: d.id,
        title: "v",
        engagementTypeId: campaign,
      });
      const s = await run<{ version: number }>(lead, quoteSave, {
        id: q.id,
        expectedVersion: q.version,
        lines: [line("fee", 1, 5000, 1000)],
      });
      const r = await run<{ version: number }>(lead, quoteSubmit, { id: q.id, expectedVersion: s.version });
      return { id: q.id, version: r.version };
    };
    const [a, b] = [await mk(), await mk()];
    await Promise.allSettled([
      run(lead, quoteSend, { id: a.id, expectedVersion: a.version }),
      run(ops, quoteSend, { id: b.id, expectedVersion: b.version }),
    ]);
    const sent = await t.db.selectFrom("quotes").select("id").where("deal_id", "=", d.id).where("status", "=", "sent").execute();
    expect(sent).toHaveLength(1);
  });

  it("[COM-QB-10] the DB refuses sent → draft, and changes to parties or margin on a sent quote", async () => {
    const q = await quote();
    const s = await run<{ version: number }>(lead, quoteSubmit, { id: q.id, expectedVersion: q.version });
    await run(lead, quoteSend, { id: q.id, expectedVersion: s.version });
    await expect(t.db.updateTable("quotes").set({ status: "draft" }).where("id", "=", q.id).execute()).rejects.toThrow(
      /QUOTE_LOCKED/,
    );
    await expect(t.db.updateTable("quotes").set({ owner_id: ops.id }).where("id", "=", q.id).execute()).rejects.toThrow(
      /QUOTE_LOCKED/,
    );
    await expect(t.db.updateTable("quotes").set({ below_floor: true }).where("id", "=", q.id).execute()).rejects.toThrow(
      /QUOTE_LOCKED/,
    );
    await t.db.updateTable("quotes").set({ status: "rejected" }).where("id", "=", q.id).execute();
    await expect(t.db.updateTable("quotes").set({ status: "sent" }).where("id", "=", q.id).execute()).rejects.toThrow(
      /QUOTE_LOCKED/,
    );
  });

  it("[COM-QB-06] the DB refuses to mark a below-floor quote sent without an approval for its content", async () => {
    const q = await quote({ lines: [line("fee", 10, 5000, 4100)] });
    await run(lead, quoteSubmit, { id: q.id, expectedVersion: q.version });
    await expect(
      sql`UPDATE quotes SET status = 'sent', sent_at = now(), fx_rate_micros = 1000000, fx_rate_date = '2026-10-19' WHERE id = ${q.id}`.execute(
        t.db,
      ),
    ).rejects.toThrow(/MARGIN_BELOW_FLOOR/);
  });

  it("[MCP-04] role changes revoke tokens; at most 5 active tokens per person", async () => {
    const u = await makeUser(t.db, { roles: ["account_lead"] });
    await run(u, tokenCreate, { label: "w", scopes: ["read", "write"] });
    await run(admin, userSetRoles, { userId: u.id, expectedVersion: 1, roles: ["ops_lead"] });
    const p = await t.db.selectFrom("api_tokens").select("revoked_at").where("user_id", "=", u.id).execute();
    expect(p.every((x) => x.revoked_at !== null)).toBe(true);
    const v = await makeUser(t.db, { roles: ["staff"] });
    for (let i = 0; i < 5; i++) await run(v, tokenCreate, { label: `t${i}` });
    await expectCode(run(v, tokenCreate, { label: "t6" }), "CONFLICT");
    const prof = await run<{ tokens: unknown[] }>(v, profileGet, {});
    expect(prof.tokens).toHaveLength(5);
  });

  it("[APR-EN-05] an admin never decides or receives business approvals, even with a business role", async () => {
    await run(admin, userSetRoles, { userId: admin2.id, expectedVersion: 1, roles: ["admin", "finance"] });
    const q = await quote({ lines: [line("fee", 10, 5000, 4100)] });
    const s = await run<{ approvalId: string }>(lead, quoteSubmit, { id: q.id, expectedVersion: q.version });
    const a = await t.db.selectFrom("approvals").select("assignee_id").where("id", "=", s.approvalId).executeTakeFirstOrThrow();
    expect(a.assignee_id).not.toBe(admin2.id);
    const adminNow = { ...admin2, roles: ["admin", "finance"] as UserActor["roles"] };
    await expectCode(run(adminNow, approvalDecide, { id: s.approvalId, decision: "approve" }), "FORBIDDEN");
  });

  it("[APR-EN-11] my approvals never disappear behind 500 others", async () => {
    const q = await quote({ lines: [line("fee", 10, 5000, 4100)] });
    const mine = await run<{ approvalId: string }>(lead, quoteSubmit, { id: q.id, expectedVersion: q.version });
    // 520 older, earlier-due approvals for another kind I cannot decide.
    const other = await makeUser(t.db, { roles: ["account_lead"] });
    const rows = Array.from({ length: 520 }, (_, i) => ({
      kind: "leave",
      subject_type: "leave_request",
      subject_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      subject_version: 1,
      subject_hash: "x",
      requested_by: other.id,
      required_permission: "leave.approve",
      due_at: new Date("2026-01-01T00:00:00Z"),
      snapshot: JSON.stringify({ title: "Leave", scope: {} }),
    }));
    await t.migrator.insertInto("approvals").values(rows).execute();
    const inbox = await run<{ id: string }[]>(finance, approvalInbox, {});
    expect(inbox.map((r) => r.id)).toContain(mine.approvalId);
  });

  it("[APR-EN-12] a pass-through-only or zero-priced shortfall still needs step-up", async () => {
    const q = await quote({ lines: [line("fee", 1, 0, 5000)] }); // fee priced at 0 with cost: undefined margin
    const s = await run<{ approvalId: string }>(lead, quoteSubmit, { id: q.id, expectedVersion: q.version });
    await expectCode(run(finance, approvalDecide, { id: s.approvalId, decision: "approve" }), "STEP_UP_REQUIRED");
  });

  it("[COM-QB-01] quotes on a lost deal cannot be saved, submitted or sent", async () => {
    const q = await quote();
    await t.migrator
      .updateTable("deals")
      .set({ stage: "lost", close_reason_code: "price", close_reason_kind: "lost", closed_at: t.clock.now })
      .where("id", "=", q.dealId)
      .execute();
    await expectCode(run(lead, quoteSave, { id: q.id, expectedVersion: q.version, title: "x" }), "INVALID_TRANSITION");
    await expectCode(run(lead, quoteSubmit, { id: q.id, expectedVersion: q.version }), "INVALID_TRANSITION");
  });

  it("[COM-QB-03] huge quantities or prices are refused, never a 500", async () => {
    const q = await quote();
    await expectCode(
      run(lead, quoteSave, {
        id: q.id,
        expectedVersion: q.version,
        lines: [{ ...line("fee", 1, 1, 1), qtyMilli: 1_000_000_000 }],
      }),
      "VALIDATION",
    );
    await expectCode(
      run(lead, quoteSave, {
        id: q.id,
        expectedVersion: q.version,
        lines: [line("fee", 1, 1, 1), { ...line("pass_through", 1, 1, 1), unitPriceMinor: "9".repeat(13) }],
      }),
      "VALIDATION",
    );
    // Extreme but valid ratios are clamped into the stored columns.
    const r = await run<{ version: number }>(lead, quoteSave, {
      id: q.id,
      expectedVersion: q.version,
      lines: [line("pass_through", 1, 900_000_000_000, 1)],
    });
    expect(r.version).toBe(q.version + 1);
    const row = await t.db.selectFrom("quotes").select("pt_markup_bp").where("id", "=", q.id).executeTakeFirstOrThrow();
    expect(row.pt_markup_bp).toBe(1_000_000);
  });

  it("[COM-QB-04] people without cost access see 'submitted', not the margin-review state", async () => {
    const q = await quote({ lines: [line("fee", 10, 5000, 4100)] });
    await run(lead, quoteSubmit, { id: q.id, expectedVersion: q.version });
    const v = await run<{ status: string; approval: unknown }>(viewer, quoteGet, { id: q.id });
    expect(v).toMatchObject({ status: "submitted", approval: null });
    const f = await run<{ status: string }>(finance, quoteGet, { id: q.id });
    expect(f.status).toBe("margin_review");
  });
});
