import type { ErrorCode } from "../errors";
import errorsEn from "./errors.en.json" with { type: "json" };
import errorsKm from "./errors.km.json" with { type: "json" };

export type Locale = "en" | "km";
export const LOCALES: readonly Locale[] = ["en", "km"];

// Khmer strings prefixed KM-DRAFT: are machine drafts awaiting the Khmer reviewer.
// The prefix is stripped for display; `pnpm i18n:drafts` lists them.
const KM_DRAFT = /^KM-DRAFT:\s*/;

export const errorMessages: Record<Locale, Record<ErrorCode, string>> = {
  en: errorsEn as Record<ErrorCode, string>,
  km: errorsKm as Record<ErrorCode, string>,
};

export function errorMessage(code: ErrorCode, locale: Locale): string {
  return (errorMessages[locale][code] ?? errorMessages.en[code] ?? code).replace(KM_DRAFT, "");
}

export function isKmDraft(s: string): boolean {
  return KM_DRAFT.test(s);
}

/** NFC-normalise user text so Khmer compares and searches consistently. */
export function normalizeText(s: string): string {
  return s.normalize("NFC").trim();
}

export * from "./link";
