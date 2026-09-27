// Sign-in, sessions and TOTP. Spec: specs/identity/auth.md
// Not a registry command: there is no actor yet. Every outcome is still audited by name.
import { hash, verify } from "@node-rs/argon2";
import { sql } from "kysely";
import { Secret, TOTP } from "otpauth";
import { TOTP_REQUIRED_ROLES, type Role } from "@demoq/shared";
import {
  DomainError,
  decryptSecret,
  encryptSecret,
  randomToken,
  setActorContext,
  sha256,
  writeAudit,
  type Kernel,
  type RequestMeta,
  type UserActor,
} from "../kernel";

export interface AuthConfig {
  totpEncKey: string; // base64, 32 bytes
  issuer?: string;
}

export const SESSION_ABSOLUTE_MS = 7 * 24 * 3600_000;
export const SESSION_IDLE_MS = 12 * 3600_000;
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60_000;
export const MAX_TOTP_FAILURES = 5;
/** A session that passed the password but not TOTP is only good for finishing TOTP, briefly (ID-AU-11). */
export const TOTP_PENDING_TTL_MS = 10 * 60_000;
const TOTP_PERIOD = 30;

// Argon2id, OWASP-recommended parameters.
const ARGON = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };
export const hashPassword = (pw: string) => hash(pw, ARGON);
// Verified against when the email is unknown, so timing does not reveal which emails exist.
let dummyHash: Promise<string> | undefined;

export type TotpState = "ok" | "verify" | "enroll";

export interface SessionInfo {
  sessionId: string;
  actor: UserActor;
  locale: "en" | "km";
  totp: TotpState;
  email: string;
  /** Last time this session proved TOTP (login or step-up), for APR-EN-12. */
  stepUpAt: Date | null;
}

export function totpRequired(roles: readonly Role[]): boolean {
  return roles.some((r) => TOTP_REQUIRED_ROLES.includes(r));
}

function totpFor(secretB32: string, email: string, issuer = "DemoQ PSA"): TOTP {
  return new TOTP({
    issuer,
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD,
    secret: Secret.fromBase32(secretB32),
  });
}

async function loadRoles(kernel: Kernel, userId: string): Promise<Role[]> {
  const rows = await kernel.db.selectFrom("user_roles").select("role").where("user_id", "=", userId).execute();
  return rows.map((r) => r.role as Role);
}

type AuthMeta = Omit<RequestMeta, "actor"> & { ip?: string | null; userAgent?: string | null };

