import { randomBytes } from "node:crypto";
import { Secret } from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makeTeam, makeUser, meta, TEST_PASSWORD, type TestDb } from "@demoq/testkit";
import { DomainError, execute, sha256, decryptSecret, type UserActor } from "../kernel";
import {
  beginTotpEnrollment,
  currentTotpCode,
  login,
  logout,
  LOCKOUT_MS,
  resolveSession,
  SESSION_IDLE_MS,
  verifyTotp,
} from "./auth";
import { teamCreate, userCreate, userDirectory, userSetRoles } from "./commands";

const cfg = { totpEncKey: randomBytes(32).toString("base64") };
let t: TestDb;
const authMeta = () => ({
  channel: "web" as const,
  requestId: `r_${randomBytes(3).toString("hex")}`,
  locale: "en" as const,
  ip: "10.0.0.1",
});
const expectCode = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.destroy());

describe("identity/auth", () => {
  it("[ID-AU-01] passwords are stored only as argon2id hashes", async () => {
    const u = await makeUser(t.db, { roles: ["staff"] });
    const row = await t.db.selectFrom("users").select("password_hash").where("id", "=", u.id).executeTakeFirstOrThrow();
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.password_hash).not.toContain(TEST_PASSWORD);
  });

  it("[ID-AU-02] unknown email and wrong password give the same error, and both are audited", async () => {
    const u = await makeUser(t.db, { roles: ["staff"] });
    await expectCode(login(t.kernel, { email: "nobody@demoq.test", password: "x" }, authMeta()), "INVALID_CREDENTIALS");
    await expectCode(login(t.kernel, { email: u.email, password: "wrong" }, authMeta()), "INVALID_CREDENTIALS");
    const rows = await t.db
      .selectFrom("audit_events")
      .select(["actor_name", "outcome", "input"])
      .where("action", "=", "auth.login")
      .where("outcome", "=", "denied")
      .execute();
    expect(rows.map((r) => r.actor_name)).toEqual(expect.arrayContaining(["nobody@demoq.test", u.email]));
  });

  it("[ID-AU-03] five wrong passwords lock the account for 15 minutes, with the same error", async () => {
    const u = await makeUser(t.db, { roles: ["staff"] });
    for (let i = 0; i < 5; i++)
      await expectCode(login(t.kernel, { email: u.email, password: "wrong" }, authMeta()), "INVALID_CREDENTIALS");
    await expectCode(login(t.kernel, { email: u.email, password: TEST_PASSWORD }, authMeta()), "INVALID_CREDENTIALS");
    t.clock.advance(LOCKOUT_MS + 1000);
    const ok = await login(t.kernel, { email: u.email, password: TEST_PASSWORD }, authMeta());
    expect(ok.session.actor.id).toBe(u.id);
  });

  it("[ID-AU-04] the session token is random and only its hash is stored", async () => {
    const u = await makeUser(t.db, { roles: ["staff"] });
    const { token } = await login(t.kernel, { email: u.email, password: TEST_PASSWORD }, authMeta());
    expect(token.length).toBeGreaterThanOrEqual(43);
    const s = await t.db.selectFrom("sessions").select("token_hash").where("user_id", "=", u.id).executeTakeFirstOrThrow();
    expect(s.token_hash).toBe(sha256(token));
    expect(await resolveSession(t.kernel, "not-a-token")).toBeNull();
  });

  it("[ID-AU-05] sessions end on idle timeout, on logout, and when roles change", async () => {
    const u = await makeUser(t.db, { roles: ["staff"] });
    const a = await login(t.kernel, { email: u.email, password: TEST_PASSWORD }, authMeta());
    expect((await resolveSession(t.kernel, a.token))?.actor.id).toBe(u.id);
    t.clock.advance(SESSION_IDLE_MS + 1000);
    expect(await resolveSession(t.kernel, a.token)).toBeNull();

    const b = await login(t.kernel, { email: u.email, password: TEST_PASSWORD }, authMeta());
    const sb = (await resolveSession(t.kernel, b.token))!;
    await logout(t.kernel, sb, authMeta());
    expect(await resolveSession(t.kernel, b.token)).toBeNull();

    const c = await login(t.kernel, { email: u.email, password: TEST_PASSWORD }, authMeta());
    const admin = await makeUser(t.db, { roles: ["admin"] });
    await execute(t.kernel, meta(admin), userSetRoles, { userId: u.id, expectedVersion: 1, roles: ["team_lead"] });
    expect(await resolveSession(t.kernel, c.token)).toBeNull();
  });

  it("[ID-AU-06] privileged roles must pass TOTP: enrol, then verify on each login", async () => {
    const u = await makeUser(t.db, { roles: ["finance"] });
    const first = await login(t.kernel, { email: u.email, password: TEST_PASSWORD }, authMeta());
    expect(first.session.totp).toBe("enroll");
    const { secret, uri } = await beginTotpEnrollment(t.kernel, cfg, first.session, authMeta());
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    await verifyTotp(t.kernel, cfg, first.session, currentTotpCode(secret, t.clock.now), authMeta());
    expect((await resolveSession(t.kernel, first.token))?.totp).toBe("ok");

    t.clock.advance(60_000);
    const second = await login(t.kernel, { email: u.email, password: TEST_PASSWORD }, authMeta());
    expect(second.session.totp).toBe("verify");
    expect((await resolveSession(t.kernel, second.token))?.totp).toBe("verify");
    await verifyTotp(t.kernel, cfg, second.session, currentTotpCode(secret, t.clock.now), authMeta());
    expect((await resolveSession(t.kernel, second.token))?.totp).toBe("ok");

    const staff = await makeUser(t.db, { roles: ["staff"] });
    expect((await login(t.kernel, { email: staff.email, password: TEST_PASSWORD }, authMeta())).session.totp).toBe("ok");
  });

  it("[ID-AU-07] a TOTP code cannot be replayed, and stale codes are refused", async () => {
    const u = await makeUser(t.db, { roles: ["director"] });
    const a = await login(t.kernel, { email: u.email, password: TEST_PASSWORD }, authMeta());
    const { secret } = await beginTotpEnrollment(t.kernel, cfg, a.session, authMeta());
    const code = currentTotpCode(secret, t.clock.now);
    await verifyTotp(t.kernel, cfg, a.session, code, authMeta());
    const b = await login(t.kernel, { email: u.email, password: TEST_PASSWORD }, authMeta());
    await expectCode(verifyTotp(t.kernel, cfg, b.session, code, authMeta()), "TOTP_INVALID");
    const old = currentTotpCode(secret, new Date(t.clock.now.getTime() - 5 * 60_000));
    t.clock.advance(30_000);
    await expectCode(verifyTotp(t.kernel, cfg, b.session, old, authMeta()), "TOTP_INVALID");
    await expectCode(verifyTotp(t.kernel, cfg, b.session, "000000", authMeta()), "TOTP_INVALID");
  });

  it("[ID-AU-08] TOTP seeds are encrypted at rest", async () => {
    const u = await makeUser(t.db, { roles: ["ceo"] });
    const a = await login(t.kernel, { email: u.email, password: TEST_PASSWORD }, authMeta());
    const { secret } = await beginTotpEnrollment(t.kernel, cfg, a.session, authMeta());
    const row = await t.db.selectFrom("users").select("totp_secret_enc").where("id", "=", u.id).executeTakeFirstOrThrow();
    expect(row.totp_secret_enc).not.toContain(secret);
    expect(decryptSecret(row.totp_secret_enc!, cfg.totpEncKey)).toBe(secret);
    expect(() => Secret.fromBase32(secret)).not.toThrow();
    const change = await t.db
      .selectFrom("audit_changes")
      .select("new_row")
      .where("table_name", "=", "users")
      .where("row_id", "=", u.id)
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect((change.new_row as { totp_secret_enc: string }).totp_secret_enc).toBe("[redacted]");
  });

  it("[ID-AU-09] sign-in, logout and TOTP verification are audited by name", async () => {
    const u = await makeUser(t.db, { roles: ["ops_lead"], name: "Audit Me" });
    const a = await login(t.kernel, { email: u.email, password: TEST_PASSWORD }, authMeta());
    const { secret } = await beginTotpEnrollment(t.kernel, cfg, a.session, authMeta());
    await verifyTotp(t.kernel, cfg, a.session, currentTotpCode(secret, t.clock.now), authMeta());
    await logout(t.kernel, a.session, authMeta());
    const actions = await t.db.selectFrom("audit_events").select("action").where("actor_id", "=", u.id).orderBy("id").execute();
    expect(actions.map((r) => r.action)).toEqual(["auth.login", "auth.totp_enroll_started", "auth.totp_enrolled", "auth.logout"]);
  });
});

