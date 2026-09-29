// Influencer roster, assignments and the public work-log link. Spec: specs/influencers/links.md (INF-*)
// Shared so the PWA's public page (/l/:token) validates exactly what the API accepts.
import { z } from "zod";
import { isoDate, optionalText } from "./common";

export const INFLUENCER_PLATFORMS = ["tiktok", "facebook", "instagram", "youtube", "telegram", "x", "other"] as const;
export type InfluencerPlatform = (typeof INFLUENCER_PLATFORMS)[number];

/** D13: link defaults. Staff may shorten or lengthen within the bounds. */
export const LINK_DEFAULT_EXPIRES_DAYS = 7;
export const LINK_MAX_EXPIRES_DAYS = 30;
export const LINK_DEFAULT_MAX_SUBMISSIONS = 10;
export const LINK_MAX_SUBMISSIONS = 50;
/** D-IN-1: the post URL plus up to 5 proof links, until file uploads land with R2. */
export const LINK_MAX_PROOF_URLS = 5;
export const LINK_NOTE_MAX = 1000;
export const LINK_URL_MAX = 2000;
export const LINK_METRIC_KEYS = ["views", "likes", "comments", "shares", "saves", "reach"] as const;
export type LinkMetricKey = (typeof LINK_METRIC_KEYS)[number];

/** A token as issued: 32 random bytes, base64url (43 characters). Anything else is not a link. */
export const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Absolute http(s) URL, no credentials, no whitespace or control characters. Returns the normalised href. */
export function normalizeHttpUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > LINK_URL_MAX || /\s/.test(s) || [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f))
    return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname || u.username || u.password) return null;
  return u.href.length <= LINK_URL_MAX ? u.href : null;
}

export const httpUrl = z
  .string()
  .max(LINK_URL_MAX)
  .transform((s, ctx) => {
    const href = normalizeHttpUrl(s);
    if (!href) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "An http(s) link" });
      return z.NEVER;
    }
    return href;
  });

/** A real calendar date (2026-02-31 is refused). */
export const calendarDate = isoDate.refine((d) => {
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}, "Not a calendar date");

const count = z.number().int().min(0).max(1_000_000_000_000);
export const LinkMetrics = z
  .object(
    Object.fromEntries(LINK_METRIC_KEYS.map((k) => [k, count.optional()])) as Record<LinkMetricKey, z.ZodOptional<typeof count>>,
  )
  .strict();

/** What an influencer sends through a link. Unknown fields are refused. */
export const LinkSubmissionInput = z
  .object({
    postUrl: httpUrl,
    postedOn: calendarDate,
    metrics: LinkMetrics.default({}),
    proofUrls: z.array(httpUrl).max(LINK_MAX_PROOF_URLS).default([]),
    note: optionalText(LINK_NOTE_MAX),
  })
  .strict();
export type LinkSubmission = z.input<typeof LinkSubmissionInput>;
