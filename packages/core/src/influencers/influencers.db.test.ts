import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptedProject, createTestDb, makeUser, meta, runAs, type AcceptedProject, type TestDb } from "@demoq/testkit";
import { approvalDecide } from "../approvals";
import { DomainError, execute, sha256, type LinkActor, type OpDef, type UserActor } from "../kernel";
import { gateSatisfy } from "../projects";
import {
  assignmentCreate,
  assignmentList,
  assignmentUpdate,
  influencerCreate,
  influencerList,
  influencerUpdate,
  linkExpireDue,
  linkIssue,
  linkList,
  linkRevoke,
  linkSubmit,
  linkView,
  resolveLinkActor,
  workList,
  workSummary,
} from "./index";

let t: TestDb;
let lead: UserActor, pm: UserActor, otherPm: UserActor, im: UserActor, im2: UserActor, ops: UserActor, staff: UserActor;

beforeAll(async () => {
  t = await createTestDb("2026-12-01T02:00:00.000Z");
  lead = await makeUser(t.db, { roles: ["account_lead"], name: "Sokha Lead" });
  pm = await makeUser(t.db, { roles: ["project_manager"], name: "Piseth PM" });
  otherPm = await makeUser(t.db, { roles: ["project_manager"] });
  im = await makeUser(t.db, { roles: ["influencer_manager"], name: "Dara Influence" });
  im2 = await makeUser(t.db, { roles: ["influencer_manager"], name: "Kanha Influence" });
  ops = await makeUser(t.db, { roles: ["ops_lead"] });
  staff = await makeUser(t.db, { roles: ["staff"] });
});
afterAll(() => t.destroy());

type Channel = "web" | "mcp";
const run = <T>(a: UserActor, op: OpDef, input: unknown, channel?: Channel) => runAs<T>(t, a, op, input, channel);
const expectCode = (p: Promise<unknown>, code: string, status?: number) =>
  expect(p).rejects.toSatisfy(
    (e: unknown) => e instanceof DomainError && e.code === code && (status === undefined || e.status === status),
  );

const TODAY = "2026-12-01";
const gatedProject = () => acceptedProject(t, lead, { pmId: pm.id });
async function openProject() {
  const p = await gatedProject();
  for (const gate of ["contract", "purchase_order", "deposit_terms"])
    await run(pm, gateSatisfy, { projectId: p.projectId, gate, evidence: `REF-${gate}` });
  return p;
}
const scopeItems = async (p: AcceptedProject) =>
  (await t.db.selectFrom("scope_items").select("id").where("scope_id", "=", p.scopeId).orderBy("created_at").execute()).map(
    (r) => r.id,
  );
let n = 0;
const newInfluencer = async (name = `Srey Pich ${++n}`) =>
  run<{ id: string; version: number }>(im, influencerCreate, {
    displayName: name,
    handles: [{ platform: "tiktok", handle: `@sreypich${n}` }],
    phone: "+855 12 000 000",
  });
async function assign(p: AcceptedProject, extra: Record<string, unknown> = {}, by: UserActor = pm) {
  const inf = await newInfluencer();
  const [item] = await scopeItems(p);
  const a = await run<{ id: string; version: number }>(by, assignmentCreate, {
    projectId: p.projectId,
    scopeItemId: item,
    influencerId: inf.id,
    contractedPosts: 3,
    ...extra,
  });
  return { ...a, influencerId: inf.id };
}
type Issued = { id: string; token: string; path: string; expiresAt: Date; maxSubmissions: number; status: string };
const issue = (assignmentId: string, extra: Record<string, unknown> = {}, by: UserActor = im) =>
  run<Issued>(by, linkIssue, { assignmentId, ...extra });

const linkMeta = async (token: string) => {
  const actor = await resolveLinkActor(t.kernel, token);
  if (!actor) throw new DomainError("NOT_FOUND");
  return meta(actor, "link", { ip: "203.0.113.7", userAgent: "Mozilla/5.0 (Linux; Android 14) TestPhone" });
};
let post = 0;
const body = (extra: Record<string, unknown> = {}) => ({
  postUrl: `https://www.tiktok.com/@sreypich/video/${++post}`,
  postedOn: TODAY,
  metrics: { views: 12000, likes: 900 },
  proofUrls: ["https://drive.example.com/s/insights"],
  note: "Posted at 7pm",
  ...extra,
});
type Submitted = { id: string; status: string; submissions: { used: number; max: number; remaining: number } };
const submit = async (token: string, extra: Record<string, unknown> = {}) =>
  execute(t.kernel, await linkMeta(token), linkSubmit, { ...body(extra), token }) as Promise<Submitted>;
