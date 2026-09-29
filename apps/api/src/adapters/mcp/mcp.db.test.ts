import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execute, profile } from "@demoq/core";
import {
  createTestDb,
  engagementTypeId,
  line,
  makeClient,
  makeDeal,
  makeUser,
  meta,
  setMcpWrites,
  type TestDb,
} from "@demoq/testkit";
import { buildApp } from "../../app";
import type { Config } from "../../config";

let t: TestDb;
let app: FastifyInstance;
let base: string;
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
  t = await createTestDb();
  app = await buildApp(t.kernel, config);
  await setMcpWrites(t.migrator, true); // D-MC-3: off by default; these tests exercise write tools
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await app.close();
  await t.destroy();
});

async function tokenFor(user: Awaited<ReturnType<typeof makeUser>>, scopes: ("read" | "write")[] = ["read"]) {
  const r = await execute(t.kernel, meta(user), profile.tokenCreate, { label: "claude-code", scopes });
  return r.token as string;
}
async function connect(token: string) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

describe("channels/mcp", () => {
  it("[MCP-01] tools are generated from the registry with JSON schemas", async () => {
    const lead = await makeUser(t.db, { roles: ["account_lead"] });
    const c = await connect(await tokenFor(lead, ["read", "write"]));
    const { tools } = await c.listTools();
    const names = tools.map((x) => x.name);
    expect(names).toEqual(
      expect.arrayContaining(["client_list", "deal_move", "quote_get", "approval_inbox", "prepare_decide_approval"]),
    );
    // Approvals are decided over MCP only in two steps (prepare → confirm, specs/channels/mcp-oauth.md MCP-OA-14).
    expect(names).not.toContain("approval_decide");
    expect(names).not.toContain("quote_send"); // web + job only
    expect(names).not.toContain("user_create");
    const move = tools.find((x) => x.name === "deal_move")!;
    expect(move.inputSchema).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["id", "expectedVersion", "toStage"]),
    });
    await c.close();
  });

  it("[MCP-02] missing, wrong, expired or revoked tokens get 401 with WWW-Authenticate", async () => {
    const noAuth = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("www-authenticate")).toMatch(/^Bearer /);
    const bad = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer dq_pat_nope" }, body: "{}" });
    expect(bad.status).toBe(401);
    const u = await makeUser(t.db, { roles: ["staff"] });
    const tok = await tokenFor(u);
    const row = await t.db.selectFrom("api_tokens").select("id").where("user_id", "=", u.id).executeTakeFirstOrThrow();
    await execute(t.kernel, meta(u), profile.tokenRevoke, { id: row.id });
    await expect(connect(tok)).rejects.toThrow();
    const u2 = await makeUser(t.db, { roles: ["staff"] });
    const tok2 = await tokenFor(u2);
    t.clock.advance(31 * 86_400_000);
    await expect(connect(tok2)).rejects.toThrow();
    t.clock.set("2026-10-19T02:00:00Z");
  });

  it("[MCP-03] tokens are shown once, stored hashed, capped at 30 days, and record last use", async () => {
    const u = await makeUser(t.db, { roles: ["staff"] });
    const tok = await tokenFor(u);
    expect(tok).toMatch(/^dq_pat_/);
    const row = await t.db.selectFrom("api_tokens").selectAll().where("user_id", "=", u.id).executeTakeFirstOrThrow();
    expect(row.token_hash).not.toContain(tok.slice(7));
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBeLessThanOrEqual(30 * 86_400_000);
    await expect(execute(t.kernel, meta(u), profile.tokenCreate, { label: "x", days: 31 })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const c = await connect(tok);
    await c.listTools();
    await c.close();
    const after = await t.db.selectFrom("api_tokens").select("last_used_at").where("id", "=", row.id).executeTakeFirstOrThrow();
    expect(after.last_used_at).not.toBeNull();
  });

  it("[MCP-04] privileged roles get read-only tokens; a read token cannot call write tools", async () => {
    const fin = await makeUser(t.db, { roles: ["finance"] });
    await expect(execute(t.kernel, meta(fin), profile.tokenCreate, { label: "x", scopes: ["write"] })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const lead = await makeUser(t.db, { roles: ["account_lead"] });
    const c = await connect(await tokenFor(lead, ["read"]));
    const names = (await c.listTools()).tools.map((x) => x.name);
    expect(names).not.toContain("deal_move");
    const r = await c.callTool({ name: "client_create", arguments: { name: "Sneaky" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^FORBIDDEN/);
    await c.close();
  });

  it("[MCP-05] tools run the same rules and audit as the screens, by name, with the client label", async () => {
    const lead = await makeUser(t.db, { roles: ["account_lead"], name: "Sokha Lead" });
    const client = await makeClient(t.db, lead.id, "Angkor Beverages");
    const deal = await makeDeal(t.db, client.id, lead.id);
    const c = await connect(await tokenFor(lead, ["read", "write"]));
    const noReason = await c.callTool({ name: "deal_move", arguments: { id: deal.id, expectedVersion: 1, toStage: "lost" } });
    expect(noReason.isError).toBe(true);
    expect(text(noReason)).toMatch(/^CLOSE_REASON_REQUIRED/);
    const ok = await c.callTool({ name: "deal_move", arguments: { id: deal.id, expectedVersion: 1, toStage: "qualified" } });
    expect(ok.isError).toBeFalsy();
    const found = await c.callTool({ name: "client_list", arguments: { search: "angkor" } });
    expect(text(found)).toContain("Angkor Beverages");
    const rows = await t.db
      .selectFrom("audit_events")
      .select(["action", "actor_name", "channel", "mcp_client"])
      .where("actor_id", "=", lead.id)
      .where("channel", "=", "mcp")
      .orderBy("id")
      .execute();
    expect(rows).toEqual([
      { action: "deal.move", actor_name: "Sokha Lead", channel: "mcp", mcp_client: "pat:claude-code" },
      { action: "client.list", actor_name: "Sokha Lead", channel: "mcp", mcp_client: "pat:claude-code" },
    ]);
    await c.close();
  });

  it("[MCP-06] domain errors are tool errors with a stable code and localized text, never internals", async () => {
    const lead = await makeUser(t.db, { roles: ["account_lead"] });
    const fin = await makeUser(t.db, { roles: ["finance"], locale: "km" });
    const client = await makeClient(t.db, lead.id);
    const deal = await makeDeal(t.db, client.id, lead.id);
    const { commercial } = await import("@demoq/core");
    const et = await engagementTypeId(t.db);
    const q = await execute(t.kernel, meta(lead), commercial.quoteCreate, {
      dealId: deal.id,
      title: "Low",
      engagementTypeId: et,
    });
    const s = await execute(t.kernel, meta(lead), commercial.quoteSave, {
      id: q.id,
      expectedVersion: q.version,
      lines: [line("fee", 10, 5000, 4100)],
    });
    const sub = await execute(t.kernel, meta(lead), commercial.quoteSubmit, { id: q.id, expectedVersion: s.version });
    const c = await connect(await tokenFor(fin, ["read"]));
    void sub;
    const r = await c.callTool({ name: "confirm_decide_approval", arguments: { confirmToken: "dq_mct_0000000000" } });
    expect(r.isError).toBe(true);
    // A read token cannot decide anything at all; the Khmer message proves localisation.
    expect(text(r)).toMatch(/^FORBIDDEN: .*[ក-៿]/);
    await c.close();
    const lead2 = await makeUser(t.db, { roles: ["ops_lead"] });
    const c2 = await connect(await tokenFor(lead2, ["read"]));
    const bad = await c2.callTool({ name: "client_get", arguments: { id: "not-a-uuid" } });
    expect(text(bad)).toMatch(/^VALIDATION/);
    expect(text(bad)).not.toMatch(/stack|at .*\.ts/);
    await c2.close();
  });

  it("[MCP-07] more than 60 calls a minute gets 429 with Retry-After", async () => {
    const u = await makeUser(t.db, { roles: ["staff"] });
    const tok = await tokenFor(u);
    const call = () =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tok}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
    const codes: number[] = [];
    for (let i = 0; i < 62; i++) codes.push((await call()).status);
    expect(codes.slice(0, 60).every((c) => c === 200)).toBe(true);
    const last = await call();
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("[MCP-04] a write token turns read-only once its owner holds a privileged role", async () => {
    const u = await makeUser(t.db, { roles: ["account_lead"] });
    const tok = await tokenFor(u, ["read", "write"]);
    // Promote without going through user.set_roles (which would revoke the token): the adapter still refuses writes.
    await t.migrator.insertInto("user_roles").values({ user_id: u.id, role: "ops_lead" }).execute();
    const c = await connect(tok);
    expect((await c.listTools()).tools.map((x) => x.name)).not.toContain("deal_move");
    const r = await c.callTool({ name: "client_create", arguments: { name: "Promoted" } });
    expect(text(r)).toMatch(/^FORBIDDEN/);
    await c.close();
  });
});
