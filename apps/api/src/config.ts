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
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
});
export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  return parsed.data;
}
