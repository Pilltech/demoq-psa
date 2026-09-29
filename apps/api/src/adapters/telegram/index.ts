// Telegram adapter: webhook, linking, /inbox, approval buttons. Spec: specs/channels/telegram.md
// Business rules stay in core: decisions run approval.decide through execute() with channel "telegram".
import type { FastifyInstance } from "fastify";
import { approvals, DomainError, execute, telegram, type Kernel } from "@demoq/core";
import { errorMessage } from "@demoq/shared";
import { esc, renderCard, tg, type BotApi, type CardDto } from "./bot";
import { handleTimeCallback, handleTimeCommand, tgTime } from "./time";

export * from "./bot";
export * from "./time";

interface TgUser {
  id: number;
}
interface Update {
  update_id: number;
  message?: { message_id: number; chat: { id: number; type: string }; from?: TgUser; text?: string };
  callback_query?: {
    id: string;
    from: TgUser;
    data?: string;
    message?: { message_id: number; chat: { id: number; type: string } };
  };
}

type InboxItem = CardDto & { id: string; canDecide: boolean; version: number };

const TWO_TAP_KINDS = new Set(["margin_floor", "gate_bypass"]); // TG-05

/** Send one approval card with fresh single-use buttons to a linked user (TG-03, TG-08). */
export async function sendApprovalCard(kernel: Kernel, bot: BotApi, userId: string, approvalId: string, requestId: string) {
  const chatId = await telegram.telegramIdFor(kernel, userId);
  if (!chatId) return false;
  const who = await telegram.userByTelegramId(kernel, chatId);
  if (!who) return false;
  let card: InboxItem & { subjectVersion?: number };
  try {
    card = (await execute(
      kernel,
      { actor: who.actor, channel: "telegram", requestId, locale: who.locale },
      approvals.approvalGet,
      { id: approvalId },
    )) as InboxItem;
  } catch {
    return false; // not theirs to see (any more)
  }
  if (!card.canDecide) return false;
  const s = tg(who.locale);
  if (card.kind === "out_of_scope") {
    // TSK-DL-13: Absorb / Change order / Reject, each a single-use button carrying its outcome (APR-EN-13).
    const o = await telegram.issueOutcomeActions(kernel, { approvalId, userId, telegramUserId: chatId });
    await bot.sendMessage(chatId, renderCard(card, who.locale), {
      buttons: [
        [
          { text: s.absorb, callback_data: `a:${o.absorb}` },
          { text: s.changeOrder, callback_data: `a:${o.change_order}` },
          { text: s.reject, callback_data: `a:${o.reject}` },
        ],
      ],
    });
    return true;
  }
  const tokens = await telegram.issueActions(kernel, { approvalId, userId, telegramUserId: chatId }, ["approve", "reject"]);
  await bot.sendMessage(chatId, renderCard(card, who.locale), {
    buttons: [
      [
        { text: s.approve, callback_data: `a:${tokens.approve}` },
        { text: s.reject, callback_data: `a:${tokens.reject}` },
      ],
    ],
  });
  return true;
}

