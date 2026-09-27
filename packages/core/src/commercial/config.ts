// Engagement types, project types, rate cards and FX. Spec: specs/commercial/pricing-config.md (COM-CF-*)
import { z } from "zod";
import {
  EngagementTypeUpsertInput,
  FxRateListInput,
  FxRateSetInput,
  ProjectTypeUpsertInput,
  RateCardItemUpsertInput,
  RateCardUpsertInput,
  ByIdInput,
} from "@demoq/shared";
import {
  addDays,
  assertVersion,
  businessDate,
  can,
  defineCommand,
  defineQuery,
  DomainError,
  notFoundIfMissing,
  type Ctx,
} from "../kernel";

type Table = "engagement_types" | "project_types" | "rate_cards" | "rate_card_items";

/** Insert, or update-with-version-check, one config row. */
async function upsert<T extends Record<string, unknown>>(
  ctx: Ctx,
  table: Table,
  id: string | undefined,
  expected: number | undefined,
  values: T,
) {
  if (!id) {
    return ctx.tx
      .insertInto(table)
      .values(values as never)
      .returning(["id", "version"])
      .executeTakeFirstOrThrow();
  }
  const cur = notFoundIfMissing(
    await ctx.tx.selectFrom(table).select(["id", "version"]).where("id", "=", id).forUpdate().executeTakeFirst(),
  );
  if (expected === undefined)
    throw new DomainError("VALIDATION", { issues: [{ path: "expectedVersion", message: "Required for updates" }] });
  assertVersion(cur.version, expected);
  return ctx.tx
    .updateTable(table)
    .set({ ...(values as object), version: cur.version + 1 } as never)
    .where("id", "=", id)
    .returning(["id", "version"])
    .executeTakeFirstOrThrow();
}

export const engagementTypeUpsert = defineCommand({
  name: "engagement_type.upsert",
  summary: "Create or edit an engagement type and its margin floors",
  permission: "admin.config",
  input: EngagementTypeUpsertInput,
  exposeTo: ["web"],
  run: (ctx, i) =>
    upsert(ctx, "engagement_types", i.id, i.expectedVersion, {
      code: i.code,
      label_en: i.labelEn,
      label_km: i.labelKm,
      commercial_model: i.commercialModel,
      fee_margin_floor_bp: i.feeMarginFloorBp,
      passthrough_markup_floor_bp: i.passthroughMarkupFloorBp,
      passthrough_markup_warn_bp: i.passthroughMarkupWarnBp,
      active: i.active,
    }),
  subject: (_i, r) => ({ type: "engagement_type", id: r.id }),
});

export const projectTypeUpsert = defineCommand({
  name: "project_type.upsert",
  summary: "Create or edit a project type",
  permission: "admin.config",
  input: ProjectTypeUpsertInput,
  exposeTo: ["web"],
  run: (ctx, i) =>
    upsert(ctx, "project_types", i.id, i.expectedVersion, {
      code: i.code,
      label_en: i.labelEn,
      label_km: i.labelKm,
      default_engagement_type_id: i.defaultEngagementTypeId,
      active: i.active,
    }),
  subject: (_i, r) => ({ type: "project_type", id: r.id }),
});

export const rateCardUpsert = defineCommand({
  name: "rate_card.upsert",
  summary: "Create or edit a rate card",
  permission: "admin.config",
  input: RateCardUpsertInput,
  exposeTo: ["web"],
  run: (ctx, i) => upsert(ctx, "rate_cards", i.id, i.expectedVersion, { name: i.name, currency: i.currency, active: i.active }),
  subject: (_i, r) => ({ type: "rate_card", id: r.id }),
});

export const rateCardItemUpsert = defineCommand({
  name: "rate_card.item_upsert",
  summary: "Create or edit a rate-card item (service, unit, price, cost)",
  permission: "admin.config",
  input: RateCardItemUpsertInput,
  exposeTo: ["web"],
  run: (ctx, i) =>
    upsert(ctx, "rate_card_items", i.id, i.expectedVersion, {
      rate_card_id: i.rateCardId,
      service_code: i.serviceCode,
      kind: i.kind,
      label_en: i.labelEn,
      label_km: i.labelKm,
      unit: i.unit,
      unit_price_minor: i.unitPriceMinor,
      unit_cost_minor: i.unitCostMinor,
      active: i.active,
    }),
  subject: (_i, r) => ({ type: "rate_card_item", id: r.id }),
});

