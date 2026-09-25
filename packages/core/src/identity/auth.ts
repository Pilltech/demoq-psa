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
  if (user.locked_until && user.locked_until > now) {
    // Same error as a wrong password: do not confirm the account exists or is locked.
    throw await deny("locked");
  }
  const ok = await verify(user.password_hash, input.password).catch(() => false);
  if (!ok) {
    const failed = user.failed_logins + 1;
    await kernel.db
      .updateTable("users")
      .set({
        failed_logins: failed >= MAX_FAILED_LOGINS ? 0 : failed,
        locked_until: failed >= MAX_FAILED_LOGINS ? new Date(now.getTime() + LOCKOUT_MS) : user.locked_until,
      })
      .where("id", "=", user.id)
      .execute();
    throw await deny(failed >= MAX_FAILED_LOGINS ? "bad_password_locked" : "bad_password");
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
  return {
    sessionId: row.sessionId,
    actor: { type: "user", id: row.userId, name: row.display_name, roles, teamId: row.team_id },
    locale: row.locale as "en" | "km",
    email: row.email,
    totp: !needsTotp || row.totp_verified ? "ok" : row.totp_enabled ? "verify" : "enroll",
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
): Promise<{ secret: string; uri: string }> {
  const user = await kernel.db
    .selectFrom("users")
    .select(["totp_enabled"])
    .where("id", "=", session.actor.id)
    .executeTakeFirstOrThrow();
  if (user.totp_enabled) throw new DomainError("CONFLICT", { reason: "totp_already_enabled" });
  const secret = new Secret({ size: 20 }).base32;
  await kernel.db
    .updateTable("users")
    .set({ totp_secret_enc: encryptSecret(secret, cfg.totpEncKey) })
    .where("id", "=", session.actor.id)
    .execute();
  return { secret, uri: totpFor(secret, session.email, cfg.issuer).toString() };
}

/** Verify a code: confirms enrolment if pending, and marks this session as second-factor verified. */
export async function verifyTotp(
  kernel: Kernel,
  cfg: AuthConfig,
  session: SessionInfo,
  code: string,
  meta: Omit<RequestMeta, "actor">,
): Promise<void> {
  const fullMeta: RequestMeta = { ...meta, actor: session.actor };
  await kernel.db.transaction().execute(async (tx) => {
    const user = await tx
      .selectFrom("users")
      .select(["totp_secret_enc", "totp_enabled", "totp_last_step", "email"])
      .where("id", "=", session.actor.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (!user.totp_secret_enc) throw new DomainError("TOTP_REQUIRED", { reason: "not_enrolled" });
    const totp = totpFor(decryptSecret(user.totp_secret_enc, cfg.totpEncKey), user.email, cfg.issuer);
    const nowMs = kernel.clock().getTime();
    const delta = totp.validate({ token: code, timestamp: nowMs, window: 1 });
    const step = BigInt(Math.floor(nowMs / 1000 / TOTP_PERIOD) + (delta ?? 0));
    if (delta === null || (user.totp_last_step !== null && step <= user.totp_last_step)) {
      await writeAudit(kernel.db, fullMeta, { action: "auth.totp_verify", outcome: "denied", errorCode: "TOTP_INVALID" });
      throw new DomainError("TOTP_INVALID");
    }
    await sql`SELECT set_config('app.actor_id', ${session.actor.id}, true), set_config('app.actor_name', ${session.actor.name}, true), set_config('app.channel', ${meta.channel}, true), set_config('app.request_id', ${meta.requestId}, true)`.execute(
      tx,
    );
    await tx.updateTable("users").set({ totp_enabled: true, totp_last_step: step }).where("id", "=", session.actor.id).execute();
    await tx.updateTable("sessions").set({ totp_verified: true }).where("id", "=", session.sessionId).execute();
    await writeAudit(tx, fullMeta, {
      action: user.totp_enabled ? "auth.totp_verify" : "auth.totp_enrolled",
      subject: { type: "user", id: session.actor.id },
    });
  });
}

/** Test/support helper: the code an authenticator would show now. */
export function currentTotpCode(secretB32: string, at: Date): string {
  return totpFor(secretB32, "x").generate({ timestamp: at.getTime() });
}