export async function login(
  kernel: Kernel,
  input: { email: string; password: string },
  meta: AuthMeta,
): Promise<{ token: string; session: SessionInfo }> {
  const now = kernel.clock();
  const anon: RequestMeta = { ...meta, actor: { type: "anonymous", name: input.email.slice(0, 254) } };
  const user = await kernel.db.selectFrom("users").selectAll().where("email", "=", input.email).executeTakeFirst();

  const deny = async (reason: string) => {
    await writeAudit(kernel.db, anon, {
      action: "auth.login",
      input: { email: input.email, reason },
      outcome: "denied",
      errorCode: "INVALID_CREDENTIALS",
    });
    return new DomainError("INVALID_CREDENTIALS");
  };

  if (!user || !user.active) {
    dummyHash ??= hashPassword("not-a-real-password-just-timing");
    await verify(await dummyHash, input.password).catch(() => false);
    throw await deny(user ? "inactive" : "unknown_email");
  }
  // Always pay the argon2 cost first, so a locked account answers as slowly as any other (ID-AU-02).
  const ok = await verify(user.password_hash, input.password).catch(() => false);
  if (user.locked_until && user.locked_until > now) {
    // Same error as a wrong password: do not confirm the account exists or is locked.
    throw await deny("locked");
  }
  if (!ok) {
    // Atomic: parallel wrong passwords cannot overwrite each other's count (ID-AU-03).
    const r = await kernel.db
      .updateTable("users")
      .set((eb) => ({
        failed_logins: sql<number>`CASE WHEN ${eb.ref("failed_logins")} + 1 >= ${MAX_FAILED_LOGINS} THEN 0 ELSE ${eb.ref("failed_logins")} + 1 END`,
        locked_until: sql<Date>`CASE WHEN ${eb.ref("failed_logins")} + 1 >= ${MAX_FAILED_LOGINS} THEN ${new Date(now.getTime() + LOCKOUT_MS)}::timestamptz ELSE ${eb.ref("locked_until")} END`,
      }))
      .where("id", "=", user.id)
      .returning(["locked_until"])
      .executeTakeFirstOrThrow();
    throw await deny(r.locked_until && r.locked_until > now ? "bad_password_locked" : "bad_password");
  }
  if (user.failed_logins || user.locked_until) {
    await kernel.db.updateTable("users").set({ failed_logins: 0, locked_until: null }).where("id", "=", user.id).execute();
  }

  const roles = await loadRoles(kernel, user.id);
  const token = randomToken();
  const needsTotp = totpRequired(roles) || user.totp_enabled;
  const row = await kernel.db
    .insertInto("sessions")
    .values({
      token_hash: sha256(token),
      user_id: user.id,
      created_at: now,
      last_seen_at: now,
      expires_at: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
      totp_verified: !needsTotp,
      ip: meta.ip ?? null,
      user_agent: meta.userAgent?.slice(0, 400) ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  const actor: UserActor = { type: "user", id: user.id, name: user.display_name, roles, teamId: user.team_id };
  await writeAudit(
    kernel.db,
    { ...meta, actor },
    { action: "auth.login", subject: { type: "user", id: user.id }, input: { email: input.email } },
  );
  return {
    token,
    session: {
      sessionId: row.id,
      actor,
      locale: user.locale as "en" | "km",
      email: user.email,
      totp: !needsTotp ? "ok" : user.totp_enabled ? "verify" : "enroll",
      stepUpAt: null,
    },
  };
}

/** Resolve a cookie token to a session. Returns null when missing, revoked, expired or idle. */
export async function resolveSession(kernel: Kernel, token: string | undefined): Promise<SessionInfo | null> {
  if (!token) return null;
  const now = kernel.clock();
  const row = await kernel.db
    .selectFrom("sessions as s")
    .innerJoin("users as u", "u.id", "s.user_id")
    .select([
      "s.id as sessionId",
      "s.expires_at",
      "s.last_seen_at",
      "s.revoked_at",
      "s.totp_verified",
      "s.created_at",
      "s.step_up_at",
      "u.id as userId",
      "u.email",
      "u.display_name",
      "u.team_id",
      "u.locale",
      "u.active",
      "u.totp_enabled",
    ])
    .where("s.token_hash", "=", sha256(token))
    .executeTakeFirst();
  if (!row || row.revoked_at || !row.active) return null;
  if (row.expires_at <= now || now.getTime() - row.last_seen_at.getTime() > SESSION_IDLE_MS) return null;
  if (now.getTime() - row.last_seen_at.getTime() > 5 * 60_000) {
    await kernel.db.updateTable("sessions").set({ last_seen_at: now }).where("id", "=", row.sessionId).execute();
  }
  const roles = await loadRoles(kernel, row.userId);
  const needsTotp = totpRequired(roles) || row.totp_enabled;
  if (needsTotp && !row.totp_verified && now.getTime() - row.created_at.getTime() > TOTP_PENDING_TTL_MS) return null;
  return {
    sessionId: row.sessionId,
    actor: { type: "user", id: row.userId, name: row.display_name, roles, teamId: row.team_id },
    locale: row.locale as "en" | "km",
    email: row.email,
    totp: !needsTotp || row.totp_verified ? "ok" : row.totp_enabled ? "verify" : "enroll",
    stepUpAt: row.step_up_at,
  };
}

export async function logout(kernel: Kernel, session: SessionInfo, meta: Omit<RequestMeta, "actor">): Promise<void> {
  await kernel.db.updateTable("sessions").set({ revoked_at: kernel.clock() }).where("id", "=", session.sessionId).execute();
  await writeAudit(
    kernel.db,
    { ...meta, actor: session.actor },
    { action: "auth.logout", subject: { type: "user", id: session.actor.id } },
  );
}

/** Step 1 of enrolment: create (or replace an unconfirmed) secret. Returns the otpauth:// URI for the QR code. */
export async function beginTotpEnrollment(
  kernel: Kernel,
  cfg: AuthConfig,
  session: SessionInfo,
  meta: Omit<RequestMeta, "actor">,
): Promise<{ secret: string; uri: string }> {
  const fullMeta: RequestMeta = { ...meta, actor: session.actor };
  const secret = new Secret({ size: 20 }).base32;
  await kernel.db.transaction().execute(async (tx) => {
    const user = await tx
      .selectFrom("users")
      .select(["totp_enabled"])
      .where("id", "=", session.actor.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (user.totp_enabled) throw new DomainError("CONFLICT", { reason: "totp_already_enabled" });
    await setActorContext(tx, fullMeta);
    await tx
      .updateTable("users")
      .set({ totp_secret_enc: encryptSecret(secret, cfg.totpEncKey) })
      .where("id", "=", session.actor.id)
      .execute();
    await writeAudit(tx, fullMeta, { action: "auth.totp_enroll_started", subject: { type: "user", id: session.actor.id } });
  });
  return { secret, uri: totpFor(secret, session.email, cfg.issuer).toString() };
}

/**
 * Verify a code: confirms enrolment if pending, and marks this session as second-factor verified.
 * Failures are counted per user; after MAX_TOTP_FAILURES the account locks and pending sessions end (ID-AU-11).
 * All writes happen in ONE transaction on ONE connection — never reach for a second pool connection
 * while holding a row lock (that deadlocks the pool under concurrent bad codes).
 */
export async function verifyTotp(
  kernel: Kernel,
  cfg: AuthConfig,
  session: SessionInfo,
  code: string,
  meta: Omit<RequestMeta, "actor">,
): Promise<void> {
  const fullMeta: RequestMeta = { ...meta, actor: session.actor };
  const now = kernel.clock();
  const outcome = await kernel.db.transaction().execute(async (tx) => {
    const user = await tx
      .selectFrom("users")
      .select(["totp_secret_enc", "totp_enabled", "totp_last_step", "totp_failures", "locked_until", "email"])
      .where("id", "=", session.actor.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (!user.totp_secret_enc) return "not_enrolled" as const;
    await setActorContext(tx, fullMeta);
    const deny = async (reason: string) => {
      const failures = user.totp_failures + 1;
      const lock = failures >= MAX_TOTP_FAILURES;
      await tx
        .updateTable("users")
        .set({ totp_failures: lock ? 0 : failures, ...(lock && { locked_until: new Date(now.getTime() + LOCKOUT_MS) }) })
        .where("id", "=", session.actor.id)
        .execute();
      if (lock) {
        await tx
          .updateTable("sessions")
          .set({ revoked_at: now })
          .where("user_id", "=", session.actor.id)
          .where("totp_verified", "=", false)
          .where("revoked_at", "is", null)
          .execute();
      }
      await writeAudit(tx, fullMeta, {
        action: "auth.totp_verify",
        subject: { type: "user", id: session.actor.id },
        input: { reason, locked: lock },
        outcome: "denied",
        errorCode: "TOTP_INVALID",
      });
      return "invalid" as const;
    };
    if (user.locked_until && user.locked_until > now) return deny("locked");
    const totp = totpFor(decryptSecret(user.totp_secret_enc, cfg.totpEncKey), user.email, cfg.issuer);
    const delta = totp.validate({ token: code, timestamp: now.getTime(), window: 1 });
    const step = BigInt(Math.floor(now.getTime() / 1000 / TOTP_PERIOD) + (delta ?? 0));
    if (delta === null) return deny("bad_code");
    if (user.totp_last_step !== null && step <= user.totp_last_step) return deny("replay");
    await tx
      .updateTable("users")
      .set({ totp_enabled: true, totp_last_step: step, totp_failures: 0 })
      .where("id", "=", session.actor.id)
      .execute();
    await tx.updateTable("sessions").set({ totp_verified: true, step_up_at: now }).where("id", "=", session.sessionId).execute();
    await writeAudit(tx, fullMeta, {
      action: user.totp_enabled ? "auth.totp_verify" : "auth.totp_enrolled",
      subject: { type: "user", id: session.actor.id },
    });
    return "ok" as const;
  });
  // Throw only after the transaction has committed the failure count and its audit row.
  if (outcome === "not_enrolled") throw new DomainError("TOTP_REQUIRED", { reason: "not_enrolled" });
  if (outcome === "invalid") throw new DomainError("TOTP_INVALID");
}

/** Test/support helper: the code an authenticator would show now. */
export function currentTotpCode(secretB32: string, at: Date): string {
  return totpFor(secretB32, "x").generate({ timestamp: at.getTime() });
}
