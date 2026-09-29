// Minimal Telegram Bot API client + card rendering. Plain fetch (no framework needed for webhook mode).
import { formatBp, formatMoney, type Currency } from "@demoq/shared";

export interface InlineButton {
  text: string;
  callback_data: string;
}
export interface SendOpts {
  buttons?: InlineButton[][];
}
export interface BotApi {
  sendMessage(chatId: number, html: string, opts?: SendOpts): Promise<{ message_id: number } | null>;
  editMessageText(chatId: number, messageId: number, html: string, opts?: SendOpts): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}

export function httpBotApi(token: string, fetchImpl: typeof fetch = fetch): BotApi {
  const call = async (method: string, body: Record<string, unknown>) => {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000), // never let a slow Telegram API stall the worker or a webhook
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown; description?: string } | null;
    if (!data?.ok) throw new Error(`telegram ${method} failed: ${data?.description ?? res.status}`);
    return data.result;
  };
  const markup = (o?: SendOpts) => (o?.buttons ? { reply_markup: { inline_keyboard: o.buttons } } : {});
  return {
    sendMessage: async (chat_id, text, o) =>
      (await call("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...markup(o) })) as {
        message_id: number;
      },
    editMessageText: async (chat_id, message_id, text, o) => {
      await call("editMessageText", { chat_id, message_id, text, parse_mode: "HTML", ...markup(o) });
    },
    answerCallbackQuery: async (callback_query_id, text) => {
      await call("answerCallbackQuery", { callback_query_id, ...(text ? { text } : {}) });
    },
  };
}