describe("identity/users", () => {
  let admin: UserActor;
  beforeAll(async () => {
    admin = await makeUser(t.db, { roles: ["admin"], name: "Sys Admin" });
  });

  it("[ID-US-01] only admin creates users and teams", async () => {
    const ceo = await makeUser(t.db, { roles: ["ceo"] });
    const input = {
      email: "new.person@demoq.test",
      displayName: "New Person",
      roles: ["staff"],
      initialPassword: "a-long-password-123",
    };
    await expectCode(execute(t.kernel, meta(ceo), userCreate, input), "FORBIDDEN");
    await expectCode(execute(t.kernel, meta(ceo), teamCreate, { name: "Video" }), "FORBIDDEN");
    const r = await execute(t.kernel, meta(admin), userCreate, input);
    expect(r.email).toBe("new.person@demoq.test");
    const team = await execute(t.kernel, meta(admin), teamCreate, { name: "Video", nameKm: "វីដេអូ" });
    expect(team.name).toBe("Video");
  });

  it("[ID-US-02] an admin cannot change their own roles", async () => {
    await expectCode(
      execute(t.kernel, meta(admin), userSetRoles, { userId: admin.id, expectedVersion: 1, roles: ["admin", "ceo"] }),
      "FORBIDDEN",
    );
  });

  it("[ID-US-03] emails are unique regardless of case", async () => {
    await makeUser(t.db, { roles: ["staff"], email: "dup@demoq.test" });
    await expectCode(
      execute(t.kernel, meta(admin), userCreate, {
        email: "DUP@demoq.test",
        displayName: "Dup",
        roles: ["staff"],
        initialPassword: "a-long-password-123",
      }),
      "CONFLICT",
    );
  });

  it("[ID-US-04] initial passwords are at least 12 characters", async () => {
    await expectCode(
      execute(t.kernel, meta(admin), userCreate, {
        email: "short@demoq.test",
        displayName: "Short",
        roles: ["staff"],
        initialPassword: "short",
      }),
      "VALIDATION",
    );
  });

  it("[ID-US-05] everyone sees the directory; it never includes cost rates or password data", async () => {
    const team = await makeTeam(t.db);
    const staff = await makeUser(t.db, { roles: ["staff"], teamId: team.id });
    await t.migrator.updateTable("users").set({ cost_rate_minor: 1500n }).where("id", "=", staff.id).execute();
    const dir = await execute(t.kernel, meta(staff), userDirectory, {});
    const me = dir.find((d: { id: string }) => d.id === staff.id);
    expect(me).toMatchObject({ teamId: team.id, roles: ["staff"] });
    const keys = Object.keys(me!);
    for (const k of ["cost_rate_minor", "costRateMinor", "password_hash", "totp_secret_enc"]) expect(keys).not.toContain(k);
  });
});

