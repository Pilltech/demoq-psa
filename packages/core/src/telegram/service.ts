// Telegram linking and single-use button tokens. Spec: specs/channels/telegram.md (TG-02, TG-04, TG-05)
// The HTTP/Bot-API side lives in apps/api/src/adapters/telegram; this is the DB side.
import type { Role } from "@demoq/shared";
import { randomToken, setActorContext, sha256, writeAudit, type Kernel, type RequestMeta, type UserActor } from "../kernel";

export const ACTION_TTL_MS = 24 * 3600_000;

export interface TelegramUser {
  actor: UserActor;
  locale: "en" | "km";
}

async function actorFor(kernel: Kernel, userId: string): Promise<TelegramUser | null> {
  const u = await kernel.db.selectFrom("users").select(["id", "display_name", "team_id", "locale", "active"]).where("id", "=", userId).executeTakeFirst();
  if (!u?.active) return null;
  const roles = (await kernel.db.selectFrom("user_roles").select("role").where("user_id", "=", u.id).execute()).map((r) => r.role as Role);
  return { actor: { type: "user", id: u.id, name: u.display_name, roles, teamId: u.team_id }, locale: u.locale as "en" | "km" };
}

export async function userByTelegramId(kernel: Kernel, telegramUserId: number): Promise<TelegramUser | null> {
  const u = await kernel.db.selectFrom("users").select("id").where("telegram_user_id", "=", BigInt(telegramUserId)).executeTakeFirst();
  return u ? actorFor(kernel, u.id) : null;
}

export async function telegramIdFor(kernel: Kernel, userId: string): Promise<number | null> {
  const u = await kernel.db.selectFrom("users").select("telegram_user_id").where("id", "=", userId).where("active", "=", true).executeTakeFirst();
  return u?.telegram_user_id ? Number(u.telegram_user_id) : null;
}

/** TG-02: `/start <code>` — one use, 10 minutes. Returns the linked user, or null. */
export async function linkByCode(
  kernel: Kernel,
  code: string,
  telegramUserId: number,
  meta: Omit<RequestMeta, "actor">,
): Promise<TelegramUser | null> {
  const now = kernel.clock();
  const linked = await kernel.db.transaction().execute(async (tx) => {
    const row = await tx
      .updateTable("telegram_link_codes")
      .set({ used_at: now })
      .where("code_hash", "=", sha256(code.trim().toUpperCase()))
      .where("used_at", "is", null)
      .where("expires_at", ">", now)
      .returning("user_id")
      .executeTakeFirst();
    if (!row) return null;
    const who = await tx.selectFrom("users").select(["id", "display_name"]).where("id", "=", row.user_id).executeTakeFirstOrThrow();
    const fullMeta: RequestMeta = { ...meta, actor: { type: "user", id: who.id, name: who.display_name, roles: [], teamId: null } };
    await setActorContext(tx, fullMeta);
    // One Telegram account ↔ one staff account.
    await tx.updateTable("users").set({ telegram_user_id: null }).where("telegram_user_id", "=", BigInt(telegramUserId)).execute();
    await tx.updateTable("users").set({ telegram_user_id: telegramUserId }).where("id", "=", who.id).execute();
    await writeAudit(tx, fullMeta, { action: "telegram.linked", subject: { type: "user", id: who.id } });
    return who.id;
  });
  return linked ? actorFor(kernel, linked) : null;
}

export type ActionDecision = "approve" | "reject" | "confirm_approve";

/** TG-04: opaque, single-use, bound to one Telegram user and one approval. */
export async function issueActions(
  kernel: Kernel,
  a: { approvalId: string; userId: string; telegramUserId: number; subjectVersion: number },
  decisions: ActionDecision[],
): Promise<Record<ActionDecision, string>> {
  const expires = new Date(kernel.clock().getTime() + ACTION_TTL_MS);
  const out = {} as Record<ActionDecision, string>;
  for (const d of decisions) {
    const token = randomToken(12); // 16 chars base64url; callback_data "a:<token>" stays well under 64 bytes
    await kernel.db
      .insertInto("telegram_actions")
      .values({ token, approval_id: a.approvalId, user_id: a.userId, telegram_user_id: a.telegramUserId, decision: d, subject_version: a.subjectVersion, expires_at: expires })
      .execute();
    out[d] = token;
  }
  return out;
}

export type ConsumeResult =
  | { ok: true; approvalId: string; decision: ActionDecision; user: TelegramUser }
  | { ok: false; reason: "unknown" | "wrong_user" | "used" | "expired" | "stale" };

/** Atomically consume a button token; only the intended Telegram user, once, before expiry. */
export async function consumeAction(kernel: Kernel, token: string, fromTelegramId: number): Promise<ConsumeResult> {
  const now = kernel.clock();
  const row = await kernel.db.selectFrom("telegram_actions").selectAll().where("token", "=", token).executeTakeFirst();
  if (!row) return { ok: false, reason: "unknown" };
  if (Number(row.telegram_user_id) !== fromTelegramId) return { ok: false, reason: "wrong_user" };
  if (row.used_at) return { ok: false, reason: "used" };
  if (row.expires_at <= now) return { ok: false, reason: "expired" };
  const won = await kernel.db
    .updateTable("telegram_actions")
    .set({ used_at: now })
    .where("token", "=", token)
    .where("used_at", "is", null)
    .returning("token")
    .executeTakeFirst();
  if (!won) return { ok: false, reason: "used" };
  // Burn the sibling buttons of the same card too: a card is decided once.
  await kernel.db
    .updateTable("telegram_actions")
    .set({ used_at: now })
    .where("approval_id", "=", row.approval_id)
    .where("user_id", "=", row.user_id)
    .where("used_at", "is", null)
    .where("decision", "<>", "confirm_approve")
    .execute();
  const approval = await kernel.db.selectFrom("approvals").select(["subject_version"]).where("id", "=", row.approval_id).executeTakeFirst();
  if (!approval || approval.subject_version !== row.subject_version) return { ok: false, reason: "stale" };
  // Re-check the account: still linked to this Telegram id and active.
  const user = await actorFor(kernel, row.user_id);
  const stillLinked = await telegramIdFor(kernel, row.user_id);
  if (!user || stillLinked !== fromTelegramId) return { ok: false, reason: "wrong_user" };
  return { ok: true, approvalId: row.approval_id, decision: row.decision as ActionDecision, user };
}

