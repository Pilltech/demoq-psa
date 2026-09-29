import { z } from "zod";
import { currency, expectedVersion, isoDate, minorUnits, optionalText, requiredText, uuid } from "./common";

const code = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "lowercase_code")
  .max(40);
const bp = z.number().int().min(0).max(10_000);

export const EngagementTypeUpsertInput = z.object({
  id: uuid.optional(),
  expectedVersion: expectedVersion.optional(),
  code,
  labelEn: requiredText(80),
  labelKm: requiredText(80),
  commercialModel: z.enum(["retainer", "campaign", "one_off", "influencer_program"]),
  feeMarginFloorBp: bp.default(2500),
  passthroughMarkupFloorBp: bp.nullable().default(null),
  passthroughMarkupWarnBp: bp.default(1000),
  active: z.boolean().default(true),
});
export const ProjectTypeUpsertInput = z.object({
  id: uuid.optional(),
  expectedVersion: expectedVersion.optional(),
  code,
  labelEn: requiredText(80),
  labelKm: requiredText(80),
  defaultEngagementTypeId: uuid,
  active: z.boolean().default(true),
});
export const RateCardUpsertInput = z.object({
  id: uuid.optional(),
  expectedVersion: expectedVersion.optional(),
  name: requiredText(120),
  currency,
  active: z.boolean().default(true),
});
export const RateCardItemUpsertInput = z.object({
  id: uuid.optional(),
  expectedVersion: expectedVersion.optional(),
  rateCardId: uuid,
  serviceCode: z
    .string()
    .regex(/^[A-Z0-9][A-Z0-9_-]*$/)
    .max(40),
  kind: z.enum(["fee", "pass_through"]),
  labelEn: requiredText(160),
  labelKm: requiredText(160),
  unit: z.enum(["hour", "day", "item", "post", "month", "lump"]),
  unitPriceMinor: minorUnits,
  /** Required for a new item; omit on update to keep the stored cost. */
  unitCostMinor: minorUnits.optional(),
  active: z.boolean().default(true),
});
/** Riel per USD as a decimal string, e.g. "4100" or "4102.5" (≤ 6 decimals). */
export const FxRateSetInput = z.object({
  rateDate: isoDate,
  khrPerUsd: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/, "Riel per USD, e.g. 4100"),
});
export const FxRateListInput = z.object({ limit: z.number().int().min(1).max(60).default(14) });

// Bounds keep qty × price far inside bigint: 10,000 units × 10¹² minor units.
const qtyMilli = z.number().int().min(1).max(10_000_000);
const unitMinor = z
  .string()
  .regex(/^\d{1,12}$/, "Minor units as a whole-number string (max 12 digits)")
  .transform((s) => BigInt(s));
export const QuoteLineInput = z.object({
  kind: z.enum(["fee", "pass_through"]),
  rateCardItemId: uuid.nullish(),
  descriptionEn: requiredText(500),
  descriptionKm: optionalText(500),
  qtyMilli,
  unitPriceMinor: unitMinor,
  /** Omitted → the rate-card item's cost (COM-QB-13), else 0. */
  unitCostMinor: unitMinor.nullish(),
  discountBp: bp.default(0),
  perPeriod: z.boolean().default(false),
  quotedMinutes: z.number().int().min(0).max(1_000_000).nullish(),
});
export type QuoteLineIn = z.infer<typeof QuoteLineInput>;

export const QuoteCreateInput = z.object({
  dealId: uuid,
  title: requiredText(200),
  currency: currency.default("USD"),
  engagementTypeId: uuid,
  projectTypeId: uuid.nullish(),
  rateCardId: uuid.nullish(),
  billingModel: z.enum(["one_off", "retainer"]).default("one_off"),
  periodMonths: z.number().int().min(1).max(36).nullish(),
});
export const QuoteSaveInput = z.object({
  id: uuid,
  expectedVersion,
  title: requiredText(200).optional(),
  engagementTypeId: uuid.optional(),
  projectTypeId: uuid.nullish(),
  billingModel: z.enum(["one_off", "retainer"]).optional(),
  periodMonths: z.number().int().min(1).max(36).nullish(),
  validUntil: isoDate.nullish(),
  terms: optionalText(4000),
  lines: z.array(QuoteLineInput).max(200).optional(),
});
export const QuoteSubmitInput = z.object({ id: uuid, expectedVersion, sendOnApproval: z.boolean().default(false) });
export const QuoteSendInput = z.object({ id: uuid, expectedVersion });
export const QuoteReviseInput = z.object({ id: uuid });
export const QuoteRejectInput = z.object({ id: uuid, expectedVersion, reason: requiredText(1000) });
export const QuoteListInput = z.object({ dealId: uuid });

/**
 * Out-of-scope approvals have three outcomes (plan §5.4): absorb (= approve), change_order or reject (both = reject).
 * Other kinds take no outcome. APR-EN-13.
 */
export const OOS_OUTCOMES = ["absorb", "change_order", "reject"] as const;
export type OosOutcome = (typeof OOS_OUTCOMES)[number];
export const ApprovalDecideInput = z.object({
  id: uuid,
  decision: z.enum(["approve", "reject"]),
  outcome: z.enum(OOS_OUTCOMES).optional(),
  note: optionalText(1000),
});
export const ApprovalInboxInput = z.object({ include: z.enum(["pending", "recent"]).default("pending") });
