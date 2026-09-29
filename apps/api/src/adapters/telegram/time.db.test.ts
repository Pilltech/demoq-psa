// Telegram time commands: /in, /out, /week and the one-tap Confirm (plan §5.2). Next to telegram.db.test.ts.
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execute, profile, time, type UserActor } from "@demoq/core";
import { createTestDb, makeTeam, makeUser, meta, runAs, type TestDb } from "@demoq/testkit";
import { buildApp } from "../../app";
import type { Config } from "../../config";
import { drainOutbox } from "../../worker/outbox";
import { newScheduleState, runSchedule } from "../../worker/schedule";
import type { BotApi, SendOpts } from "./bot";

const SECRET = "test-webhook-secret-123456";
let t: TestDb;
let app: FastifyInstance;
type Sent = { chatId: number; html: string; opts?: SendOpts; messageId?: number; edit?: boolean };
let sent: Sent[] = [];
let answers: { id: string; text?: string }[] = [];
let nextMessageId = 100;
const bot: BotApi = {
  async sendMessage(chatId, html, opts) {
    sent.push({ chatId, html, opts, messageId: ++nextMessageId });
    return { message_id: nextMessageId };
  },
  async editMessageText(chatId, messageId, html, opts) {
    sent.push({ chatId, html, opts, messageId, edit: true });
  },
  async answerCallbackQuery(id, text) {
    answers.push({ id, text });
  },
};
const config: Config = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://unused",
  PORT: 0,
  HOST: "127.0.0.1",
  TOTP_ENC_KEY: randomBytes(32).toString("base64"),
  LOGIN_RATE_PER_MIN: 1000,
  TRUST_PROXY_HOPS: 0,
  TELEGRAM_WEBHOOK_SECRET: SECRET,
};

let updateId = 1;
const hook = (body: unknown) =>
  app.inject({
    method: "POST",
    url: "/telegram/webhook",
    headers: { "x-telegram-bot-api-secret-token": SECRET, "content-type": "application/json" },
    payload: body as object,
  });
const say = (from: number, text: string) =>
  hook({
    update_id: updateId++,
    message: { message_id: updateId, chat: { id: from, type: "private" }, from: { id: from }, text },
  });
const press = (from: number, data: string, messageId = 1) =>
  hook({
    update_id: updateId++,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: from },
      data,
      message: { message_id: messageId, chat: { id: from, type: "private" } },
    },
  });
const buttons = (s: Sent) => (s.opts?.buttons ?? []).flat().map((b) => b.callback_data);
const last = () => sent.at(-1)!;
const pp = (date: string, hhmm: string) => `${date}T${hhmm}:00+07:00`;

let staff: UserActor, lead: UserActor, other: UserActor;
const STAFF_TG = 7101,
  LEAD_TG = 7102,
  OTHER_TG = 7103;

async function link(user: UserActor, tgId: number) {
  const { code } = await execute(t.kernel, meta(user), profile.telegramLinkCode, {});
  await say(tgId, `/start ${code}`);
}

beforeAll(async () => {
  t = await createTestDb(pp("2026-10-19", "08:00"));
  app = await buildApp(t.kernel, config, { bot });
  const team = await makeTeam(t.db, "Creative");
  lead = await makeUser(t.db, { roles: ["team_lead"], teamId: team.id, name: "Rith Lead" });
  staff = await makeUser(t.db, { roles: ["staff"], teamId: team.id, name: "Dara Staff" });
  other = await makeUser(t.db, { roles: ["staff"], teamId: team.id, name: "Sok Staff", locale: "km" });
  await link(staff, STAFF_TG);
  await link(lead, LEAD_TG);
  await link(other, OTHER_TG);
});
afterAll(async () => {
  await app.close();
  await t.destroy();
});
beforeEach(() => {
  sent = [];
  answers = [];
});

