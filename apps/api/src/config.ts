import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default("0.0.0.0"),
  TOTP_ENC_KEY: z
    .string()
    .refine((s) => Buffer.from(s, "base64").length === 32, "TOTP_ENC_KEY must be 32 bytes, base64 (openssl rand -base64 32)"),
  WEB_DIST: z.string().optional(),
  LOGIN_RATE_PER_MIN: z.coerce.number().int().default(10),
  /** Number of reverse-proxy hops in front of the API (prod: Cloudflare + DO = 2). 0 = use the socket address. */
  /** Telegram bot (optional in dev): token from @BotFather and the webhook secret header value. */
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),
  /** PRJ-BP-05: the person (CEO or ops lead) in whose name the monthly bypass review is requested. */
  BYPASS_REVIEW_REQUESTER_ID: z.string().uuid().optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

  // --- MCP OAuth (specs/channels/mcp-oauth.md). All optional so existing configs stay valid; defaults in oauth/config.ts.
  /** Public origin of this API, no trailing slash (default http://localhost:$PORT). The OAuth issuer; the MCP resource is `<it>/mcp`. */
  PUBLIC_BASE_URL: z.string().url().optional(),
  /** Comma-separated secrets (≥ 32 chars each) signing the OAuth interaction cookies; the first one signs. Required in production. */
  OAUTH_COOKIE_KEYS: z.string().optional(),
  /** JSON Web Key Set with private keys (ID tokens). Required in production; dev/test generate one at start. */
  OAUTH_JWKS: z.string().optional(),
  /** D-MC-1: the pre-registered Cowork / claude.ai custom-connector client (default demoq-cowork). */
  MCP_COWORK_CLIENT_ID: z.string().min(8).optional(),
  /** Its redirect URI (default https://claude.ai/api/mcp/auth_callback). */
  MCP_COWORK_REDIRECT_URI: z.string().url().optional(),
  /** Dev/test only: accept http:// CIMD URLs on 127.0.0.1/localhost (a local test server). Refused in production. */
  OAUTH_DEV_ALLOW_HTTP_CIMD: z.enum(["true", "false"]).optional(),
  /** Requests per minute per IP on /oauth/* (default 120; the sign-in form also has LOGIN_RATE_PER_MIN). */
  OAUTH_RATE_PER_MIN: z.coerce.number().int().positive().optional(),
});
export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === "production") {
    const problems: string[] = [];
    if (!cfg.PUBLIC_BASE_URL?.startsWith("https://")) problems.push("PUBLIC_BASE_URL (https) is required in production");
    const keys = (cfg.OAUTH_COOKIE_KEYS ?? "").split(",").filter(Boolean);
    if (!keys.length || keys.some((k) => k.length < 32)) problems.push("OAUTH_COOKIE_KEYS: one or more secrets of ≥ 32 chars");
    if (!cfg.OAUTH_JWKS) problems.push("OAUTH_JWKS is required in production");
    if (cfg.OAUTH_DEV_ALLOW_HTTP_CIMD === "true") problems.push("OAUTH_DEV_ALLOW_HTTP_CIMD must be false in production");
    if (problems.length) throw new Error(`Invalid configuration:\n${problems.join("\n")}`);
  }
  return cfg;
}