type Locale = "en" | "km";
const T = {
  en: {
    linkFirst: "Link your DemoQ account first: open DemoQ → Profile → Link Telegram, then send /start CODE here.",
    linked: (n: string) => `Linked. Hello ${n}! Send /inbox to see what is waiting for you.`,
    badCode: "That code is invalid or expired. Get a new one from DemoQ → Profile.",
    nothing: "Nothing is waiting for your decision. 🎉",
    approve: "✅ Approve",
    reject: "✖️ Reject",
    confirm: "⚠️ Confirm approve",
    confirmQ: "Approve below the margin floor? Tap again to confirm.",
    approved: (n: string) => `✅ Approved by ${n}`,
    rejected: (n: string) => `✖️ Rejected by ${n}`,
    absorb: "✅ Absorb",
    changeOrder: "📝 Change order",
    absorbed: (n: string) => `✅ Absorbed by ${n}`,
    toChangeOrder: (n: string) => `📝 Change order chosen by ${n}`,
    expired: "This button is no longer valid.",
    requestedBy: "Requested by",
    due: "Due",
    margin: "Fee margin",
    floor: "floor",
    markup: "Pass-through markup",
    total: "Total",
    help: "Commands: /inbox — approvals waiting for you.",
    kinds: {
      margin_floor: "Below margin floor",
      out_of_scope: "Out of scope",
      quality_check: "Quality check",
      gate_bypass: "Gate bypass",
      bypass_review: "Bypass review",
      influencer_work: "Influencer work",
      leave: "Leave",
    } as Record<string, string>,
  },
  km: {
    linkFirst: "សូមភ្ជាប់គណនី DemoQ ជាមុនសិន៖ បើក DemoQ → ប្រវត្តិរូប → ភ្ជាប់ Telegram រួចផ្ញើ /start CODE នៅទីនេះ។",
    linked: (n: string) => `បានភ្ជាប់។ សួស្តី ${n}! ផ្ញើ /inbox ដើម្បីមើលអ្វីដែលកំពុងរង់ចាំអ្នក។`,
    badCode: "លេខកូដមិនត្រឹមត្រូវ ឬផុតកំណត់។ សូមយកលេខកូដថ្មីពី DemoQ → ប្រវត្តិរូប។",
    nothing: "គ្មានអ្វីរង់ចាំការសម្រេចរបស់អ្នកទេ។ 🎉",
    approve: "✅ អនុម័ត",
    reject: "✖️ បដិសេធ",
    confirm: "⚠️ បញ្ជាក់ការអនុម័ត",
    confirmQ: "អនុម័តក្រោមកម្រិតប្រាក់ចំណេញ? ចុចម្ដងទៀតដើម្បីបញ្ជាក់។",
    approved: (n: string) => `✅ អនុម័តដោយ ${n}`,
    rejected: (n: string) => `✖️ បដិសេធដោយ ${n}`,
    absorb: "✅ ទទួលយកដោយឥតគិតថ្លៃ",
    changeOrder: "📝 លិខិតផ្លាស់ប្ដូរ",
    absorbed: (n: string) => `✅ ទទួលយកដោយឥតគិតថ្លៃដោយ ${n}`,
    toChangeOrder: (n: string) => `📝 ជ្រើសរើសលិខិតផ្លាស់ប្ដូរដោយ ${n}`,
    expired: "ប៊ូតុងនេះលែងមានសុពលភាពហើយ។",
    requestedBy: "ស្នើដោយ",
    due: "ផុតកំណត់",
    margin: "ប្រាក់ចំណេញលើសេវា",
    floor: "កម្រិតអប្បបរមា",
    markup: "ការបន្ថែមលើការចំណាយជំនួស",
    total: "សរុប",
    help: "ពាក្យបញ្ជា៖ /inbox — ការអនុម័តដែលកំពុងរង់ចាំអ្នក។",
    kinds: {
      margin_floor: "ក្រោមកម្រិតប្រាក់ចំណេញ",
      out_of_scope: "ក្រៅវិសាលភាព",
      quality_check: "ត្រួតពិនិត្យគុណភាព",
      gate_bypass: "រំលងលក្ខខណ្ឌ",
      bypass_review: "ពិនិត្យការរំលង",
      influencer_work: "ការងារអ្នកមានឥទ្ធិពល",
      leave: "ច្បាប់ឈប់សម្រាក",
    } as Record<string, string>,
  },
};
// Khmer bot strings are drafts pending the Khmer reviewer (same status as KM-DRAFT UI strings).
export const tg = (locale: Locale) => T[locale];

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface CardDto {
  kind: string;
  title: string;
  requestedBy: string | null;
  dueAt: Date | string;
  facts: Record<string, unknown>;
  costs: Record<string, unknown> | null;
}

/** TG-07: figures appear only when the DTO carries them (i.e. the viewer holds finance.view_costs). */
export function renderCard(a: CardDto, locale: Locale): string {
  const s = tg(locale);
  const lines = [`<b>${esc(s.kinds[a.kind] ?? a.kind)}</b>`, esc(a.title), `${s.requestedBy}: ${esc(a.requestedBy ?? "—")}`];
  const due = new Date(a.dueAt);
  lines.push(
    `${s.due}: ${new Intl.DateTimeFormat(locale === "km" ? "km-KH" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Phnom_Penh" }).format(due)}`,
  );
  const cur = a.facts.currency as Currency | undefined;
  if (a.costs) {
    const c = a.costs as { feeMarginBp?: number | null; feeFloorBp?: number | null; ptMarkupBp?: number | null };
    if (c.feeMarginBp !== undefined)
      lines.push(`${s.margin}: <b>${formatBp(c.feeMarginBp ?? null)}</b> (${s.floor} ${formatBp(c.feeFloorBp ?? null)})`);
    if (c.ptMarkupBp !== undefined && c.ptMarkupBp !== null) lines.push(`${s.markup}: ${formatBp(c.ptMarkupBp)}`);
    if (cur && typeof a.facts.totalMinor === "string")
      lines.push(`${s.total}: ${formatMoney({ amountMinor: BigInt(a.facts.totalMinor), currency: cur }, locale)}`);
  }
  return lines.join("\n");
}