const view = async (token: string) =>
  execute(t.kernel, await linkMeta(token), linkView, { token }) as Promise<Record<string, unknown>>;
const log = (id: string) => t.db.selectFrom("influencer_work_logs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const approvalOf = (id: string) => t.db.selectFrom("approvals").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

describe("influencers/roster", () => {
  it("[INF-RS-01] roster managers keep the roster; link issuers read it without contact details", async () => {
    const inf = await newInfluencer("Vanna Glow");
    await expectCode(run(pm, influencerCreate, { displayName: "Not allowed" }), "FORBIDDEN");
    await expectCode(run(staff, influencerCreate, { displayName: "Not allowed" }), "FORBIDDEN");
    await run(ops, influencerCreate, { displayName: "Ops Added", handles: [{ platform: "facebook", handle: "ops.added" }] });
    await expectCode(run(im, influencerCreate, { displayName: "  " }), "VALIDATION");
    await expectCode(
      run(im, influencerCreate, { displayName: "Bad", handles: [{ platform: "myspace", handle: "x" }] }),
      "VALIDATION",
    );

    const forPm = await run<Record<string, unknown>[]>(pm, influencerList, { q: "Vanna" });
    expect(forPm).toHaveLength(1);
    expect(forPm[0]).toMatchObject({ displayName: "Vanna Glow", handles: [{ platform: "tiktok" }] });
    expect(forPm[0]).not.toHaveProperty("phone");
    const forIm = await run<Record<string, unknown>[]>(im, influencerList, { q: "Vanna" });
    expect(forIm[0]).toMatchObject({ phone: "+855 12 000 000" });
    await expectCode(run(staff, influencerList, {}), "FORBIDDEN");

    await expectCode(run(im, influencerUpdate, { id: inf.id, expectedVersion: 99, displayName: "X" }), "STALE_VERSION");
    const up = await run<{ version: number }>(im, influencerUpdate, {
      id: inf.id,
      expectedVersion: inf.version,
      displayName: "Vanna G.",
    });
    expect(up.version).toBe(inf.version + 1);
  });

  it("[INF-RS-02] influencer managers (any) and the project's PMs (assigned) assign an influencer to a deliverable", async () => {
    const p = await openProject();
    const [item] = await scopeItems(p);
    const inf = await newInfluencer();
    const input = {
      projectId: p.projectId,
      scopeItemId: item,
      influencerId: inf.id,
      contractedPosts: 3,
      perPostPassthroughMinor: "5000",
    };
    await expectCode(run(otherPm, assignmentCreate, input), "FORBIDDEN");
    await expectCode(run(staff, assignmentCreate, input), "FORBIDDEN");
    await expectCode(run(pm, assignmentCreate, { ...input, contractedPosts: 0 }), "VALIDATION");
    const a = await run<{ id: string; version: number }>(pm, assignmentCreate, input);
    await expectCode(run(im, assignmentCreate, input), "CONFLICT");
    const row = await t.db.selectFrom("influencer_assignments").selectAll().where("id", "=", a.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ contracted_posts: 3, per_post_passthrough_minor: 5000n, currency: "USD", created_by: pm.id });

    const list = await run<Record<string, unknown>[]>(im, assignmentList, { projectId: p.projectId });
    expect(list).toEqual([
      expect.objectContaining({ id: a.id, contractedPosts: 3, perPostPassthroughMinor: 5000n, currency: "USD" }),
    ]);
    await expectCode(run(otherPm, assignmentList, { projectId: p.projectId }), "FORBIDDEN");

    await expectCode(run(otherPm, assignmentUpdate, { id: a.id, expectedVersion: a.version, contractedPosts: 5 }), "FORBIDDEN");
    const up = await run<{ contractedPosts: number }>(im, assignmentUpdate, {
      id: a.id,
      expectedVersion: a.version,
      contractedPosts: 5,
      perPostPassthroughMinor: null,
    });
    expect(up.contractedPosts).toBe(5);
    const after = await t.db.selectFrom("influencer_assignments").selectAll().where("id", "=", a.id).executeTakeFirstOrThrow();
    expect(after).toMatchObject({ per_post_passthrough_minor: null, currency: null });
  });

  it("[INF-RS-03] the deliverable must be in the project's scope; keys never change (DB backstop as the app role)", async () => {
    const p = await openProject();
    const other = await openProject();
    const inf = await newInfluencer();
    const [foreign] = await scopeItems(other);
    await expectCode(
      run(pm, assignmentCreate, { projectId: p.projectId, scopeItemId: foreign, influencerId: inf.id, contractedPosts: 1 }),
      "VALIDATION",
    );
    await expect(
      sql`INSERT INTO influencer_assignments (project_id, scope_item_id, influencer_id, contracted_posts, created_by)
          VALUES (${p.projectId}, ${foreign}, ${inf.id}, 1, ${pm.id})`.execute(t.db),
    ).rejects.toThrow(/scope item/);
    const a = await assign(p);
    await expect(
      sql`UPDATE influencer_assignments SET project_id = ${other.projectId} WHERE id = ${a.id}`.execute(t.db),
    ).rejects.toThrow(/never change/);
    await expect(sql`UPDATE influencer_assignments SET contracted_posts = 0 WHERE id = ${a.id}`.execute(t.db)).rejects.toThrow(
      /check/i,
    );
  });

  it("[INF-RS-04] deactivating an assignment or an influencer revokes their live links at once", async () => {
    const p = await openProject();
    const a = await assign(p);
    const l1 = await issue(a.id);
    await run(pm, assignmentUpdate, { id: a.id, expectedVersion: a.version, active: false });
    await expectCode(view(l1.token), "LINK_EXPIRED", 410);
    await expectCode(issue(a.id), "INVALID_TRANSITION");

    const b = await assign(p);
    const l2 = await issue(b.id);
    const inf = await t.db.selectFrom("influencers").select("version").where("id", "=", b.influencerId).executeTakeFirstOrThrow();
    const r = await run<{ linksRevoked: number }>(im, influencerUpdate, {
      id: b.influencerId,
      expectedVersion: inf.version,
      active: false,
    });
    expect(r.linksRevoked).toBe(1);
    await expect(view(l2.token)).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainError && e.code === "LINK_EXPIRED" && e.params.reason === "revoked",
    );
  });
});

