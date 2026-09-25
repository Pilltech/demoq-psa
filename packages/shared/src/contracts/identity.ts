import { z } from "zod";
import { requiredText, optionalText, uuid, expectedVersion } from "./common";

export const ROLES = [
  "ceo",
  "director",
  "ops_lead",
  "finance",
  "account_lead",
  "project_manager",
  "team_lead",
  "staff",
  "influencer_manager",
  "admin",
  "viewer",
] as const;
export type Role = (typeof ROLES)[number];
export const role = z.enum(ROLES);

/** Roles that must use TOTP on every login (plan §3.2 Auth). */
export const TOTP_REQUIRED_ROLES: readonly Role[] = ["ceo", "director", "ops_lead", "finance", "admin"];

export const LoginInput = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});
export const TotpCodeInput = z.object({ code: z.string().regex(/^\d{6}$/) });

export const PASSWORD_MIN = 12;
export const UserCreateInput = z.object({
  email: z.string().email().max(254),
  displayName: requiredText(120),
  displayNameKm: optionalText(120),
  locale: z.enum(["en", "km"]).default("en"),
  teamId: uuid.nullish(),
  managerId: uuid.nullish(),
  roles: z.array(role).min(1),
  initialPassword: z.string().min(PASSWORD_MIN).max(200),
});
export const UserSetRolesInput = z.object({ userId: uuid, expectedVersion, roles: z.array(role) });
export const TeamCreateInput = z.object({ name: requiredText(80), nameKm: optionalText(80) });
export const UserSetLocaleInput = z.object({ locale: z.enum(["en", "km"]) });