describe("channels/telegram — time", () => {
  it("[TIM-AT-04] /in and /out clock me in and out on the telegram channel and reply with the time", async () => {
    t.clock.set(pp("2026-10-19", "08:02"));
    await say(STAFF_TG, "/in");
    expect(last()).toMatchObject({ chatId: STAFF_TG });
    expect(last().html).toMatch(/Clocked in at <b>08:02<\/b>/);
    await say(STAFF_TG, "/in");
    expect(last().html).toBe("You are already clocked in.");
    t.clock.set(pp("2026-10-19", "17:32"));
    await say(STAFF_TG, "/out");
    expect(last().html).toMatch(/Clocked out at <b>17:32<\/b> \(9 h 30\)/);
    await say(STAFF_TG, "/out");
    expect(last().html).toBe("You are not clocked in.");
    const s = await t.db
      .selectFrom("attendance_sessions")
      .select(["channel", "end_channel"])
      .where("user_id", "=", staff.id)
      .executeTakeFirstOrThrow();
    expect(s).toEqual({ channel: "telegram", end_channel: "telegram" });
    const audit = await t.db
      .selectFrom("audit_events")
      .select("channel")
      .where("action", "=", "attendance.clock_in")
      .where("actor_id", "=", staff.id)
      .executeTakeFirstOrThrow();
    expect(audit.channel).toBe("telegram");
    // Khmer reply for a Khmer user; unknown text lists the time commands.
    await say(OTHER_TG, "/in");
    expect(last().html).toMatch(/បានចុះឈ្មោះចូលធ្វើការ/);
    await say(OTHER_TG, "/out");
    await say(STAFF_TG, "hello");
    expect(last().html).toMatch(/\/week/);
  });

  it("[TIM-TS-09] /week shows the pre-filled week with a single-use Confirm bound to me and to the draft", async () => {
    t.clock.set(pp("2026-10-20", "08:00"));
    await say(STAFF_TG, "/in");
    t.clock.set(pp("2026-10-20", "17:00"));
    await say(STAFF_TG, "/out");
    t.clock.set(pp("2026-10-24", "14:10"));
    sent = [];
    await say(STAFF_TG, "/week");
    const card = last();
    expect(card.html).toMatch(/Week of/);
    expect(card.html).toMatch(/Administration 9 h 00/); // Tuesday's attendance on the admin code
    expect(card.html).toMatch(/Total: <b>/);
    const [confirm] = buttons(card);
    expect(confirm).toMatch(/^w:/);
    const w = await t.db
      .selectFrom("timesheet_weeks")
      .select(["opened_at", "status"])
      .where("user_id", "=", staff.id)
      .executeTakeFirstOrThrow();
    expect(w).toEqual({ opened_at: t.clock.now, status: "open" });
    const row = await t.db
      .selectFrom("telegram_actions")
      .selectAll()
      .where("token", "=", confirm!.slice(2))
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ kind: "timesheet_confirm", decision: "confirm", approval_id: null, user_id: staff.id });
    expect(row.payload).toMatchObject({ userId: staff.id, weekStart: "2026-10-19" });
    // Someone else pressing it does nothing
    await press(OTHER_TG, confirm!, card.messageId);
    expect(answers.at(-1)!.text).toMatch(/ប៊ូតុង/);
    // The draft changes (another clock-in) → the old card is stale and confirms nothing
    await say(STAFF_TG, "/in");
    t.clock.set(pp("2026-10-24", "15:00"));
    await say(STAFF_TG, "/out");
    await press(STAFF_TG, confirm!, card.messageId);
    expect(answers.at(-1)!.text).toMatch(/changed since this card/);
    expect(
      (await t.db.selectFrom("timesheet_weeks").select("status").where("user_id", "=", staff.id).executeTakeFirstOrThrow())
        .status,
    ).toBe("open");
    // A fresh card confirms in one tap, once.
    sent = [];
    await say(STAFF_TG, "/week");
    const card2 = last();
    const [confirm2] = buttons(card2);
    await press(STAFF_TG, confirm2!, card2.messageId);
    expect(last()).toMatchObject({ edit: true, messageId: card2.messageId });
    expect(last().html).toMatch(/Week confirmed: 43 h 15/); // 9 h 30 + 9 h + 3 × 8 h capacity + 45 min on Saturday
    await press(STAFF_TG, confirm2!, card2.messageId);
    expect(answers.at(-1)!.text).toBe("This button is no longer valid.");
    const done = await t.db
      .selectFrom("timesheet_weeks")
      .select(["status", "confirmed_channel"])
      .where("user_id", "=", staff.id)
      .executeTakeFirstOrThrow();
    expect(done).toEqual({ status: "confirmed", confirmed_channel: "telegram" });
    const audit = await t.db
      .selectFrom("audit_events")
      .select(["channel", "actor_id"])
      .where("action", "=", "timesheet.confirm")
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({ channel: "telegram", actor_id: staff.id });
    // A confirmed week shows without a button
    sent = [];
    await say(STAFF_TG, "/week");
    expect(buttons(last())).toHaveLength(0);
    expect(last().html).toMatch(/confirmed/);
  });

  it("[TIM-TS-09] an expired Confirm button confirms nothing", async () => {
    t.clock.set(pp("2026-10-24", "14:10"));
    sent = [];
    await say(OTHER_TG, "/week");
    const [confirm] = buttons(last());
    t.clock.set(pp("2026-10-25", "15:00"));
    await press(OTHER_TG, confirm!);
    expect(
      (await t.db.selectFrom("timesheet_weeks").select("status").where("user_id", "=", other.id).executeTakeFirstOrThrow())
        .status,
    ).toBe("open");
  });

  it("[TIM-TS-11] the 14:00 reminder arrives as the week card with a Confirm button (without marking the week opened)", async () => {
    const u = await makeUser(t.db, { roles: ["staff"], name: "Reminded" });
    await link(u, 7104);
    await drainOutbox(t.kernel, { bot });
    t.clock.set(pp("2026-10-31", "14:05")); // Saturday
    const did: { reminded: number }[] = [];
    await runSchedule(t.kernel, newScheduleState(), { onTimeJobs: (r) => did.push(r) });
    expect(did[0]!.reminded).toBeGreaterThan(0);
    sent = [];
    await drainOutbox(t.kernel, { bot });
    const card = sent.find((s) => s.chatId === 7104)!;
    expect(card.html).toMatch(/Week of/);
    expect(buttons(card)[0]).toMatch(/^w:/);
    const w = await t.db
      .selectFrom("timesheet_weeks")
      .select(["opened_at", "reminded_at"])
      .where("user_id", "=", u.id)
      .where("week_start", "=", "2026-10-26")
      .executeTakeFirstOrThrow();
    expect(w.opened_at).toBeNull();
    expect(w.reminded_at).toEqual(t.clock.now);
    await press(7104, buttons(card)[0]!, card.messageId);
    expect(last().html).toMatch(/Week confirmed/);
  });

  it("[TIM-TS-12] the team lead hears on Telegram about an unconfirmed week", async () => {
    await drainOutbox(t.kernel, { bot });
    t.clock.set(pp("2026-11-02", "12:30")); // Monday after the week of 26 Oct
    await runAs(t, { type: "job", name: "job:time", grants: ["time.jobs"] }, time.timesheetDueEscalate, {});
    sent = [];
    await drainOutbox(t.kernel, { bot });
    const notes = sent.filter((s) => s.chatId === LEAD_TG);
    expect(notes.map((n) => n.html).join("\n")).toMatch(/Dara Staff has not confirmed the week of/);
  });
});
