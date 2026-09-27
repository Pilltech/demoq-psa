import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makeUser, meta, type TestDb } from "@demoq/testkit";
import { DomainError, execute, type OpDef, type UserActor } from "../kernel";
import {
  currentFxRate,
  engagementTypeList,
  engagementTypeUpsert,
  fxRateList,
  fxRateSet,
  projectTypeList,
  projectTypeUpsert,
  rateCardGet,
  rateCardItemUpsert,
  rateCardUpsert,
} from "./config";

let t: TestDb;
let admin: UserActor, finance: UserActor, lead: UserActor, viewer: UserActor, staff: UserActor;
beforeAll(async () => {
  t = await createTestDb();
  admin = await makeUser(t.db, { roles: ["admin"] });
  finance = await makeUser(t.db, { roles: ["finance"] });
  lead = await makeUser(t.db, { roles: ["account_lead"] });
  viewer = await makeUser(t.db, { roles: ["viewer"] });
  staff = await makeUser(t.db, { roles: ["staff"] });
});
afterAll(() => t.destroy());

const run = <T>(a: UserActor, op: OpDef, input: unknown) => execute(t.kernel, meta(a), op, input) as Promise<T>;
const expectCode = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);

describe("commercial/pricing-config", () => {
  it("[COM-CF-01] engagement types carry floors in basis points with sensible defaults", async () => {
    const r = await run<{ id: string; version: number }>(admin, engagementTypeUpsert, {
      code: "event",
      labelEn: "Event",
      labelKm: "ព្រឹត្តិការណ៍",
      commercialModel: "one_off",
    });
    const row = await t.db.selectFrom("engagement_types").selectAll().where("id", "=", r.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ fee_margin_floor_bp: 2500, passthrough_markup_floor_bp: null, passthrough_markup_warn_bp: 1000 });
    await expectCode(
      run(admin, engagementTypeUpsert, {
        code: "bad",
        labelEn: "x",
        labelKm: "x",
        commercialModel: "one_off",
        feeMarginFloorBp: 10001,
      }),
      "VALIDATION",
    );
    const up = await run<{ version: number }>(admin, engagementTypeUpsert, {
      id: r.id,
      expectedVersion: 1,
      code: "event",
      labelEn: "Event",
      labelKm: "ព្រឹត្តិការណ៍",
      commercialModel: "one_off",
      feeMarginFloorBp: 3000,
    });
    expect(up.version).toBe(2);
    await expectCode(
      run(admin, engagementTypeUpsert, {
        id: r.id,
        expectedVersion: 1,
        code: "event",
        labelEn: "E",
        labelKm: "E",
        commercialModel: "one_off",
      }),
      "STALE_VERSION",
    );
    const seeded = await run<{ code: string }[]>(lead, engagementTypeList, {});
    expect(seeded.map((e) => e.code)).toEqual(
      expect.arrayContaining(["campaign", "retainer", "one_off", "influencer_program", "event"]),
    );
  });

  it("[COM-CF-02] project types point at a default engagement type", async () => {
    const et = (await t.db.selectFrom("engagement_types").select("id").where("code", "=", "campaign").executeTakeFirstOrThrow())
      .id;
    await run(admin, projectTypeUpsert, {
      code: "tiktok_campaign",
      labelEn: "TikTok campaign",
      labelKm: "យុទ្ធនាការ TikTok",
      defaultEngagementTypeId: et,
    });
    const list = await run<{ code: string }[]>(lead, projectTypeList, {});
    expect(list.map((p) => p.code)).toEqual(
      expect.arrayContaining(["tiktok_campaign", "content_production", "social_management"]),
    );
  });

  it("[COM-CF-03] rate-card items have unique service codes per card and non-negative money", async () => {
    const card = await run<{ id: string }>(admin, rateCardUpsert, { name: "Standard 2026 USD", currency: "USD" });
    const item = {
      rateCardId: card.id,
      serviceCode: "VID-EDIT-HR",
      kind: "fee",
      labelEn: "Video editing",
      labelKm: "កាត់តវីដេអូ",
      unit: "hour",
      unitPriceMinor: "5000",
      unitCostMinor: "2000",
    };
    await run(admin, rateCardItemUpsert, item);
    await expectCode(run(admin, rateCardItemUpsert, item), "CONFLICT");
    await expectCode(run(admin, rateCardItemUpsert, { ...item, serviceCode: "NEG", unitPriceMinor: "-1" }), "VALIDATION");
  });

  it("[COM-CF-04] only admin edits config, only finance sets FX; costs are hidden without finance.view_costs", async () => {
    await expectCode(run(lead, rateCardUpsert, { name: "Mine", currency: "USD" }), "FORBIDDEN");
    await expectCode(run(lead, fxRateSet, { rateDate: "2026-10-19", khrPerUsd: "4100" }), "FORBIDDEN");
    await expectCode(run(admin, fxRateSet, { rateDate: "2026-10-19", khrPerUsd: "4100" }), "FORBIDDEN");
    await expectCode(run(staff, engagementTypeList, {}), "FORBIDDEN");
    const card = (
      await t.db.selectFrom("rate_cards").select("id").where("name", "=", "Standard 2026 USD").executeTakeFirstOrThrow()
    ).id;
    const forViewer = await run<{ items: { unit_price_minor: string; unit_cost_minor: string | null }[] }>(viewer, rateCardGet, {
      id: card,
    });
    expect(forViewer.items[0]).toMatchObject({ unit_price_minor: "5000", unit_cost_minor: null });
    const forFinance = await run<{ items: { unit_cost_minor: string | null }[] }>(finance, rateCardGet, { id: card });
    expect(forFinance.items[0]!.unit_cost_minor).toBe("2000");
    // Account leads see card costs (they see them on their own quotes anyway); admins do not.
    const forLead = await run<{ items: { unit_cost_minor: string | null }[] }>(lead, rateCardGet, { id: card });
    expect(forLead.items[0]!.unit_cost_minor).toBe("2000");
    const forAdmin = await run<{ items: { id: string; version: number; unit_cost_minor: string | null }[] }>(admin, rateCardGet, {
      id: card,
    });
    expect(forAdmin.items[0]!.unit_cost_minor).toBeNull();
    // An admin edits the price without re-entering the (hidden) cost: the stored cost is kept.
    const it0 = forAdmin.items[0]!;
    await run(admin, rateCardItemUpsert, {
      id: it0.id,
      expectedVersion: it0.version,
      rateCardId: card,
      serviceCode: "VID-EDIT-HR",
      kind: "fee",
      labelEn: "Video editing",
      labelKm: "កាត់តវីដេអូ",
      unit: "hour",
      unitPriceMinor: "5500",
    });
    const after = await t.db
      .selectFrom("rate_card_items")
      .select(["unit_price_minor", "unit_cost_minor"])
      .where("id", "=", it0.id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({ unit_price_minor: 5500n, unit_cost_minor: 2000n });
  });

  it("[COM-CF-05] FX rates are exact integers, one per date; a correction replaces and is audited", async () => {
    await run(finance, fxRateSet, { rateDate: "2026-10-16", khrPerUsd: "4102.5" });
    await run(finance, fxRateSet, { rateDate: "2026-10-16", khrPerUsd: "4103" });
    const rows = await t.db.selectFrom("fx_rates").selectAll().where("rate_date", "=", "2026-10-16").execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rate_micros).toBe(4_103_000_000n);
    expect(rows[0]!.version).toBe(2);
    const audited = await t.db
      .selectFrom("audit_events")
      .select("action")
      .where("action", "=", "fx_rate.set")
      .where("actor_id", "=", finance.id)
      .execute();
    expect(audited).toHaveLength(2);
    await expectCode(run(finance, fxRateSet, { rateDate: "2026-10-16", khrPerUsd: "41.0000001" }), "VALIDATION");
    const list = await run<{ rate_micros: string }[]>(viewer, fxRateList, {});
    expect(list[0]!.rate_micros).toBe("4103000000");
  });

  it("[COM-CF-06] the current rate is the latest within 5 calendar days", async () => {
    const at = async (iso: string) => {
      return t.db
        .transaction()
        .execute((tx) =>
          currentFxRate({ tx, now: new Date(iso), actor: finance, channel: "web", requestId: "r", locale: "en", emit: () => {} }),
        );
    };
    await run(finance, fxRateSet, { rateDate: "2026-10-19", khrPerUsd: "4100" });
    // Rates exist for 2026-10-16 (Fri) and 2026-10-19 (Mon).
    expect((await at("2026-10-18T05:00:00Z"))?.rateDate).toBe("2026-10-16"); // Sunday uses Friday's
    expect((await at("2026-10-20T05:00:00Z"))?.rateDate).toBe("2026-10-19");
    expect((await at("2026-10-24T05:00:00Z"))?.rateDate).toBe("2026-10-19"); // 5 days old: still valid
    expect(await at("2026-10-25T05:00:00Z")).toBeNull(); // 6 days old: too stale
    expect((await at("2026-10-18T20:00:00Z"))?.rateDate).toBe("2026-10-19"); // 03:00 Mon in Phnom Penh
  });
});
