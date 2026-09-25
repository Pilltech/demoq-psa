import { z } from "zod";
import { requiredText, optionalText, uuid, expectedVersion, currency, minorUnits, isoDate } from "./common";

export const DEAL_STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"] as const;
export type DealStage = (typeof DEAL_STAGES)[number];
export const OPEN_STAGES = ["lead", "qualified", "proposal", "negotiation"] as const;
export type OpenStage = (typeof OPEN_STAGES)[number];

export const ClientCreateInput = z.object({
  name: requiredText(200),
  nameKm: optionalText(200),
  accountLeadId: uuid.optional(),
  teamId: uuid.nullish(),
  industry: optionalText(120),
});
export const ClientUpdateInput = z.object({
  id: uuid,
  expectedVersion,
  name: requiredText(200).optional(),
  nameKm: optionalText(200),
  accountLeadId: uuid.optional(),
  teamId: uuid.nullish(),
  industry: optionalText(120),
  archived: z.boolean().optional(),
});
export const ClientListInput = z.object({
  search: z.string().max(100).optional(),
  includeArchived: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
});
export const ByIdInput = z.object({ id: uuid });

export const ContactCreateInput = z.object({
  clientId: uuid,
  fullName: requiredText(160),
  title: optionalText(120),
  email: z.string().email().max(254).nullish(),
  phone: optionalText(40),
  telegram: optionalText(64),
  isPrimary: z.boolean().default(false),
});
export const ContactUpdateInput = z.object({
  id: uuid,
  expectedVersion,
  fullName: requiredText(160).optional(),
  title: optionalText(120),
  email: z.string().email().max(254).nullish(),
  phone: optionalText(40),
  telegram: optionalText(64),
  isPrimary: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export const DealCreateInput = z.object({
  clientId: uuid,
  title: requiredText(200),
  ownerId: uuid.optional(),
  expectedValueMinor: minorUnits.nullish(),
  currency: currency.default("USD"),
  expectedCloseOn: isoDate.nullish(),
});
export const DealMoveInput = z.object({
  id: uuid,
  expectedVersion,
  toStage: z.enum(DEAL_STAGES),
  closeReasonCode: z.string().max(64).nullish(),
  note: optionalText(1000),
});
export const DealReopenInput = z.object({
  id: uuid,
  expectedVersion,
  reason: requiredText(1000),
});
export const DealListInput = z.object({
  clientId: uuid.optional(),
  ownerId: uuid.optional(),
  includeClosed: z.boolean().default(true),
});
export const AuditTimelineInput = z.object({
  subjectType: z.enum(["client", "contact", "deal", "user", "team"]),
  subjectId: uuid,
  limit: z.number().int().min(1).max(200).default(100),
});