describe("identity/auth hardening", () => {
  it("[ID-AU-03] parallel wrong passwords still lock the account", async () => {
    const u = await makeUser(t.db, { roles: ["staff"] });
    await Promise.allSettled(
      Array.from({ length: 12 }, () => login(t.kernel, { email: u.email, password: "wrong" }, authMeta())),
    );
    const row = await t.db.selectFrom("users").select("locked_until").where("id", "=", u.id).executeTakeFirstOrThrow();
    expect(row.locked_until).not.toBeNull();
    await expectCode(login(t.kernel, { email: u.email, password: TEST_PASSWORD }, authMeta()), "INVALID_CREDENTIALS");
  });

  it("[ID-AU-11] five wrong TOTP codes lock the account and end sessions waiting for TOTP", async () => {
    const u = await makeUser(t.db, { roles: ["finance"] });
    const a = await login(t.kernel, { email: u.email, password: TEST_PASSWORD }, authMeta());
    const { secret } = await beginTotpEnrollment(t.kernel, cfg, a.session, authMeta());
    for (let i = 0; i < 5; i++) await expectCode(verifyTotp(t.kernel, cfg, a.session, "000000", authMeta()), "TOTP_INVALID");
    expect(await resolveSession(t.kernel, a.token)).toBeNull();
    // Even the right code is refused while locked.
    await expectCode(verifyTotp(t.kernel, cfg, a.session, currentTotpCode(secret, t.clock.now), authMeta()), "TOTP_INVALID");
    const denied = await t.db
      .selectFrom("audit_events")
      .select("outcome")
      .where("actor_id", "=", u.id)
      .where("action", "=", "auth.totp_verify")
      .execute();
    expect(denied.length).toBeGreaterThanOrEqual(6);
    expect(denied.every((d) => d.outcome === "denied")).toBe(true);
  });

  it("[ID-AU-11] a session that has not passed TOTP expires after 10 minutes", async () => {
    const u = await makeUser(t.db, { roles: ["director"] });
    const a = await login(t.kernel, { email: u.email, password: TEST_PASSWORD }, authMeta());
    expect((await resolveSession(t.kernel, a.token))?.totp).toBe("enroll");
    t.clock.advance(11 * 60_000);
    expect(await resolveSession(t.kernel, a.token)).toBeNull();
  });

  it("[ID-AU-11] a burst of concurrent wrong codes does not exhaust the connection pool", async () => {
    const u = await makeUser(t.db, { roles: ["ops_lead"] });
    const a = await login(t.kernel, { email: u.email, password: TEST_PASSWORD }, authMeta());
    await beginTotpEnrollment(t.kernel, cfg, a.session, authMeta());
    // The test pool has 5 connections; 12 concurrent failures used to deadlock it.
    const results = await Promise.race([
      Promise.allSettled(Array.from({ length: 12 }, () => verifyTotp(t.kernel, cfg, a.session, "000000", authMeta()))),
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 8_000)),
    ]);
    expect(results).not.toBe("hung");
    const ok = await t.db.selectFrom("users").select("id").where("id", "=", u.id).executeTakeFirst();
    expect(ok?.id).toBe(u.id);
  });
});
