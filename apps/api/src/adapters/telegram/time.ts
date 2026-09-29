// Telegram: /in, /out, /week and the weekly card's one-tap Confirm (plan §5.2). Spec: specs/time/attendance.md (TIM-AT-04),
// specs/time/timesheets.md (TIM-TS-09). Business rules stay in core: every action runs through execute() on "telegram".
import { DomainError, execute, telegram, time, type Kernel, type OpDef, type RequestMeta } from "@demoq/core";
import { errorMessage } from "@demoq/shared";
import { esc, type BotApi } from "./bot";

type Locale = "en" | "km";
type Who = NonNullable<Awaited<ReturnType<typeof telegram.userByTelegramId>>>;

const T = {
  en: {
    clockedIn: (at: string) => `🟢 Clocked in at <b>${at}</b>. Send /out when you finish.`,
    clockedOut: (at: string, dur: string) => `⚪ Clocked out at <b>${at}</b> (${dur}).`,
    autoClosed: "It was past the auto-close time, so the session ended then and is flagged for your weekly confirmation.",
    weekOf: (d: string) => `Week of ${d}`,
    total: "Total",
    attended: "attended",
    holiday: "holiday",
    leave: "leave",
    off: "off",
    confirmedWeek: "✅ This week is confirmed.",
    confirm: "✅ Confirm week",
    confirmed: (m: string) => `✅ Week confirmed: ${m}.`,
    stale: "Your week changed since this card was sent. Send /week for the current draft.",
    expired: "This button is no longer valid.",
    help: "/in — clock in · /out — clock out · /week — confirm your week",
    overdue: (name: string, week: string) => `⏰ ${name} has not confirmed the week of ${week}.`,
    flagged: (n: number) => `⚠️ ${n} flagged session(s) — check them in the app.`,
  },
  km: {
    clockedIn: (at: string) => `🟢 បានចុះឈ្មោះចូលធ្វើការម៉ោង <b>${at}</b>។ ផ្ញើ /out ពេលចេញពីការងារ។`,
    clockedOut: (at: string, dur: string) => `⚪ បានចុះឈ្មោះចេញម៉ោង <b>${at}</b> (${dur})។`,
    autoClosed: "ហួសម៉ោងបិទស្វ័យប្រវត្តិ ដូច្នេះវគ្គនេះបានបិទនៅពេលនោះ ហើយត្រូវបានសម្គាល់សម្រាប់ការបញ្ជាក់ប្រចាំសប្ដាហ៍។",
    weekOf: (d: string) => `សប្ដាហ៍ចាប់ពី ${d}`,
    total: "សរុប",
    attended: "វត្តមាន",
    holiday: "ថ្ងៃឈប់សម្រាក",
    leave: "ច្បាប់",
    off: "ឈប់",
    confirmedWeek: "✅ សប្ដាហ៍នេះត្រូវបានបញ្ជាក់រួចហើយ។",
    confirm: "✅ បញ្ជាក់សប្ដាហ៍",
    confirmed: (m: string) => `✅ បានបញ្ជាក់សប្ដាហ៍៖ ${m}។`,
    stale: "សប្ដាហ៍របស់អ្នកបានផ្លាស់ប្ដូរតាំងពីកាតនេះត្រូវបានផ្ញើ។ ផ្ញើ /week ដើម្បីមើលសេចក្ដីព្រាងថ្មី។",
    expired: "ប៊ូតុងនេះលែងមានសុពលភាពហើយ។",
    help: "/in — ចុះឈ្មោះចូល · /out — ចុះឈ្មោះចេញ · /week — បញ្ជាក់សប្ដាហ៍",
    overdue: (name: string, week: string) => `⏰ ${name} មិនទាន់បញ្ជាក់សប្ដាហ៍ចាប់ពី ${week} ទេ។`,
    flagged: (n: number) => `⚠️ វគ្គដែលបានសម្គាល់ ${n} — សូមពិនិត្យក្នុងកម្មវិធី។`,
  },
};
// Khmer bot strings are drafts pending the Khmer reviewer (same status as KM-DRAFT UI strings).
export const tgTime = (locale: Locale) => T[locale];

const time24 = (at: Date | string, locale: Locale) =>
  new Intl.DateTimeFormat(locale === "km" ? "km-KH" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Phnom_Penh",
  }).format(new Date(at));
