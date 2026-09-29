// The weekly timesheet card's one-tap Confirm button (plan §5.2 `/week`). Spec: specs/time/timesheets.md (TIM-TS-09)
// Same guarantees as approval buttons (TG-04): opaque, single use, bound to one Telegram user, expiring — and bound to
// the hash of the draft it shows, so a changed draft is never confirmed blind.
import { sql } from "kysely";
import { loadActor } from "../identity";
import { randomToken, setActorContext, type JobActor, type Kernel } from "../kernel";
import { ACTION_TTL_MS, telegramIdFor } from "../telegram";

const BOT: JobActor = { type: "job", name: "telegram:bot", grants: [] };

interface Payload {
  userId: string;
  weekStart: string;
  draftHash: string;
}

export async function issueTimesheetConfirm(
  kernel: Kernel,
  a: { userId: string; telegramUserId: number; weekStart: string; draftHash: string },
): Promise<string> {
  const now = kernel.clock();
  const token = randomToken(12);
  await kernel.db.transaction().execute(async (tx) => {
    await setActorContext(tx, { actor: BOT, channel: "telegram", requestId: `tg_week_${a.weekStart}`, locale: "en" });
    // One live Confirm per person and week: older cards stop working.
    await tx
      .updateTable("telegram_actions")
      .set({ used_at: now })
      .where("kind", "=", "timesheet_confirm")
      .where("user_id", "=", a.userId)
      .where("used_at", "is", null)
      .where(sql<boolean>`payload->>'weekStart' = ${a.weekStart}`)
      .execute();
    await tx
      .insertInto("telegram_actions")
      .values({
        token,
        kind: "timesheet_confirm",
        approval_id: null,
        user_id: a.userId,
        telegram_user_id: a.telegramUserId,
        decision: "confirm",
        subject_version: 0,
        payload: JSON.stringify({ userId: a.userId, weekStart: a.weekStart, draftHash: a.draftHash } satisfies Payload),
        expires_at: new Date(now.getTime() + ACTION_TTL_MS),
      })
      .execute();
  });
  return token;
}

export type TimesheetConsumeResult =
  | { ok: true; weekStart: string; draftHash: string; user: NonNullable<Awaited<ReturnType<typeof loadActor>>> }
  | { ok: false; reason: "unknown" | "wrong_user" | "used" | "expired" };

/** Atomically consume a Confirm token: only its Telegram user, once, before expiry, while still linked. */
export async function consumeTimesheetConfirm(
  kernel: Kernel,
  token: string,
  fromTelegramId: number,
): Promise<TimesheetConsumeResult> {
  const now = kernel.clock();
  const row = await kernel.db.selectFrom("telegram_actions").selectAll().where("token", "=", token).executeTakeFirst();
  if (!row || row.kind !== "timesheet_confirm" || !row.payload) return { ok: false, reason: "unknown" };
  if (Number(row.telegram_user_id) !== fromTelegramId) return { ok: false, reason: "wrong_user" };
  if (row.used_at) return { ok: false, reason: "used" };
  if (row.expires_at <= now) return { ok: false, reason: "expired" };
  const p = row.payload as unknown as Payload;
  if (p.userId !== row.user_id) return { ok: false, reason: "unknown" };
  const user = await loadActor(kernel, row.user_id);
  const won = await kernel.db.transaction().execute(async (tx) => {
    await setActorContext(tx, {
      actor: user?.actor ?? BOT,
      channel: "telegram",
      requestId: `tg_press_${token.slice(0, 6)}`,
      locale: "en",
    });
    return tx
      .updateTable("telegram_actions")
      .set({ used_at: now })
      .where("token", "=", token)
      .where("used_at", "is", null)
      .returning("token")
      .executeTakeFirst();
  });
  if (!won) return { ok: false, reason: "used" };
  if (!user || (await telegramIdFor(kernel, row.user_id)) !== fromTelegramId) return { ok: false, reason: "wrong_user" };
  return { ok: true, weekStart: p.weekStart, draftHash: p.draftHash, user };
}
