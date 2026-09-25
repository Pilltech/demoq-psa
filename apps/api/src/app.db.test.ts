import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identity } from "@demoq/core";
import { createTestDb, makeClient, makeDeal, makeUser, TEST_PASSWORD, type TestDb } from "@demoq/testkit";
import { buildApp, CSRF_HEADER, SESSION_COOKIE } from "./app";
import type { Config } from "./config";

let t: TestDb;
let app: FastifyInstance;
const config: Config = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://unused",
  PORT: 0,
  HOST: "127.0.0.1",
  TOTP_ENC_KEY: randomBytes(32).toString("base64"),
  LOGIN_RATE_PER_MIN: 5,
};

beforeAll(async () => {
  t = await createTestDb();
  app = await buildApp(t.kernel, config);
});
afterAll(async () => {
  await app.close();
  await t.destroy();
});

const H = { [CSRF_HEADER]: "1", "content-type": "application/json" };

async function signIn(email: string, extra: Record<string, string> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { ...H, ...extra, "x-forwarded-for": `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    payload: { email, password: TEST_PASSWORD },
  });
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  return { res, cookie: cookie ? `${SESSION_COOKIE}=${cookie.value}` : "" };
}

describe("api", () => {
  it("[ID-AU-04] login sets an HttpOnly, SameSite=Lax session cookie and returns my permissions", async () => {
    const u = await makeUser(t.db, { roles: ["account_lead"] });
    const { res } = await signIn(u.email);
    expect(res.statusCode).toBe(200);
    const c = res.cookies.find((x) => x.name === SESSION_COOKIE)!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe("Lax");
    const body = res.json();
    expect(body.user.permissions["deal.manage"]).toEqual(["own"]);
    expect(body.user.permissions["user.manage"]).toBeUndefined();
  });

  it("[ID-AU-06] a finance user cannot call any operation until TOTP is verified", async () => {
    const u = await makeUser(t.db, { roles: ["finance"] });
    const { res, cookie } = await signIn(u.email);
    expect(res.json().totp).toBe("enroll");
    const blocked = await app.inject({ method: "POST", url: "/api/v1/ops/client.list", headers: { ...H, cookie }, payload: {} });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().code).toBe("TOTP_REQUIRED");
    const enroll = await app.inject({ method: "POST", url: "/api/v1/auth/totp/enroll", headers: { ...H, cookie }, payload: {} });
    const { secret } = enroll.json();
    const verify = await app.inject({
      method: "POST",
      url: "/api/v1/auth/totp/verify",
      headers: { ...H, cookie },
      payload: { code: identity.currentTotpCode(secret, t.clock.now) },
    });
    expect(verify.statusCode).toBe(200);
    const ok = await app.inject({ method: "POST", url: "/api/v1/ops/client.list", headers: { ...H, cookie }, payload: {} });
    expect(ok.statusCode).toBe(200);
  });

  it("mutations without the CSRF header are refused", async () => {
    const u = await makeUser(t.db, { roles: ["account_lead"] });
    const { cookie } = await signIn(u.email);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ops/client.create",
      headers: { cookie, "content-type": "application/json" },
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("[CRM-CR-07] the golden slice over HTTP: 422 in Khmer without a reason, then success, then 403 for another lead", async () => {
    const lead = await makeUser(t.db, { roles: ["account_lead"], locale: "km" });
    const other = await makeUser(t.db, { roles: ["account_lead"] });
    const client = await makeClient(t.db, lead.id);
    const deal = await makeDeal(t.db, client.id, lead.id);
    const { cookie } = await signIn(lead.email);
    const noReason = await app.inject({
      method: "POST",
      url: "/api/v1/ops/deal.move",
      headers: { ...H, cookie },
      payload: { id: deal.id, expectedVersion: 1, toStage: "lost" },
    });
    expect(noReason.statusCode).toBe(422);
    expect(noReason.headers["content-type"]).toMatch(/application\/problem\+json/);
    expect(noReason.json()).toMatchObject({ code: "CLOSE_REASON_REQUIRED", status: 422 });
    expect(noReason.json().title).toMatch(/[ក-៿]/);

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/ops/deal.move",
      headers: { ...H, cookie },
      payload: { id: deal.id, expectedVersion: 1, toStage: "lost", closeReasonCode: "competitor" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ stage: "lost", version: 2 });

    const s2 = await signIn(other.email);
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/ops/deal.move",
      headers: { ...H, cookie: s2.cookie },
      payload: { id: deal.id, expectedVersion: 2, toStage: "qualified" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe("FORBIDDEN");
  });

  it("errors never leak internals; unknown ops are 404; anonymous calls are 401", async () => {
    const u = await makeUser(t.db, { roles: ["staff"] });
    const { cookie } = await signIn(u.email);
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/ops/deal.delete_everything",
      headers: { ...H, cookie },
      payload: {},
    });
    expect(unknown.statusCode).toBe(404);
    const anon = await app.inject({ method: "POST", url: "/api/v1/ops/client.list", headers: H, payload: {} });
    expect(anon.statusCode).toBe(401);
    const denied = await app.inject({ method: "POST", url: "/api/v1/ops/deal.list", headers: { ...H, cookie }, payload: {} });
    expect(denied.statusCode).toBe(403);
    expect(JSON.stringify(denied.json())).not.toMatch(/deal\.view|stack|constraint/i);
  });

  it("[ID-AU-10] login is rate-limited per IP", async () => {
    const ip = { "x-forwarded-for": "203.0.113.9" };
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { ...H, ...ip },
        payload: { email: "x@demoq.test", password: "nope" },
      });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});
