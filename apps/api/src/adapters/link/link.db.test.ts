import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { influencers, projects, type UserActor } from "@demoq/core";
import { errorMessage } from "@demoq/shared";
import { acceptedProject, createTestDb, makeUser, runAs, TEST_PASSWORD, type TestDb } from "@demoq/testkit";
import { buildApp, CSRF_HEADER, redactUrl, SESSION_COOKIE } from "../../app";
import type { Config } from "../../config";
import { newScheduleState, runSchedule } from "../../worker/schedule";
import { LINK_RATE_PER_MIN } from "./index";

let t: TestDb;
let app: FastifyInstance;
let lead: UserActor, pm: UserActor, im: UserActor & { email: string };
const config: Config = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://unused",
  PORT: 0,
  HOST: "127.0.0.1",
  TOTP_ENC_KEY: randomBytes(32).toString("base64"),
  LOGIN_RATE_PER_MIN: 1000,
  TRUST_PROXY_HOPS: 0,
};

beforeAll(async () => {
  t = await createTestDb("2026-12-01T02:00:00.000Z");
  app = await buildApp(t.kernel, config);
  lead = await makeUser(t.db, { roles: ["account_lead"] });
  pm = await makeUser(t.db, { roles: ["project_manager"] });
  im = await makeUser(t.db, { roles: ["influencer_manager"] });
});
afterAll(async () => {
  await app.close();
  await t.destroy();
});

// Each test talks from its own addresses so the per-IP limit of one test never trips another.
let ipSeq = 0;
const nextIp = () => `192.0.2.${++ipSeq}`;
const STAFF = { [CSRF_HEADER]: "1", "content-type": "application/json" };

async function signIn(email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: STAFF,
    payload: { email, password: TEST_PASSWORD },
    remoteAddress: nextIp(),
  });
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE)!;
  return `${SESSION_COOKIE}=${c.value}`;
}

async function openAssignment(contractedPosts = 3) {
  const p = await acceptedProject(t, lead, { pmId: pm.id });
  for (const gate of ["contract", "purchase_order", "deposit_terms"])
    await runAs(t, pm, projects.gateSatisfy, { projectId: p.projectId, gate, evidence: `REF-${gate}` });
  const inf = await runAs<{ id: string }>(t, im, influencers.influencerCreate, { displayName: "Bopha Beauty" });
  const item = await t.db.selectFrom("scope_items").select("id").where("scope_id", "=", p.scopeId).executeTakeFirstOrThrow();
  const a = await runAs<{ id: string }>(t, im, influencers.assignmentCreate, {
    projectId: p.projectId,
    scopeItemId: item.id,
    influencerId: inf.id,
    contractedPosts,
  });
  return { p, assignmentId: a.id };
}

/** Staff issue over REST (web only), exactly as the PWA will. */
async function issueOverRest(assignmentId: string, extra: Record<string, unknown> = {}) {
  const cookie = await signIn(im.email);
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/ops/influencer.link.issue",
    headers: { ...STAFF, cookie },
    payload: { assignmentId, ...extra },
    remoteAddress: nextIp(),
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; token: string; path: string };
}

const get = (token: string, ip: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: `/api/v1/link/${token}`, headers, remoteAddress: ip });
let post = 0;
const submission = (extra: Record<string, unknown> = {}) => ({
  postUrl: `https://www.instagram.com/p/post-${++post}/`,
  postedOn: "2026-11-30",
  metrics: { views: 5400, likes: 310 },
  proofUrls: ["https://drive.example.com/s/proof"],
  ...extra,
});
const submit = (token: string, ip: string, payload: unknown = submission(), headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: `/api/v1/link/${token}/submissions`,
    headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (iPhone) Test", ...headers },
    payload: payload as object,
    remoteAddress: ip,
  });

