import { z } from "zod";
import { normalizeText } from "../i18n";

export const uuid = z.string().uuid();
export const text = (max = 500) =>
  z
    .string()
    .max(max)
    .transform((s) => normalizeText(s));
export const requiredText = (max = 500) =>
  text(max).refine((s) => s.length > 0, { message: "Required" });
export const optionalText = (max = 500) =>
  z
    .string()
    .max(max)
    .transform((s) => normalizeText(s))
    .transform((s) => (s.length ? s : null))
    .nullish();
export const expectedVersion = z.number().int().positive();
export const currency = z.enum(["USD", "KHR"]);
/** Money travels as a decimal string of minor units ("123450" = $1,234.50) — never a float. */
export const minorUnits = z
  .string()
  .regex(/^\d{1,15}$/, "Minor units as a whole-number string")
  .transform((s) => BigInt(s));
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