export const engagementTypeList = defineQuery({
  name: "engagement_type.list",
  summary: "Engagement types with their margin floors",
  permission: "pricing.view",
  input: z.object({}).default({}),
  exposeTo: ["web", "mcp"],
  run: (ctx) => ctx.tx.selectFrom("engagement_types").selectAll().orderBy("label_en").execute(),
});

export const projectTypeList = defineQuery({
  name: "project_type.list",
  summary: "Project types",
  permission: "pricing.view",
  input: z.object({}).default({}),
  exposeTo: ["web", "mcp"],
  run: (ctx) => ctx.tx.selectFrom("project_types").selectAll().orderBy("label_en").execute(),
});

export const rateCardList = defineQuery({
  name: "rate_card.list",
  summary: "Rate cards",
  permission: "pricing.view",
  input: z.object({}).default({}),
  exposeTo: ["web", "mcp"],
  run: (ctx) => ctx.tx.selectFrom("rate_cards").selectAll().orderBy("name").execute(),
});

export const rateCardGet = defineQuery({
  name: "rate_card.get",
  summary: "A rate card and its items (costs only for finance.view_costs holders)",
  permission: "pricing.view",
  input: ByIdInput,
  exposeTo: ["web", "mcp"],
  async run(ctx, i) {
    const card = notFoundIfMissing(await ctx.tx.selectFrom("rate_cards").selectAll().where("id", "=", i.id).executeTakeFirst());
    const items = await ctx.tx
      .selectFrom("rate_card_items")
      .selectAll()
      .where("rate_card_id", "=", i.id)
      .orderBy("service_code")
      .execute();
    // COM-CF-04: rate-card costs are internal cost rates.
    const showCost = can(ctx.actor, "finance.view_costs");
    return {
      ...card,
      items: items.map((it) => ({
        ...it,
        unit_price_minor: it.unit_price_minor.toString(),
        unit_cost_minor: showCost ? it.unit_cost_minor.toString() : null,
      })),
    };
  },
});

/** "4102.5" → 4102500000 (riel per USD × 10⁶), no floats. */
export function parseRateMicros(s: string): bigint {
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole! + frac.padEnd(6, "0"));
}

export const fxRateSet = defineCommand({
  name: "fx_rate.set",
  summary: "Enter the USD→KHR rate for a date (Finance)",
  permission: "fx.manage",
  input: FxRateSetInput,
  exposeTo: ["web"],
  async run(ctx, i) {
    const micros = parseRateMicros(i.khrPerUsd);
    if (micros <= 0n) throw new DomainError("VALIDATION", { issues: [{ path: "khrPerUsd", message: "Must be positive" }] });
    const entered_by = ctx.actor.type === "user" ? ctx.actor.id : null;
    return ctx.tx
      .insertInto("fx_rates")
      .values({ rate_date: i.rateDate, rate_micros: micros, entered_by })
      .onConflict((oc) =>
        oc
          .columns(["rate_date", "base", "quote"])
          .doUpdateSet((eb) => ({ rate_micros: micros, entered_by, version: eb("fx_rates.version", "+", 1) })),
      )
      .returning(["id", "rate_date", "version"])
      .executeTakeFirstOrThrow();
  },
  subject: (_i, r) => ({ type: "fx_rate", id: r.id }),
});

export const fxRateList = defineQuery({
  name: "fx_rate.list",
  summary: "Recent USD→KHR rates",
  permission: "pricing.view",
  input: FxRateListInput,
  exposeTo: ["web", "mcp"],
  async run(ctx, i) {
    const rows = await ctx.tx.selectFrom("fx_rates").selectAll().orderBy("rate_date", "desc").limit(i.limit).execute();
    return rows.map((r) => ({ ...r, rate_micros: r.rate_micros.toString() }));
  },
});

export const FX_MAX_AGE_DAYS = 5;

/** COM-CF-06: latest rate dated within FX_MAX_AGE_DAYS calendar days before `day`, or null. */
export async function currentFxRate(ctx: Ctx, day = businessDate(ctx.now)) {
  const row = await ctx.tx
    .selectFrom("fx_rates")
    .select(["rate_date", "rate_micros"])
    .where("rate_date", "<=", day)
    .where("rate_date", ">=", addDays(day, -FX_MAX_AGE_DAYS))
    .orderBy("rate_date", "desc")
    .limit(1)
    .executeTakeFirst();
  return row ? { rateDate: row.rate_date, rateMicros: row.rate_micros } : null;
}
