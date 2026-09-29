import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvals, commercial, execute, profile, projects, tasks, type OpDef } from "@demoq/core";
import {
  acceptedProject,
  createTestDb,
  engagementTypeId,
  line,
  makeClient,
  makeDeal,
  makeTeam,
  makeUser,
  meta,
  type TestDb,
} from "@demoq/testkit";
import { buildApp } from "../../app";
import type { Config } from "../../config";
import { drainOutbox } from "../../worker/outbox";
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
const hook = (body: unknown, secret = SECRET) =>
  app.inject({
    method: "POST",
    url: "/telegram/webhook",
    headers: { "x-telegram-bot-api-secret-token": secret, "content-type": "application/json" },
    payload: body as object,
  });
const say = (from: number, text: string, chatType = "private") =>
  hook({
    update_id: updateId++,
    message: { message_id: updateId, chat: { id: from, type: chatType }, from: { id: from }, text },
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

let lead: Awaited<ReturnType<typeof makeUser>>,
  finance: Awaited<ReturnType<typeof makeUser>>,
  ops: Awaited<ReturnType<typeof makeUser>>;
const FIN_TG = 5001,
  OPS_TG = 5002,
  STRANGER_TG = 6666;

async function link(user: Awaited<ReturnType<typeof makeUser>>, tgId: number) {
  const { code } = await execute(t.kernel, meta(user), profile.telegramLinkCode, {});
  await say(tgId, `/start ${code}`);
}
let n = 0;
async function belowFloorApproval() {
  const title = `TG quote ${++n}`;
  const client = await makeClient(t.db, lead.id);
  const deal = await makeDeal(t.db, client.id, lead.id);
  const et = await engagementTypeId(t.db);
  const q = await execute(t.kernel, meta(lead), commercial.quoteCreate, { dealId: deal.id, title, engagementTypeId: et });
  const s = await execute(t.kernel, meta(lead), commercial.quoteSave, {
    id: q.id,
    expectedVersion: q.version,
    lines: [line("fee", 10, 5000, 4100)],
  });
  const r = await execute(t.kernel, meta(lead), commercial.quoteSubmit, {
    id: q.id,
    expectedVersion: s.version,
    sendOnApproval: true,
  });
  return { approvalId: r.approvalId as string, quoteId: q.id, title };
}

beforeAll(async () => {
  t = await createTestDb();
  app = await buildApp(t.kernel, config, { bot });
  lead = await makeUser(t.db, { roles: ["account_lead"], name: "Sokha Lead" });
  finance = await makeUser(t.db, { roles: ["finance"], name: "Aaa Finance" });
  ops = await makeUser(t.db, { roles: ["ops_lead"], name: "Vanna Ops", locale: "km" });
  await link(finance, FIN_TG);
  await link(ops, OPS_TG);
});
afterAll(async () => {
  await app.close();
  await t.destroy();
});
beforeEach(() => {
  sent = [];
  answers = [];
});

describe("channels/telegram", () => {
  it("[TG-01] updates without the secret header are refused; group chats are ignored", async () => {
    expect((await hook({ update_id: 1 }, "wrong")).statusCode).toBe(401);
    expect((await say(FIN_TG, "/inbox", "group")).statusCode).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it("[TG-02] a one-time code links the account once; unlinked users are told how to link", async () => {
    const u = await makeUser(t.db, { roles: ["staff"], name: "Bopha" });
    const { code } = await execute(t.kernel, meta(u), profile.telegramLinkCode, {});
    await say(7001, `/start ${code}`);
    expect(last().html).toMatch(/Hello Bopha/);
    const row = await t.db.selectFrom("users").select("telegram_user_id").where("id", "=", u.id).executeTakeFirstOrThrow();
    expect(row.telegram_user_id).toBe(7001n);
    await say(7002, `/start ${code}`); // reused
    expect(last().html).toMatch(/invalid or expired/);
    const { code: c2 } = await execute(t.kernel, meta(u), profile.telegramLinkCode, {});
    t.clock.advance(11 * 60_000);
    await say(7003, `/start ${c2}`); // expired
    expect(last().html).toMatch(/invalid or expired/);
    t.clock.set("2026-10-19T02:00:00Z");
    await say(STRANGER_TG, "/inbox");
    expect(last().html).toMatch(/Link your DemoQ account first/);
    const stored = await t.db.selectFrom("telegram_link_codes").select("code_hash").where("user_id", "=", u.id).execute();
    expect(stored.every((s) => s.code_hash !== code)).toBe(true);
  });

  it("[TG-03][TG-07] /inbox sends one card per decidable approval, with figures for cost-holders", async () => {
    const { approvalId, title } = await belowFloorApproval();
    await say(FIN_TG, "/inbox");
    const card = sent.find((s) => s.html.includes(title))!;
    expect(card.chatId).toBe(FIN_TG);
    expect(card.html).toMatch(/Below margin floor/);
    expect(card.html).toMatch(/Fee margin: <b>18\.00%<\/b> \(floor 25\.00%\)/);
    expect(buttons(card)).toHaveLength(2);
    const tokens = await t.db
      .selectFrom("telegram_actions")
      .select("decision")
      .where("approval_id", "=", approvalId)
      .where("telegram_user_id", "=", BigInt(FIN_TG))
      .execute();
    expect(tokens.map((x) => x.decision).sort()).toEqual(["approve", "reject"]);
  });

  it("[TG-04] a button pressed by someone else, reused, or expired decides nothing", async () => {
    const { approvalId, title } = await belowFloorApproval();
    await say(FIN_TG, "/inbox");
    const card = sent.find((s) => s.html.includes(title) && buttons(s).length)!;
    const [approve, reject] = buttons(card);
    await press(OPS_TG, reject!); // wrong user
    expect(answers.at(-1)!.text).toMatch(/ប៊ូតុង/); // ops reads Khmer
    await press(FIN_TG, reject!);
    await press(FIN_TG, reject!); // reused
    await press(FIN_TG, approve!); // sibling burned when the card was decided
    const a = await t.db
      .selectFrom("approvals")
      .select(["status", "decided_by"])
      .where("id", "=", approvalId)
      .executeTakeFirstOrThrow();
    expect(a).toEqual({ status: "rejected", decided_by: finance.id });
    expect(answers.filter((x) => x.text?.includes("no longer valid"))).toHaveLength(2);
    // Expired
    const b = await belowFloorApproval();
    sent = [];
    await say(FIN_TG, "/inbox");
    const card2 = sent.find((s) => s.html.includes(b.title) && buttons(s).length)!;
    t.clock.advance(25 * 3600_000);
    await press(FIN_TG, buttons(card2)[1]!);
    t.clock.set("2026-10-19T02:00:00Z");
    expect(
      (await t.db.selectFrom("approvals").select("status").where("id", "=", b.approvalId).executeTakeFirstOrThrow()).status,
    ).toBe("pending");
  });

  it("[TG-05][TG-06] margin_floor needs two taps; the decision runs approval.decide on the telegram channel and edits the card", async () => {
    const { approvalId, quoteId, title } = await belowFloorApproval();
    await say(FIN_TG, "/inbox");
    const card = sent.find((s) => s.html.includes(title) && buttons(s).length)!;
    await press(FIN_TG, buttons(card)[0]!, card.messageId);
    const confirm = last();
    expect(confirm).toMatchObject({ edit: true, messageId: card.messageId });
    expect(confirm.html).toMatch(/Tap again to confirm/);
    expect(
      (await t.db.selectFrom("approvals").select("status").where("id", "=", approvalId).executeTakeFirstOrThrow()).status,
    ).toBe("pending");
    await press(FIN_TG, buttons(confirm)[0]!, card.messageId);
    expect(last().html).toBe("✅ Approved by Aaa Finance");
    const a = await t.db
      .selectFrom("approvals")
      .select(["status", "decided_channel"])
      .where("id", "=", approvalId)
      .executeTakeFirstOrThrow();
    expect(a).toEqual({ status: "approved", decided_channel: "telegram" });
    const audit = await t.db
      .selectFrom("audit_events")
      .select(["actor_name", "channel"])
      .where("action", "=", "approval.decide")
      .where("subject_id", "=", approvalId)
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({ actor_name: "Aaa Finance", channel: "telegram" });
    // COM-QB-08 end to end: the worker sends the quote as the requester, on behalf of the approval.
    await drainOutbox(t.kernel, { bot });
    const q = await t.db.selectFrom("quotes").select(["status", "sent_by"]).where("id", "=", quoteId).executeTakeFirstOrThrow();
    expect(q).toEqual({ status: "sent", sent_by: lead.id });
    const sendAudit = await t.db
      .selectFrom("audit_events")
      .select(["actor_name", "channel", "on_behalf_of"])
      .where("action", "=", "quote.send")
      .where("subject_id", "=", quoteId)
      .executeTakeFirstOrThrow();
    expect(sendAudit).toEqual({ actor_name: "Sokha Lead", channel: "job", on_behalf_of: approvalId });
  });

  it("[TG-08] the worker sends a card to the assignee when an approval is assigned", async () => {
    await drainOutbox(t.kernel, { bot }); // flush older events
    sent = [];
    const { title } = await belowFloorApproval();
    const drained = await drainOutbox(t.kernel, { bot });
    expect(drained).toBeGreaterThan(0);
    const card = sent.find((s) => s.html.includes(title))!;
    expect(card.chatId).toBe(FIN_TG); // finance is first in the margin_floor chain
    expect(buttons(card)).toHaveLength(2);
    expect(await drainOutbox(t.kernel, { bot })).toBe(0); // delivered once
  });

  it("[TG-06] names are HTML-escaped and button tokens never reach the audit log", async () => {
    const odd = await makeUser(t.db, { roles: ["staff"], name: "Sok & <Dara>" });
    const { code } = await execute(t.kernel, meta(odd), profile.telegramLinkCode, {});
    await say(8001, `/start ${code}`);
    expect(last().html).toContain("Sok &amp; &lt;Dara&gt;");
    const tokens = await t.db.selectFrom("telegram_actions").select("token").limit(3).execute();
    const leaked = await t.db
      .selectFrom("audit_changes")
      .select("new_row")
      .where("table_name", "=", "telegram_actions")
      .execute();
    const blob = JSON.stringify(leaked);
    expect(tokens.every((x) => !blob.includes(x.token))).toBe(true);
    expect(leaked.every((r) => (r.new_row as { token: string }).token === "[redacted]")).toBe(true);
  });

  it("[COM-QB-08] a stale send-on-approval event never sends content that was edited after approval", async () => {
    const { approvalId, quoteId, title } = await belowFloorApproval();
    await say(FIN_TG, "/inbox");
    const card = sent.find((s) => s.html.includes(title) && buttons(s).length)!;
    await press(FIN_TG, buttons(card)[0]!, card.messageId);
    await press(FIN_TG, buttons(last())[0]!, card.messageId); // approved → quote.send_requested queued
    // Before the worker runs, the owner edits (→ draft), then resubmits above the floor (→ ready, no auto-send).
    const q = await t.db.selectFrom("quotes").select("version").where("id", "=", quoteId).executeTakeFirstOrThrow();
    const s2 = await execute(t.kernel, meta(lead), commercial.quoteSave, {
      id: quoteId,
      expectedVersion: q.version,
      lines: [line("fee", 10, 5000, 1000)],
    });
    await execute(t.kernel, meta(lead), commercial.quoteSubmit, { id: quoteId, expectedVersion: s2.version });
    await drainOutbox(t.kernel, { bot });
    const after = await t.db.selectFrom("quotes").select("status").where("id", "=", quoteId).executeTakeFirstOrThrow();
    expect(after.status).toBe("ready"); // not sent on behalf of an approval for other content
    expect(approvalId).toBeTruthy();
  });
});

describe("channels/telegram — delivery cards", () => {
  type U = Awaited<ReturnType<typeof makeUser>>;
  let pm: U, designer: U, teamLead: U;
  const TL_TG = 5003;
  const ex = <T>(u: U, op: OpDef, input: unknown) => execute(t.kernel, meta(u), op, input) as Promise<T>;
  const version = async (id: string) =>
    (await t.db.selectFrom("tasks").select("version").where("id", "=", id).executeTakeFirstOrThrow()).version;
  let projectId: string;

  beforeAll(async () => {
    const team = await makeTeam(t.db, "Design TG");
    pm = await makeUser(t.db, { roles: ["project_manager"], name: "Piseth PM" });
    designer = await makeUser(t.db, { roles: ["staff"], teamId: team.id, name: "Designer" });
    teamLead = await makeUser(t.db, { roles: ["team_lead"], teamId: team.id, name: "Rith Lead" });
    await link(teamLead, TL_TG);
    const p = await acceptedProject(t, lead, { pmId: pm.id });
    for (const gate of ["contract", "purchase_order", "deposit_terms"])
      await ex(pm, projects.gateSatisfy, { projectId: p.projectId, gate, evidence: `REF-${gate}` });
    projectId = p.projectId;
  });

  let n = 0;
  async function oosTask() {
    const title = `Extra banner ${++n}`;
    const r = await ex<{ id: string; oosApprovalId: string }>(pm, tasks.taskCreate, {
      projectId,
      title,
      ownerId: designer.id,
      estimateMinutes: 60,
      dueDate: "2026-11-05",
      outOfScopeReason: "Client asked on the call",
    });
    return { ...r, title };
  }
  async function outcomeCard(title: string) {
    sent = [];
    await say(OPS_TG, "/inbox");
    return sent.find((s) => s.html.includes(title) && buttons(s).length)!;
  }
  const decided = (id: string) =>
    t.db
      .selectFrom("approvals")
      .select(["status", "outcome", "decided_by", "decided_channel"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

  it("[TSK-DL-13] out-of-scope cards carry Absorb / Change order / Reject; each button decides with its outcome", async () => {
    const a = await oosTask();
    const card = await outcomeCard(a.title);
    expect(card.html).toMatch(/ក្រៅវិសាលភាព/); // ops reads Khmer
    const [absorb, changeOrder, reject] = buttons(card);
    expect(buttons(card)).toHaveLength(3);
    const rows = await t.db
      .selectFrom("telegram_actions")
      .select(["decision", "outcome"])
      .where("approval_id", "=", a.oosApprovalId)
      .where("telegram_user_id", "=", BigInt(OPS_TG))
      .execute();
    expect(rows.map((r) => `${r.decision}:${r.outcome}`).sort()).toEqual([
      "approve:absorb",
      "reject:change_order",
      "reject:reject",
    ]);
    await press(FIN_TG, changeOrder!); // wrong user
    expect((await decided(a.oosApprovalId)).status).toBe("pending");
    await press(OPS_TG, changeOrder!, card.messageId);
    expect(await decided(a.oosApprovalId)).toEqual({
      status: "rejected",
      outcome: "change_order",
      decided_by: ops.id,
      decided_channel: "telegram",
    });
    expect(last()).toMatchObject({ edit: true, html: "📝 ជ្រើសរើសលិខិតផ្លាស់ប្ដូរដោយ Vanna Ops" });
    await press(OPS_TG, absorb!); // siblings burned: the card is decided once
    await press(OPS_TG, reject!);
    expect(await decided(a.oosApprovalId)).toMatchObject({ status: "rejected", outcome: "change_order" });

    const b = await oosTask();
    const cardB = await outcomeCard(b.title);
    await press(OPS_TG, buttons(cardB)[0]!, cardB.messageId); // Absorb
    expect(await decided(b.oosApprovalId)).toMatchObject({ status: "approved", outcome: "absorb" });
    const task = await t.db.selectFrom("tasks").select("oos_status").where("id", "=", b.id).executeTakeFirstOrThrow();
    expect(task.oos_status).toBe("approved");
    expect(await t.db.selectFrom("giveaway_entries").select("kind").where("source_id", "=", b.oosApprovalId).execute()).toEqual([
      { kind: "absorbed_out_of_scope" },
    ]);

    const c = await oosTask();
    const cardC = await outcomeCard(c.title);
    await press(OPS_TG, buttons(cardC)[2]!, cardC.messageId); // Reject
    expect(await decided(c.oosApprovalId)).toMatchObject({ status: "rejected", outcome: "reject" });
  });

  it("[TSK-DL-13] a round-4 request is an out-of-scope card too; a quality-check card keeps approve / reject", async () => {
    const x = await ex<{ id: string }>(pm, tasks.taskCreate, {
      projectId,
      title: "TG key visual",
      ownerId: designer.id,
      estimateMinutes: 240,
      dueDate: "2026-11-05",
      scopeItemId: (
        await t.db
          .selectFrom("scope_items as i")
          .innerJoin("projects as p", "p.scope_id", "i.scope_id")
          .select("i.id")
          .where("p.id", "=", projectId)
          .where("i.kind", "=", "fee")
          .executeTakeFirstOrThrow()
      ).id,
      clientFacing: true,
    });
    await ex(designer, tasks.taskMove, { id: x.id, expectedVersion: await version(x.id), to: "in_progress" });
    // QC card: two buttons for the owner's team lead; one tap approves.
    const q = await ex<{ qualityApprovalId: string }>(designer, tasks.taskSubmitQc, {
      id: x.id,
      expectedVersion: await version(x.id),
    });
    sent = [];
    await say(TL_TG, "/inbox");
    const qcCard = sent.find((s) => s.html.includes("TG key visual") && buttons(s).length)!;
    expect(qcCard.html).toMatch(/Quality check/);
    expect(buttons(qcCard)).toHaveLength(2);
    await press(TL_TG, buttons(qcCard)[0]!, qcCard.messageId);
    expect(last().html).toBe("✅ Approved by Rith Lead");
    expect((await decided(q.qualityApprovalId)).status).toBe("approved");
    // Three normal rounds, then the round-4 request.
    const deliver = async () => {
      await ex(designer, tasks.taskMarkSent, { id: x.id, expectedVersion: await version(x.id), sentReference: "KV v1" });
    };
    await deliver();
    for (let r = 1; r <= 3; r++) {
      await ex(pm, tasks.taskRequestRevision, { id: x.id, expectedVersion: await version(x.id), note: "Warmer" });
      const qq = await ex<{ qualityApprovalId: string }>(designer, tasks.taskSubmitQc, {
        id: x.id,
        expectedVersion: await version(x.id),
      });
      await ex(teamLead, approvals.approvalDecide, { id: qq.qualityApprovalId, decision: "approve" });
      await deliver();
    }
    const r4 = await ex<{ outOfScopeApprovalId: string }>(pm, tasks.taskRequestRevision, {
      id: x.id,
      expectedVersion: await version(x.id),
      note: "A new concept",
      reworkMinutes: 120,
    });
    const card = await outcomeCard("TG key visual (revision round 4)");
    expect(buttons(card)).toHaveLength(3);
    await press(OPS_TG, buttons(card)[0]!, card.messageId); // Absorb
    expect(await decided(r4.outOfScopeApprovalId)).toMatchObject({ status: "approved", outcome: "absorb" });
    const task = await t.db
      .selectFrom("tasks")
      .select(["status", "revision_round", "oos_decision"])
      .where("id", "=", x.id)
      .executeTakeFirstOrThrow();
    expect(task).toEqual({ status: "in_progress", revision_round: 4, oos_decision: "absorb" });
  });
});