describe("influencers/links", () => {
  it("[INF-LK-01] M2 #11 256-bit: a 32-byte token shown once; only its SHA-256 is stored, never the token", async () => {
    const p = await openProject();
    const a = await assign(p);
    const l = await issue(a.id);
    const again = await issue(a.id);
    expect(l.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(l.token, "base64url")).toHaveLength(32);
    expect(again.token).not.toBe(l.token);
    expect(l.path).toBe(`/l/${l.token}`);
    const row = await t.db.selectFrom("work_log_links").selectAll().where("id", "=", l.id).executeTakeFirstOrThrow();
    expect(row.token_hash).toBe(sha256(l.token));
    expect(JSON.stringify(row)).not.toContain(l.token);
    await submit(l.token);
    // Nowhere else either: audit (semantic and row-level) and outbox.
    const [ae, ac, ob] = await Promise.all([
      sql<{ n: bigint }>`SELECT count(*) AS n FROM audit_events WHERE strpos(input::text, ${l.token}) > 0`.execute(t.db),
      sql<{ n: bigint }>`SELECT count(*) AS n FROM audit_changes
                         WHERE strpos(coalesce(new_row::text, '') || coalesce(old_row::text, ''), ${l.token}) > 0`.execute(t.db),
      sql<{ n: bigint }>`SELECT count(*) AS n FROM outbox WHERE strpos(payload::text, ${l.token}) > 0`.execute(t.db),
    ]);
    expect([ae.rows[0]!.n, ac.rows[0]!.n, ob.rows[0]!.n].map(Number)).toEqual([0, 0, 0]);
    const listed = await run<Record<string, unknown>[]>(im, linkList, { assignmentId: a.id });
    expect(JSON.stringify(listed)).not.toContain(l.token);
    expect(JSON.stringify(listed)).not.toContain(row.token_hash);
    // DB: a stored value must look like a SHA-256 (a raw token cannot be stored by mistake), and never changes.
    await expect(
      sql`INSERT INTO work_log_links (assignment_id, token_hash, issued_by, issued_at, expires_at)
          VALUES (${a.id}, ${l.token}, ${im.id}, now(), now() + interval '7 days')`.execute(t.db),
    ).rejects.toThrow(/check/i);
    await expect(sql`UPDATE work_log_links SET token_hash = ${sha256("other")} WHERE id = ${l.id}`.execute(t.db)).rejects.toThrow(
      /never change/,
    );
  });

  it("[INF-LK-02] M2 #11 issue on a gated project returns 409 GATE_BLOCKED; only IMs and the project's PMs issue (DB backstop)", async () => {
    const gated = await gatedProject();
    const a = await assign(gated);
    await expectCode(issue(a.id), "GATE_BLOCKED", 409);
    await expectCode(issue(a.id, {}, pm), "GATE_BLOCKED", 409);
    await expect(
      sql`INSERT INTO work_log_links (assignment_id, token_hash, issued_by, issued_at, expires_at)
          VALUES (${a.id}, ${sha256("x")}, ${im.id}, now(), now() + interval '7 days')`.execute(t.db),
    ).rejects.toThrow(/GATE_BLOCKED/);

    const open = await openProject();
    const b = await assign(open);
    await expectCode(issue(b.id, {}, otherPm), "FORBIDDEN");
    await expectCode(issue(b.id, {}, staff), "FORBIDDEN");
    await expectCode(issue(b.id, {}, ops), "FORBIDDEN");
    const byPm = await issue(b.id, {}, pm);
    expect(byPm.status).toBe("active");
    await expectCode(run(im, linkIssue, { assignmentId: b.id }, "mcp"), "FORBIDDEN"); // web only
  });

  it("[INF-LK-03] D13 defaults: 7 days and 10 submissions; staff choose 1–30 days and 1–50 (DB CHECK)", async () => {
    const p = await openProject();
    const a = await assign(p);
    const l = await issue(a.id);
    expect(l.maxSubmissions).toBe(10);
    expect(new Date(l.expiresAt).getTime() - t.clock.now.getTime()).toBe(7 * 86_400_000);
    const custom = await issue(a.id, { expiresInDays: 2, maxSubmissions: 3 });
    expect(custom.maxSubmissions).toBe(3);
    await expectCode(issue(a.id, { expiresInDays: 31 }), "VALIDATION");
    await expectCode(issue(a.id, { maxSubmissions: 51 }), "VALIDATION");
    await expectCode(issue(a.id, { maxSubmissions: 0 }), "VALIDATION");
    await expect(
      sql`UPDATE work_log_links SET expires_at = issued_at + interval '31 days' WHERE id = ${l.id}`.execute(t.db),
    ).rejects.toThrow();
    await expect(
      sql`INSERT INTO work_log_links (assignment_id, token_hash, issued_by, issued_at, expires_at)
          VALUES (${a.id}, ${sha256("y")}, ${im.id}, now(), now() + interval '31 days')`.execute(t.db),
    ).rejects.toThrow(/work_log_links_expiry/);
  });

  it("[INF-LK-04] M2 #11 revocable: active → revoked / expired / exhausted; dead links stay dead (DB trigger)", async () => {
    const p = await openProject();
    const a = await assign(p);
    const l = await issue(a.id);
    await expect(view(l.token)).resolves.toMatchObject({ state: "active" });
    await expectCode(run(otherPm, linkRevoke, { id: l.id }), "FORBIDDEN");
    await run(pm, linkRevoke, { id: l.id, reason: "Wrong influencer" });
    await expect(submit(l.token)).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainError && e.code === "LINK_EXPIRED" && e.status === 410 && e.params.reason === "revoked",
    );
    await expectCode(run(pm, linkRevoke, { id: l.id }), "INVALID_TRANSITION");
    await expect(sql`UPDATE work_log_links SET status = 'active' WHERE id = ${l.id}`.execute(t.db)).rejects.toThrow();
    const live = await issue(a.id);
    await expect(sql`UPDATE work_log_links SET max_submissions = 50 WHERE id = ${live.id}`.execute(t.db)).rejects.toThrow(
      /never change/,
    );
    // Per-request check is authoritative: overdue is dead before the job runs.
    const soon = await issue(a.id, { expiresInDays: 1 });
    t.clock.advance(86_400_000);
    try {
      await expect(view(soon.token)).rejects.toSatisfy(
        (e: unknown) => e instanceof DomainError && e.code === "LINK_EXPIRED" && e.params.reason === "expired",
      );
      const row = await t.db.selectFrom("work_log_links").select("status").where("id", "=", soon.id).executeTakeFirstOrThrow();
      expect(row.status).toBe("active");
    } finally {
      t.clock.advance(-86_400_000);
    }
  });

  it("[INF-LK-05] staff list links without the token; the hourly job marks overdue links expired, idempotently", async () => {
    const p = await openProject();
    const a = await assign(p);
    const l = await issue(a.id, { expiresInDays: 1, maxSubmissions: 4 });
    await submit(l.token);
    const [listed] = await run<Record<string, unknown>[]>(pm, linkList, { assignmentId: a.id });
    expect(listed).toMatchObject({ id: l.id, state: "active", used: 1, remaining: 3, maxSubmissions: 4, issuedBy: im.name });
    expect(Object.keys(listed!)).not.toContain("token");
    await expectCode(run(otherPm, linkList, { assignmentId: a.id }), "FORBIDDEN");

    const job = { type: "job" as const, name: "job:influencers", grants: ["influencer.jobs" as const] };
    await expectCode(run(ops, linkExpireDue, {}), "FORBIDDEN");
    t.clock.advance(2 * 86_400_000);
    try {
      const r = await runAs<{ expired: number }>(t, job, linkExpireDue, {});
      expect(r.expired).toBeGreaterThanOrEqual(1);
      expect((await runAs<{ expired: number }>(t, job, linkExpireDue, {})).expired).toBe(0);
      const row = await t.db.selectFrom("work_log_links").select("status").where("id", "=", l.id).executeTakeFirstOrThrow();
      expect(row.status).toBe("expired");
      const [after] = await run<Record<string, unknown>[]>(pm, linkList, { assignmentId: a.id });
      expect(after!.state).toBe("expired");
    } finally {
      t.clock.advance(-2 * 86_400_000);
    }
  });

  it("[INF-LK-06] M2 #11 works with no login and only for its own assignment; staff cannot use link ops", async () => {
    const p = await openProject();
    const a = await assign(p);
    const b = await assign(p);
    const la = await issue(a.id);
    const lb = await issue(b.id);
    const actorA = (await resolveLinkActor(t.kernel, la.token))!;
    expect(actorA).toMatchObject({
      type: "influencer_link",
      name: `link:${a.id}`,
      assignmentId: a.id,
      grants: ["influencer.link.use"],
    });
    const info = await view(la.token);
    expect(info).toMatchObject({ contractedPosts: 3, submissions: { used: 0, max: 10, remaining: 10 } });
    const s = await submit(la.token);
    expect((await log(s.id)).assignment_id).toBe(a.id);

    // Link A's actor with link B's token (or a forged actor): nothing.
    await expectCode(execute(t.kernel, meta(actorA, "link"), linkSubmit, { ...body(), token: lb.token }), "NOT_FOUND");
    const forged: LinkActor = { ...actorA, linkId: lb.id };
    await expectCode(execute(t.kernel, meta(forged, "link"), linkView, { token: la.token }), "NOT_FOUND");
    expect(await resolveLinkActor(t.kernel, "x".repeat(43))).toBeNull();
    expect(await resolveLinkActor(t.kernel, "not a token")).toBeNull();
    // Staff: not on their channels, and no grant on the link channel.
    await expectCode(execute(t.kernel, meta(im, "web"), linkSubmit, { ...body(), token: la.token }), "FORBIDDEN");
    await expectCode(execute(t.kernel, meta(im, "link"), linkView, { token: la.token }), "FORBIDDEN");
    // The link actor holds nothing else.
    await expectCode(execute(t.kernel, meta(actorA, "web"), workList, { projectId: p.projectId }), "FORBIDDEN");
    await expectCode(execute(t.kernel, meta(actorA, "link"), workSummary, { projectId: p.projectId }), "FORBIDDEN");
  });

  it("[INF-LK-07] M2 #11 submission cap and expired → 410 LINK_EXPIRED; the cap holds under concurrency (DB backstop)", async () => {
    const p = await openProject();
    const a = await assign(p, { contractedPosts: 10 });
    const l = await issue(a.id, { maxSubmissions: 2 });
    const first = await submit(l.token);
    expect(first.submissions).toEqual({ used: 1, max: 2, remaining: 1 });
    await submit(l.token);
    await expect(submit(l.token)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DomainError && e.code === "LINK_EXPIRED" && e.status === 410 && e.params.reason === "exhausted",
    );
    expect(
      (await t.db.selectFrom("work_log_links").select("status").where("id", "=", l.id).executeTakeFirstOrThrow()).status,
    ).toBe("exhausted");

    const race = await issue(a.id, { maxSubmissions: 1 });
    const results = await Promise.allSettled([submit(race.token), submit(race.token)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((refused.reason as DomainError).code).toBe("LINK_EXPIRED");

    const exp = await issue(a.id, { expiresInDays: 1 });
    t.clock.advance(86_400_000 + 1);
    try {
      await expectCode(submit(exp.token), "LINK_EXPIRED", 410);
    } finally {
      t.clock.advance(-86_400_000 - 1);
    }
    // DB: beyond the cap, or through a dead link, as the app role.
    await expect(
      sql`INSERT INTO influencer_work_logs (assignment_id, link_id, post_url, posted_on, submitted_at)
          VALUES (${a.id}, ${l.id}, 'https://example.com/extra', ${TODAY}, now())`.execute(t.db),
    ).rejects.toThrow(/LINK_EXPIRED/);
    const other = await assign(p);
    const live = await issue(other.id);
    await expect(
      sql`INSERT INTO influencer_work_logs (assignment_id, link_id, post_url, posted_on, submitted_at)
          VALUES (${a.id}, ${live.id}, 'https://example.com/elsewhere', ${TODAY}, now())`.execute(t.db),
    ).rejects.toThrow(/does not reach/);
  });

  it("[INF-LK-08] submissions are validated (http(s) only, ≤ 5 proof links, no unknown fields), stored as sent with IP and UA", async () => {
    const p = await openProject();
    const a = await assign(p, { contractedPosts: 20 });
    const l = await issue(a.id, { maxSubmissions: 50 });
    const bad: Record<string, unknown>[] = [
      { postUrl: "javascript:alert(1)" },
      { postUrl: "ftp://files.example.com/x" },
      { postUrl: "https://user:pw@example.com/x" },
      { postUrl: "https://exa mple.com/x" },
      { postUrl: "" },
      { proofUrls: Array.from({ length: 6 }, (_, k) => `https://example.com/p${k}`) },
      { proofUrls: ["data:text/html,<script>alert(1)</script>"] },
      { metrics: { views: -1 } },
      { metrics: { views: 1.5 } },
      { metrics: { followers: 10 } },
      { postedOn: "2026-02-31" },
      { postedOn: "2026-12-02" }, // tomorrow in Phnom Penh
      { note: "x".repeat(1001) },
      { assignmentId: a.id },
      { status: "approved" },
    ];
    for (const b of bad) await expectCode(submit(l.token, b), "VALIDATION");
    await expectCode(execute(t.kernel, await linkMeta(l.token), linkSubmit, { token: l.token, postedOn: TODAY }), "VALIDATION");

    const s = await submit(l.token, {
      postUrl: "https://www.tiktok.com/@sreypich/video/777?lang=km",
      note: "<script>alert('x')</script> ក្រុមហ៊ុន",
      metrics: {},
      proofUrls: [],
    });
    const row = await log(s.id);
    expect(row).toMatchObject({
      post_url: "https://www.tiktok.com/@sreypich/video/777?lang=km",
      note: "<script>alert('x')</script> ក្រុមហ៊ុន",
      ip: "203.0.113.7",
      user_agent: "Mozilla/5.0 (Linux; Android 14) TestPhone",
      status: "submitted",
      over_quantity: false,
    });
    await expect(submit(l.token, { postUrl: "https://www.tiktok.com/@sreypich/video/777?lang=km" })).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainError && e.code === "CONFLICT" && e.params.reason === "post_already_submitted",
    );
    // DB CHECKs as the app role: http(s) only, ≤ 5 proof links; content never changes.
    await expect(
      sql`UPDATE influencer_work_logs SET status = status, post_url = 'javascript:x' WHERE id = ${s.id}`.execute(t.db),
    ).rejects.toThrow();
    await expect(
      sql`INSERT INTO influencer_work_logs (assignment_id, link_id, post_url, posted_on, submitted_at, proof_urls)
          VALUES (${a.id}, ${l.id}, 'https://example.com/ok', ${TODAY}, now(), ${["ftp://x"]})`.execute(t.db),
    ).rejects.toThrow(/check/i);
    await expect(sql`UPDATE influencer_work_logs SET note = 'edited' WHERE id = ${s.id}`.execute(t.db)).rejects.toThrow(
      /never changes/,
    );
  });

  it("[INF-LK-09] M2 #11 submission on a gated project returns 409 GATE_BLOCKED (DB backstop)", async () => {
    const p = await openProject();
    const a = await assign(p);
    const l = await issue(a.id);
    // The contract gate goes missing again (e.g. a data correction) after the link was issued.
    await t.migrator
      .updateTable("project_gates")
      .set({ status: "missing", evidence: null, satisfied_at: null, satisfied_by: null })
      .where("project_id", "=", p.projectId)
      .where("gate", "=", "contract")
      .execute();
    await expectCode(submit(l.token), "GATE_BLOCKED", 409);
    await expect(
      sql`INSERT INTO influencer_work_logs (assignment_id, link_id, post_url, posted_on, submitted_at)
          VALUES (${a.id}, ${l.id}, 'https://example.com/gated', ${TODAY}, now())`.execute(t.db),
    ).rejects.toThrow(/GATE_BLOCKED/);
    expect(await t.db.selectFrom("influencer_work_logs").select("id").where("assignment_id", "=", a.id).execute()).toEqual([]);
  });

  it("[INF-LK-10] M2 #11 submissions stay pending until a DemoQ person approves (INV-13); not the link's issuer", async () => {
    const p = await openProject();
    const a = await assign(p, { contractedPosts: 3 });
    const l = await issue(a.id); // issued by im
    const s1 = await submit(l.token);
    const s2 = await submit(l.token);
    const row = await log(s1.id);
    expect(row.status).toBe("submitted");
    const ap = await approvalOf(row.approval_id!);
    expect(ap).toMatchObject({
      kind: "influencer_work",
      subject_type: "influencer_work_log",
      subject_id: s1.id,
      requested_by: im.id,
      required_permission: "influencer.work.approve",
      status: "pending",
    });
    expect(ap.assignee_id).not.toBe(im.id);
    let summary = await run<Record<string, unknown>[]>(staff, workSummary, { projectId: p.projectId });
    expect(summary).toEqual([
      expect.objectContaining({ assignmentId: a.id, contractedPosts: 3, approved: 0, pending: 2, outstanding: 3 }),
    ]);

    await expectCode(run(im, approvalDecide, { id: ap.id, decision: "approve" }), "SELF_APPROVAL");
    await expectCode(run(otherPm, approvalDecide, { id: ap.id, decision: "approve" }), "FORBIDDEN");
    // INV-13 backstop: nobody flips a submission to approved without its approval.
    await expect(
      sql`UPDATE influencer_work_logs SET status = 'approved', decided_by = ${pm.id}, decided_at = now() WHERE id = ${s2.id}`.execute(
        t.db,
      ),
    ).rejects.toThrow(/influencer_work approval/);
    await expect(
      sql`SELECT count(*) FROM v_influencer_work_approved WHERE assignment_id = ${a.id}`.execute(t.db),
    ).resolves.toMatchObject({
      rows: [{ count: 0n }],
    });

    await run(pm, approvalDecide, { id: ap.id, decision: "approve" });
    await run(im2, approvalDecide, { id: (await log(s2.id)).approval_id!, decision: "reject", note: "Post deleted" });
    expect((await log(s1.id)).status).toBe("approved");
    expect(await log(s2.id)).toMatchObject({ status: "rejected", decided_by: im2.id });
    summary = await run<Record<string, unknown>[]>(staff, workSummary, { projectId: p.projectId });
    expect(summary[0]).toMatchObject({ approved: 1, pending: 0, rejected: 1, outstanding: 2 });
    const approvedView = await t.db
      .selectFrom("v_influencer_work_approved")
      .selectAll()
      .where("assignment_id", "=", a.id)
      .execute();
    expect(approvedView.map((v) => v.id)).toEqual([s1.id]);
    const listed = await run<{ id: string; status: string }[]>(pm, workList, { projectId: p.projectId });
    expect(listed.map((x) => x.status).sort()).toEqual(["approved", "rejected"]);
    await expectCode(run(otherPm, workList, { projectId: p.projectId }), "FORBIDDEN");
    await expect(
      sql`UPDATE influencer_work_logs SET status = 'submitted', decided_by = NULL, decided_at = NULL WHERE id = ${s1.id}`.execute(
        t.db,
      ),
    ).rejects.toThrow(/already/);
  });

  it("[INF-LK-11] M2 #11 a submission over quantity raises an out-of-scope approval as well (rejected ones do not count)", async () => {
    const p = await openProject();
    const a = await assign(p, { contractedPosts: 1 });
    const l = await issue(a.id);
    const s1 = await submit(l.token);
    await run(pm, approvalDecide, { id: (await log(s1.id)).approval_id!, decision: "reject" });
    const s2 = await submit(l.token); // the rejected one freed the slot
    expect((await log(s2.id)).over_quantity).toBe(false);
    const s3 = await submit(l.token);
    const row = await log(s3.id);
    expect(row).toMatchObject({ over_quantity: true, status: "submitted" });
    const oos = await approvalOf(row.oos_approval_id!);
    expect(oos).toMatchObject({
      kind: "out_of_scope",
      subject_type: "influencer_extra_post",
      subject_id: s3.id,
      required_permission: "scope.oos.decide",
      status: "pending",
    });
    // The out-of-scope approval does not supersede the work approval of the same submission.
    expect((await approvalOf(row.approval_id!)).status).toBe("pending");
    await run(lead, approvalDecide, { id: oos.id, decision: "reject", outcome: "change_order" });
    expect((await log(s3.id)).oos_outcome).toBe("change_order");
    expect(await t.db.selectFrom("giveaway_entries").select("id").where("source_id", "=", s3.id).execute()).toEqual([]);
  });

  it("[INF-LK-12] absorb writes influencer_extra_unbilled at the per-post pass-through (else 0, valuation_pending); rejected work is corrected", async () => {
    const p = await openProject();
    const valued = await assign(p, { contractedPosts: 1, perPostPassthroughMinor: "15000" });
    const l = await issue(valued.id);
    await submit(l.token);
    const extra = await submit(l.token);
    const x = await log(extra.id);
    await run(ops, approvalDecide, { id: x.oos_approval_id!, decision: "approve" });
    expect((await log(extra.id)).oos_outcome).toBe("absorb");
    const rows = await t.db.selectFrom("giveaway_entries").selectAll().where("source_id", "=", extra.id).execute();
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "influencer_extra_unbilled",
        amount_usd_minor: 15000n,
        fx_rate_micros: 1_000_000n,
        attributed_month: "2026-12-01",
        client_id: p.clientId,
        project_id: p.projectId,
        source_type: "influencer_work_log",
        note: null,
      }),
    ]);
    // The absorbed post's work is then rejected: a correcting row, the original stays (insert-only ledger).
    await run(pm, approvalDecide, { id: x.approval_id!, decision: "reject" });
    const after = await t.db
      .selectFrom("giveaway_entries")
      .selectAll()
      .where("source_id", "=", extra.id)
      .orderBy("created_at")
      .execute();
    expect(after.map((r) => r.amount_usd_minor)).toEqual([15000n, -15000n]);
    expect(after[1]).toMatchObject({ adjusts_entry_id: rows[0]!.id, note: "work_rejected" });

    const unvalued = await assign(p, { contractedPosts: 1 });
    const l2 = await issue(unvalued.id);
    await submit(l2.token);
    const e2 = await log((await submit(l2.token)).id);
    await run(ops, approvalDecide, { id: e2.oos_approval_id!, decision: "approve", outcome: "absorb" });
    const pending = await t.db.selectFrom("giveaway_entries").selectAll().where("source_id", "=", e2.id).execute();
    expect(pending).toEqual([expect.objectContaining({ amount_usd_minor: 0n, note: "valuation_pending" })]);

    // Rejecting the work first cancels the pending out-of-scope approval: nothing to absorb.
    const e3 = await log((await submit(l2.token)).id);
    await run(pm, approvalDecide, { id: e3.approval_id!, decision: "reject" });
    expect((await approvalOf(e3.oos_approval_id!)).status).toBe("cancelled");
    await expectCode(run(ops, approvalDecide, { id: e3.oos_approval_id!, decision: "approve" }), "ALREADY_DECIDED");
  });

  it("[INF-LK-13] influencer_work is DECIDE_IN_APP over MCP (INV-19), and so is absorbing an extra post", async () => {
    const p = await openProject();
    const a = await assign(p, { contractedPosts: 1 });
    const l = await issue(a.id);
    const s1 = await log((await submit(l.token)).id);
    await expectCode(run(pm, approvalDecide, { id: s1.approval_id!, decision: "approve" }, "mcp"), "DECIDE_IN_APP", 403);
    await expectCode(run(pm, approvalDecide, { id: s1.approval_id!, decision: "reject" }, "mcp"), "DECIDE_IN_APP");
    const s2 = await log((await submit(l.token)).id);
    await expectCode(run(ops, approvalDecide, { id: s2.oos_approval_id!, decision: "approve" }, "mcp"), "DECIDE_IN_APP");
    expect((await approvalOf(s1.approval_id!)).status).toBe("pending");
    await run(pm, approvalDecide, { id: s1.approval_id!, decision: "approve" }, "web");
    expect((await log(s1.id)).status).toBe("approved");
  });

  it("[INF-LK-15] link views and submissions are audited as link:<assignment> on channel link, token redacted", async () => {
    const p = await openProject();
    const a = await assign(p);
    const l = await issue(a.id);
    await view(l.token);
    const s = await submit(l.token);
    const events = await t.db
      .selectFrom("audit_events")
      .selectAll()
      .where("actor_name", "=", `link:${a.id}`)
      .orderBy("id")
      .execute();
    expect(events.map((e) => [e.action, e.actor_type, e.channel, e.actor_id])).toEqual([
      ["link.view", "influencer_link", "link", null],
      ["link.submit", "influencer_link", "link", null],
    ]);
    expect(events[1]).toMatchObject({ subject_type: "influencer_work_log", subject_id: s.id });
    expect((events[1]!.input as Record<string, unknown>).token).toBe("[redacted]");
    const changes = await t.db
      .selectFrom("audit_changes")
      .select(["actor_name", "channel"])
      .where("table_name", "=", "influencer_work_logs")
      .where("row_id", "=", s.id)
      .execute();
    expect(changes).toEqual([{ actor_name: `link:${a.id}`, channel: "link" }]);
    const created = await t.db
      .selectFrom("approval_events")
      .select(["actor_name", "channel"])
      .where("approval_id", "=", (await log(s.id)).approval_id!)
      .execute();
    expect(created).toEqual([{ actor_name: `link:${a.id}`, channel: "link" }]);
  });
});