describe("public influencer link over HTTP", () => {
  it("[INF-LK-06] M2 #11 works with no login (no cookie, no CSRF header); unknown tokens are 404 with no detail; a staff cookie is not authority", async () => {
    const { assignmentId } = await openAssignment();
    const link = await issueOverRest(assignmentId);
    expect(link.path).toBe(`/l/${link.token}`);
    const ip = nextIp();

    const info = await get(link.token, ip);
    expect(info.statusCode).toBe(200);
    const body = info.json();
    expect(body).toMatchObject({
      state: "active",
      influencer: { displayName: "Bopha Beauty" },
      contractedPosts: 3,
      submissions: { used: 0, max: 10, remaining: 10 },
      accepts: { maxProofUrls: 5 },
    });
    expect(Object.keys(body.texts)).toEqual(["en", "km"]);
    expect(body.texts.en.privacyNotice).toMatch(/IP address/);
    expect(JSON.stringify(body.texts.km)).not.toContain("KM-DRAFT");
    expect(JSON.stringify(body)).not.toMatch(/assignment|project_?id|token/i);

    const created = await submit(link.token, ip); // no cookie, no x-psa-csrf
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ status: "submitted", submissions: { used: 1, remaining: 9 } });

    const unknown = await get(randomBytes(32).toString("base64url"), ip);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).not.toHaveProperty("params");
    expect((await get("short", ip)).statusCode).toBe(404);
    expect((await submit("short", ip)).statusCode).toBe(404);

    // A signed-in staff member gains nothing on these routes, and cannot reach link ops through REST.
    const cookie = await signIn(im.email);
    const withCookie = await get(randomBytes(32).toString("base64url"), ip, { cookie });
    expect(withCookie.statusCode).toBe(404);
    const viaOps = await app.inject({
      method: "POST",
      url: "/api/v1/ops/link.submit",
      headers: { ...STAFF, cookie },
      payload: { ...submission(), token: link.token },
      remoteAddress: ip,
    });
    expect(viaOps.statusCode).toBe(404);
  });

  it("[INF-LK-07] M2 #11 an expired, revoked or used-up link answers 410 LINK_EXPIRED with the reason (Khmer on request)", async () => {
    const { assignmentId } = await openAssignment(10);
    const ip = nextIp();
    const capped = await issueOverRest(assignmentId, { maxSubmissions: 1 });
    expect((await submit(capped.token, ip)).statusCode).toBe(201);
    const used = await submit(capped.token, ip);
    expect(used.statusCode).toBe(410);
    expect(used.json()).toMatchObject({ code: "LINK_EXPIRED", params: { reason: "exhausted" } });

    const revoked = await issueOverRest(assignmentId);
    await runAs(t, pm, influencers.linkRevoke, { id: revoked.id });
    const km = await get(revoked.token, ip, { "accept-language": "km" });
    expect(km.statusCode).toBe(410);
    expect(km.headers["content-type"]).toMatch(/application\/problem\+json/);
    expect(km.json()).toMatchObject({
      code: "LINK_EXPIRED",
      title: errorMessage("LINK_EXPIRED", "km"),
      params: { reason: "revoked" },
    });

    const soon = await issueOverRest(assignmentId, { expiresInDays: 1 });
    t.clock.advance(86_400_000);
    try {
      const expired = await get(soon.token, ip);
      expect(expired.statusCode).toBe(410);
      expect(expired.json().params).toEqual({ reason: "expired" });
    } finally {
      t.clock.advance(-86_400_000);
    }
  });

  it("[INF-LK-09] M2 #11 a submission on a gated project returns 409 GATE_BLOCKED without listing the gates", async () => {
    const { p, assignmentId } = await openAssignment();
    const link = await issueOverRest(assignmentId);
    await t.migrator
      .updateTable("project_gates")
      .set({ status: "missing", evidence: null, satisfied_at: null, satisfied_by: null })
      .where("project_id", "=", p.projectId)
      .where("gate", "=", "deposit_terms")
      .execute();
    const res = await submit(link.token, nextIp());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "GATE_BLOCKED" });
    expect(res.json()).not.toHaveProperty("params");
  });

  it("[INF-LK-08] validation over HTTP: 422 with issues, 413 for a big body, 415 for a form post; IP and user agent are stored", async () => {
    const { assignmentId } = await openAssignment(10);
    const link = await issueOverRest(assignmentId);
    const ip = nextIp();
    const bad = await submit(link.token, ip, submission({ postUrl: "javascript:alert(document.cookie)" }));
    expect(bad.statusCode).toBe(422);
    expect(bad.json().params.issues[0].path).toBe("postUrl");
    const big = await submit(link.token, ip, submission({ note: "x".repeat(20_000) }));
    expect(big.statusCode).toBe(413);
    const form = await app.inject({
      method: "POST",
      url: `/api/v1/link/${link.token}/submissions`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "postUrl=https://example.com",
      remoteAddress: ip,
    });
    expect(form.statusCode).toBe(415);
    const ok = await submit(link.token, ip);
    expect(ok.statusCode).toBe(201);
    const row = await t.db
      .selectFrom("influencer_work_logs")
      .select(["ip", "user_agent"])
      .where("id", "=", ok.json().id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ ip, user_agent: "Mozilla/5.0 (iPhone) Test" });
  });

  it("[INF-LK-14] M2 #11 rate limited: 20 a minute per IP and per token, then 429 with Retry-After; no-store, noindex, no-referrer", async () => {
    const { assignmentId } = await openAssignment();
    const link = await issueOverRest(assignmentId);
    const first = await get(link.token, nextIp());
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.headers["x-robots-tag"]).toMatch(/noindex/);
    expect(first.headers["referrer-policy"]).toBe("no-referrer");

    // Per IP: guessing tokens from one address.
    const ip = nextIp();
    for (let k = 0; k < LINK_RATE_PER_MIN; k++) {
      expect((await get(randomBytes(32).toString("base64url"), ip)).statusCode).toBe(404);
    }
    const limited = await get(randomBytes(32).toString("base64url"), ip);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);

    // Per token: one link hammered from many addresses (1 request already made above).
    for (let k = 1; k < LINK_RATE_PER_MIN; k++) expect((await get(link.token, nextIp())).statusCode).toBe(200);
    const tokenLimited = await get(link.token, nextIp());
    expect(tokenLimited.statusCode).toBe(429);
    expect((await submit(link.token, nextIp())).statusCode).toBe(429);
  });

  it("[INF-LK-05] the worker's hourly tick marks overdue links expired", async () => {
    const { assignmentId } = await openAssignment();
    const link = await issueOverRest(assignmentId, { expiresInDays: 1 });
    t.clock.advance(2 * 86_400_000);
    try {
      const logged: string[] = [];
      const state = newScheduleState();
      await runSchedule(t.kernel, state, { log: (m) => logged.push(m) });
      expect(logged).toContain("influencer_link_expiry");
      await runSchedule(t.kernel, state, { log: (m) => logged.push(m) });
      expect(logged.filter((m) => m === "influencer_link_expiry")).toHaveLength(1);
      const row = await t.db.selectFrom("work_log_links").select("status").where("id", "=", link.id).executeTakeFirstOrThrow();
      expect(row.status).toBe("expired");
    } finally {
      t.clock.advance(-2 * 86_400_000);
    }
  });

  it("[INF-LK-01] request logs never carry a link token (path masked) or a secret query parameter", async () => {
    const lines: string[] = [];
    const logged = await buildApp(t.kernel, config, { logStream: { write: (line) => void lines.push(line) } });
    try {
      const { assignmentId } = await openAssignment();
      const { token } = await issueOverRest(assignmentId);
      const view = await logged.inject({ method: "GET", url: `/api/v1/link/${token}`, remoteAddress: nextIp() });
      expect(view.statusCode).toBe(200);
      await logged.inject({
        method: "POST",
        url: `/api/v1/link/${token}/submissions`,
        payload: { postUrl: "https://www.tiktok.com/@log/video/1", postedOn: "2026-11-30" },
        remoteAddress: nextIp(),
      });
      await logged.inject({ method: "GET", url: `/l/${token}?lang=km`, remoteAddress: nextIp() });
      await logged.inject({ method: "GET", url: `/oauth/callback?code=${token}&state=abc`, remoteAddress: nextIp() });
      const all = lines.join("\n");
      expect(lines.length).toBeGreaterThanOrEqual(8); // incoming + completed per request
      expect(all).toContain("/api/v1/link/[redacted]");
      expect(all).toContain("/l/[redacted]?lang=km");
      expect(all).not.toContain(token);
    } finally {
      await logged.close();
    }
    expect(redactUrl(`/api/v1/link/abc/submissions?x=1`)).toBe("/api/v1/link/[redacted]/submissions?x=1");
    expect(redactUrl(`/oauth/token?client_secret=s3&grant_type=code`)).toBe(
      "/oauth/token?client_secret=[redacted]&grant_type=code",
    );
    expect(redactUrl(`/api/v1/ops/task.board?projectId=1`)).toBe("/api/v1/ops/task.board?projectId=1");
  });
});