export async function registerTelegramAdapter(
  app: FastifyInstance,
  kernel: Kernel,
  bot: BotApi | null,
  secret: string | undefined,
) {
  if (!bot || !secret) return; // not configured: the route does not exist

  app.post("/telegram/webhook", async (req, reply) => {
    // TG-01
    if (req.headers["x-telegram-bot-api-secret-token"] !== secret) return reply.code(401).send({ ok: false });
    const u = req.body as Update;
    try {
      if (u.message) await onMessage(u.message, req.id);
      else if (u.callback_query) await onCallback(u.callback_query, req.id);
    } catch (err) {
      req.log.error({ err }, "telegram update failed");
    }
    // Always 200 so Telegram does not retry a poisoned update forever.
    return { ok: true };
  });

  async function onMessage(m: NonNullable<Update["message"]>, requestId: string) {
    if (m.chat.type !== "private" || !m.from || !m.text) return; // TG-01: private chats only
    const text = m.text.trim();
    const start = /^\/start(?:\s+(\S+))?$/.exec(text);
    if (start?.[1]) {
      const linked = await telegram.linkByCode(kernel, start[1], m.from.id, { channel: "telegram", requestId, locale: "en" });
      await bot!.sendMessage(m.chat.id, linked ? tg(linked.locale).linked(esc(linked.actor.name)) : tg("en").badCode);
      return;
    }
    const who = await telegram.userByTelegramId(kernel, m.from.id);
    if (!who) {
      await bot!.sendMessage(m.chat.id, `${tg("en").linkFirst}\n\n${tg("km").linkFirst}`); // TG-02
      return;
    }
    const s = tg(who.locale);
    if (await handleTimeCommand(kernel, bot!, who, m.chat.id, text, requestId)) return; // /in, /out, /week
    if (text.startsWith("/inbox")) {
      const items = (await execute(
        kernel,
        { actor: who.actor, channel: "telegram", requestId, locale: who.locale },
        approvals.approvalInbox,
        {},
      )) as InboxItem[];
      const decidable = items.filter((i) => i.canDecide);
      if (!decidable.length) {
        await bot!.sendMessage(m.chat.id, s.nothing);
        return;
      }
      for (const i of decidable.slice(0, 10)) await sendApprovalCard(kernel, bot!, who.actor.id, i.id, requestId);
      return;
    }
    await bot!.sendMessage(m.chat.id, `${s.help}\n${tgTime(who.locale).help}`);
  }

  async function onCallback(q: NonNullable<Update["callback_query"]>, requestId: string) {
    if (await handleTimeCallback(kernel, bot!, q, requestId)) return; // timesheet Confirm (w:<token>)
    const token = /^a:([A-Za-z0-9_-]{8,40})$/.exec(q.data ?? "")?.[1];
    const chat = q.message?.chat;
    if (!token || !chat || chat.type !== "private") {
      await bot!.answerCallbackQuery(q.id);
      return;
    }
    const r = await telegram.consumeAction(kernel, token, q.from.id); // TG-04
    if (!r.ok) {
      const who = await telegram.userByTelegramId(kernel, q.from.id);
      await bot!.answerCallbackQuery(q.id, tg(who?.locale ?? "en").expired);
      return;
    }
    const s = tg(r.user.locale);
    const meta = { actor: r.user.actor, channel: "telegram" as const, requestId, locale: r.user.locale };
    if (r.decision === "approve" && TWO_TAP_KINDS.has(r.kind)) {
      // TG-05: first tap asks for confirmation with fresh single-use buttons.
      const t2 = await telegram.issueActions(
        kernel,
        { approvalId: r.approvalId, userId: r.user.actor.id, telegramUserId: q.from.id },
        ["confirm_approve", "reject"],
      );
      await bot!.editMessageText(chat.id, q.message!.message_id, s.confirmQ, {
        buttons: [
          [
            { text: s.confirm, callback_data: `a:${t2.confirm_approve}` },
            { text: s.reject, callback_data: `a:${t2.reject}` },
          ],
        ],
      });
      await bot!.answerCallbackQuery(q.id);
      return;
    }
    const decision = r.decision === "reject" ? "reject" : "approve";
    try {
      await execute(kernel, meta, approvals.approvalDecide, {
        id: r.approvalId,
        decision,
        ...(r.outcome ? { outcome: r.outcome } : {}),
      }); // TG-06
      const name = esc(r.user.actor.name);
      await bot!.editMessageText(
        chat.id,
        q.message!.message_id,
        r.outcome === "absorb"
          ? s.absorbed(name)
          : r.outcome === "change_order"
            ? s.toChangeOrder(name)
            : decision === "approve"
              ? s.approved(name)
              : s.rejected(name),
      );
      await bot!.answerCallbackQuery(q.id);
    } catch (err) {
      const code = err instanceof DomainError ? err.code : "INTERNAL";
      await bot!.answerCallbackQuery(q.id, errorMessage(code, r.user.locale));
      if (code === "ALREADY_DECIDED")
        await bot!.editMessageText(chat.id, q.message!.message_id, errorMessage(code, r.user.locale));
    }
  }
}