export const hm = (minutes: number) => `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
const day = (date: string, locale: Locale) =>
  new Intl.DateTimeFormat(locale === "km" ? "km-KH" : "en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));

type WeekView = time.WeekView;

/** The pre-filled week as a compact card: one line per day, targets with hours, totals. */
export function renderWeek(v: WeekView, locale: Locale): string {
  const s = tgTime(locale);
  const lines = [`<b>${esc(s.weekOf(day(v.weekStart, locale)))}</b>`];
  const label = new Map(v.targets.map((t) => [`${t.targetType}|${t.key}`, (locale === "km" && t.labelKm) || t.label]));
  for (const d of v.days) {
    const rows = v.rows.filter((r) => r.date === d.date);
    const tag = d.holiday ? ` · ${s.holiday}` : d.leave ? ` · ${s.leave}` : !d.scheduled ? ` · ${s.off}` : "";
    if (!rows.length && !d.workingDay) {
      lines.push(`${day(d.date, locale)}${tag}`);
      continue;
    }
    const parts = rows.map((r) => `${esc(label.get(`${r.targetType}|${r.key}`) ?? "—")} ${hm(r.minutes)}`);
    lines.push(`${day(d.date, locale)}: <b>${hm(d.allocatedMinutes)}</b>${tag}${parts.length ? ` — ${parts.join(", ")}` : ""}`);
  }
  lines.push(`${s.total}: <b>${hm(v.totals.allocatedMinutes)}</b> (${s.attended} ${hm(v.totals.attendedMinutes)})`);
  if (v.totals.flaggedSessions) lines.push(s.flagged(v.totals.flaggedSessions));
  if (v.status === "confirmed") lines.push(s.confirmedWeek);
  return lines.join("\n");
}

const metaFor = (who: Who, requestId: string): RequestMeta => ({
  actor: who.actor,
  channel: "telegram",
  requestId,
  locale: who.locale,
});

/**
 * Send a user their week with a one-tap Confirm (TIM-TS-09). `open` records the first opening (the user asked with
 * /week); the 14:00 reminder does not.
 */
export async function sendWeekCard(
  kernel: Kernel,
  bot: BotApi,
  userId: string,
  requestId: string,
  opts: { open: boolean; weekStart?: string },
): Promise<boolean> {
  const chatId = await telegram.telegramIdFor(kernel, userId);
  if (!chatId) return false;
  const who = await telegram.userByTelegramId(kernel, chatId);
  if (!who) return false;
  const op: OpDef = opts.open ? time.timesheetOpen : time.timesheetWeek;
  const view = (await execute(kernel, metaFor(who, requestId), op, { weekStart: opts.weekStart })) as WeekView;
  const text = renderWeek(view, who.locale);
  if (view.status === "confirmed") {
    await bot.sendMessage(chatId, text);
    return true;
  }
  const token = await time.issueTimesheetConfirm(kernel, {
    userId,
    telegramUserId: chatId,
    weekStart: view.weekStart,
    draftHash: view.draftHash,
  });
  await bot.sendMessage(chatId, text, { buttons: [[{ text: tgTime(who.locale).confirm, callback_data: `w:${token}` }]] });
  return true;
}

/** /in, /out, /week. Returns false when the text is not one of them. */
export async function handleTimeCommand(
  kernel: Kernel,
  bot: BotApi,
  who: Who,
  chatId: number,
  text: string,
  requestId: string,
): Promise<boolean> {
  const cmd = /^\/(in|out|week)(?:@\w+)?(?:\s|$)/.exec(text)?.[1];
  if (!cmd) return false;
  const s = tgTime(who.locale);
  try {
    if (cmd === "in") {
      const r = (await execute(kernel, metaFor(who, requestId), time.attendanceClockIn, {})) as { startedAt: Date };
      await bot.sendMessage(chatId, s.clockedIn(time24(r.startedAt, who.locale)));
    } else if (cmd === "out") {
      const r = (await execute(kernel, metaFor(who, requestId), time.attendanceClockOut, {})) as {
        endedAt: Date;
        minutes: number;
        autoClosed: boolean;
      };
      await bot.sendMessage(
        chatId,
        `${s.clockedOut(time24(r.endedAt, who.locale), hm(r.minutes))}${r.autoClosed ? `\n${s.autoClosed}` : ""}`,
      );
    } else {
      await sendWeekCard(kernel, bot, who.actor.id, requestId, { open: true });
    }
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    await bot.sendMessage(chatId, errorMessage(err.code, who.locale));
  }
  return true;
}

/** The Confirm button (`w:<token>`). Returns false when the callback is not a timesheet button. */
export async function handleTimeCallback(
  kernel: Kernel,
  bot: BotApi,
  q: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number; type: string } } },
  requestId: string,
): Promise<boolean> {
  const token = /^w:([A-Za-z0-9_-]{8,40})$/.exec(q.data ?? "")?.[1];
  if (!token) return false;
  const chat = q.message?.chat;
  if (!chat || chat.type !== "private") {
    await bot.answerCallbackQuery(q.id); // TG-01: private chats only
    return true;
  }
  const r = await time.consumeTimesheetConfirm(kernel, token, q.from.id);
  if (!r.ok) {
    const who = await telegram.userByTelegramId(kernel, q.from.id);
    await bot.answerCallbackQuery(q.id, tgTime(who?.locale ?? "en").expired);
    return true;
  }
  const s = tgTime(r.user.locale);
  try {
    const c = (await execute(
      kernel,
      { actor: r.user.actor, channel: "telegram", requestId, locale: r.user.locale },
      time.timesheetConfirm,
      { weekStart: r.weekStart, draftHash: r.draftHash },
    )) as { confirmedMinutes: number };
    await bot.editMessageText(chat.id, q.message!.message_id, s.confirmed(hm(c.confirmedMinutes)));
    await bot.answerCallbackQuery(q.id);
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    const msg = err.code === "STALE_VERSION" ? s.stale : errorMessage(err.code, r.user.locale);
    await bot.answerCallbackQuery(q.id, msg);
    await bot.editMessageText(chat.id, q.message!.message_id, msg);
  }
  return true;
}

/** TIM-TS-12: tell a team lead that someone has not confirmed last week. */
export async function sendOverdueNotice(kernel: Kernel, bot: BotApi, leadId: string, name: string, weekStart: string) {
  const chatId = await telegram.telegramIdFor(kernel, leadId);
  if (!chatId) return false;
  const lead = await telegram.userByTelegramId(kernel, chatId);
  if (!lead) return false;
  await bot.sendMessage(chatId, tgTime(lead.locale).overdue(esc(name), day(weekStart, lead.locale)));
  return true;
}
