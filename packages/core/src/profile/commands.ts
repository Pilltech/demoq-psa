// My profile: Telegram linking and personal access tokens for MCP.
// Specs: specs/channels/telegram.md (TG-02), specs/channels/mcp.md (MCP-03, MCP-04)
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { requiredText, uuid, TOTP_REQUIRED_ROLES } from "@demoq/shared";
import { defineCommand, defineQuery, DomainError, randomToken, sha256, type Ctx } from "../kernel";

export const TELEGRAM_CODE_TTL_MS = 10 * 60_000;
export const PAT_PREFIX = "dq_pat_";
export const PAT_MAX_DAYS = 30;

const me = (ctx: Ctx) => {
  if (ctx.actor.type !== "user") throw new DomainError("FORBIDDEN");
  return ctx.actor;
};

export const telegramLinkCode = defineCommand({
  name: "telegram.link_code",
  summary: "Get a one-time code to link my Telegram account (valid 10 minutes)",
  permission: "profile.manage",
  input: z.object({}).default({}),
  exposeTo: ["web"],
  async run(ctx) {
    const user = me(ctx);
    // 10 chars of an unambiguous alphabet: typed into /start on a phone.
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const code = [...randomBytes(10)].map((b) => alphabet[b % alphabet.length]).join("");
    await ctx.tx
      .insertInto("telegram_link_codes")
      .values({ user_id: user.id, code_hash: sha256(code), expires_at: new Date(ctx.now.getTime() + TELEGRAM_CODE_TTL_MS) })
      .execute();
    return { code, expiresAt: new Date(ctx.now.getTime() + TELEGRAM_CODE_TTL_MS) };
  },
  subject: (_i, _r) => undefined,
});

export const telegramUnlink = defineCommand({
  name: "telegram.unlink",
  summary: "Unlink my Telegram account",
  permission: "profile.manage",
  input: z.object({}).default({}),
  exposeTo: ["web"],
  async run(ctx) {
    const user = me(ctx);
    await ctx.tx.updateTable("users").set({ telegram_user_id: null }).where("id", "=", user.id).execute();
    return { linked: false };
  },
});

export const profileGet = defineQuery({
  name: "profile.get",
  summary: "My profile: Telegram link status and my access tokens",
  permission: "profile.manage",
  input: z.object({}).default({}),
  exposeTo: ["web"],
  rowFiltered: true,
  async run(ctx) {
    const user = me(ctx);
    const u = await ctx.tx.selectFrom("users").select(["telegram_user_id"]).where("id", "=", user.id).executeTakeFirstOrThrow();
    const tokens = await ctx.tx
      .selectFrom("api_tokens")
      .select(["id", "label", "prefix", "scopes", "expires_at", "revoked_at", "last_used_at", "created_at"])
      .where("user_id", "=", user.id)
      .orderBy("created_at", "desc")
      .execute();
    return { telegramLinked: u.telegram_user_id !== null, tokens, readOnlyTokens: user.roles.some((r) => TOTP_REQUIRED_ROLES.includes(r)) };
  },
});

export const tokenCreate = defineCommand({
  name: "token.create",
  summary: "Create a personal access token for Claude Code / MCP (shown once)",
  permission: "profile.manage",
  input: z.object({
    label: requiredText(80),
    scopes: z.array(z.enum(["read", "write"])).min(1).default(["read"]),
    days: z.number().int().min(1).max(PAT_MAX_DAYS).default(PAT_MAX_DAYS),
  }),
  exposeTo: ["web"],
  async run(ctx, i) {
    const user = me(ctx);
    // MCP-04: privileged roles get read-only tokens.
    if (i.scopes.includes("write") && user.roles.some((r) => TOTP_REQUIRED_ROLES.includes(r))) {
      throw new DomainError("FORBIDDEN", { reason: "privileged_roles_read_only" });
    }
    const token = `${PAT_PREFIX}${randomToken(32)}`;
    const row = await ctx.tx
      .insertInto("api_tokens")
      .values({
        user_id: user.id,
        label: i.label,
        token_hash: sha256(token),
        prefix: token.slice(0, 12),
        scopes: [...new Set(i.scopes)],
        created_at: ctx.now,
        expires_at: new Date(ctx.now.getTime() + i.days * 86_400_000),
      })
      .returning(["id", "expires_at"])
      .executeTakeFirstOrThrow();
    return { id: row.id, token, expiresAt: row.expires_at };
  },
  subject: (_i, r) => ({ type: "api_token", id: r.id }),
});

export const tokenRevoke = defineCommand({
  name: "token.revoke",
  summary: "Revoke one of my access tokens",
  permission: "profile.manage",
  input: z.object({ id: uuid }),
  exposeTo: ["web"],
  async run(ctx, i) {
    const user = me(ctx);
    const r = await ctx.tx
      .updateTable("api_tokens")
      .set({ revoked_at: ctx.now })
      .where("id", "=", i.id)
      .where("user_id", "=", user.id)
      .where("revoked_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!r) throw new DomainError("NOT_FOUND");
    return { id: r.id, revoked: true };
  },
  subject: (i) => ({ type: "api_token", id: i.id }),
});
