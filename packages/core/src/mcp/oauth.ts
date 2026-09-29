// OAuth for MCP — the database side. Spec: specs/channels/mcp-oauth.md (MCP-OA-*)
// The protocol (oidc-provider), CIMD fetching and the HTML pages live in apps/api/src/adapters/oauth.
// Like identity/auth.ts this is auth bootstrap: there is no actor yet, so these are not registry commands,
// but every sign-in and grant is still audited by name.
import { sql } from "kysely";
import type { Json } from "@demoq/db";
import { DomainError, sha256, writeAudit, type Kernel, type RequestMeta, type UserActor } from "../kernel";
import { login, loadActor, verifyTotp, type AuthConfig } from "../identity";

/** Scopes a token can carry (MCP-OA-09). `read` is always granted. */
export const OAUTH_SCOPES = ["read", "write", "approvals:decide"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/** D-MC-1: CIMD documents are cached for 24 hours. */
export const CIMD_CACHE_MS = 24 * 3600_000;

// Models whose provider id is itself a bearer secret: stored hashed, and their jti is not kept.
const SECRET_ID_MODELS = new Set(["AccessToken", "AuthorizationCode", "RefreshToken", "ClientCredentials"]);
const storedId = (model: string, id: string) => (SECRET_ID_MODELS.has(model) ? sha256(id) : sha256(`${model}:${id}`));

type Payload = Record<string, unknown>;

/** oidc-provider adapter operations over `oidc_payloads`, one model at a time. */
export function oidcStore(kernel: Kernel, model: string) {
  const live = () => sql<boolean>`(expires_at IS NULL OR expires_at > ${kernel.clock()})`;
  const hydrate = (id: string | undefined, row: { payload: unknown; consumed_at: Date | null } | undefined) => {
    if (!row) return undefined;
    const payload = { ...(row.payload as Payload) };
    if (id !== undefined && SECRET_ID_MODELS.has(model)) payload.jti = id;
    if (row.consumed_at) payload.consumed = Math.floor(row.consumed_at.getTime() / 1000);
    return payload;
  };
  return {
    async upsert(id: string, payload: Payload, expiresIn?: number): Promise<void> {
      const stored: Payload = { ...payload };
      if (SECRET_ID_MODELS.has(model)) delete stored.jti;
      const expiresAt = typeof expiresIn === "number" ? new Date(kernel.clock().getTime() + expiresIn * 1000) : null;
      const isGrant = model === "Grant";
      const values = {
        model,
        id: storedId(model, id),
        payload: JSON.stringify(stored) as unknown as Json,
        grant_id: typeof payload.grantId === "string" ? payload.grantId : null,
        uid: typeof payload.uid === "string" ? payload.uid : null,
        account_id: isGrant && typeof payload.accountId === "string" ? payload.accountId : null,
        client_id: typeof payload.clientId === "string" ? payload.clientId : null,
        expires_at: expiresAt,
        created_at: kernel.clock(),
      };
      await kernel.db
        .insertInto("oidc_payloads")
        .values(values)
        .onConflict((oc) =>
          oc.columns(["model", "id"]).doUpdateSet({
            payload: values.payload,
            grant_id: values.grant_id,
            uid: values.uid,
            account_id: values.account_id,
            client_id: values.client_id,
            expires_at: values.expires_at,
          }),
        )
        .execute();
    },
    async find(id: string): Promise<Payload | undefined> {
      const row = await kernel.db
        .selectFrom("oidc_payloads")
        .select(["payload", "consumed_at"])
        .where("model", "=", model)
        .where("id", "=", storedId(model, id))
        .where(live())
        .executeTakeFirst();
      return hydrate(id, row);
    },
    async findByUid(uid: string): Promise<Payload | undefined> {
      const row = await kernel.db
        .selectFrom("oidc_payloads")
        .select(["payload", "consumed_at"])
        .where("model", "=", model)
        .where("uid", "=", uid)
        .where(live())
        .executeTakeFirst();
      return hydrate(undefined, row);
    },
    async consume(id: string): Promise<void> {
      await kernel.db
        .updateTable("oidc_payloads")
        .set({ consumed_at: kernel.clock() })
        .where("model", "=", model)
        .where("id", "=", storedId(model, id))
        .execute();
    },
    async destroy(id: string): Promise<void> {
      await kernel.db.deleteFrom("oidc_payloads").where("model", "=", model).where("id", "=", storedId(model, id)).execute();
    },
    async revokeByGrantId(grantId: string): Promise<void> {
      await kernel.db.deleteFrom("oidc_payloads").where("grant_id", "=", grantId).execute();
    },
  };
}

/** D-MC-2: the newest live grant this person gave this client (consent remembered for 30 days). */
export async function rememberedGrantId(kernel: Kernel, accountId: string, clientId: string): Promise<string | undefined> {
  const row = await kernel.db
    .selectFrom("oidc_payloads")
    .select("payload")
    .where("model", "=", "Grant")
    .where("account_id", "=", accountId)
    .where("client_id", "=", clientId)
    .where("expires_at", ">", kernel.clock())
    .orderBy("expires_at", "desc")
    .limit(1)
    .executeTakeFirst();
  const jti = (row?.payload as Payload | undefined)?.jti;
  return typeof jti === "string" ? jti : undefined;
}

// --- Clients ---------------------------------------------------------------------------------------

export type ClientMetadata = Record<string, unknown> & { client_id: string };

/** A usable client: pre-registered, or a CIMD document still inside its 24 h cache. */
export async function findClient(
  kernel: Kernel,
  clientId: string,
): Promise<{ kind: "preregistered" | "cimd"; metadata: ClientMetadata; fresh: boolean } | undefined> {
  const row = await kernel.db
    .selectFrom("oauth_clients")
    .select(["kind", "metadata", "expires_at", "disabled_at"])
    .where("client_id", "=", clientId)
    .executeTakeFirst();
  if (!row || row.disabled_at) return undefined;
  const fresh = row.kind === "preregistered" || (!!row.expires_at && row.expires_at > kernel.clock());
  return { kind: row.kind as "preregistered" | "cimd", metadata: row.metadata as ClientMetadata, fresh };
}

const SYSTEM: RequestMeta = {
  actor: { type: "job", name: "system:oauth", grants: [] },
  channel: "mcp",
  requestId: "oauth_bootstrap",
  locale: "en",
};

/** D-MC-1: the Cowork client comes from configuration; keep its row in step at start-up. */
export async function upsertPreregisteredClient(kernel: Kernel, metadata: ClientMetadata): Promise<void> {
  await kernel.db.transaction().execute(async (tx) => {
    await sql`SELECT set_config('app.actor_name', ${SYSTEM.actor.name}, true), set_config('app.channel', 'mcp', true)`.execute(
      tx,
    );
    await tx
      .insertInto("oauth_clients")
      .values({ client_id: metadata.client_id, kind: "preregistered", metadata: JSON.stringify(metadata) as unknown as Json })
      .onConflict((oc) =>
        oc.column("client_id").doUpdateSet({
          kind: "preregistered",
          metadata: JSON.stringify(metadata) as unknown as Json,
          fetched_at: null,
          expires_at: null,
        }),
      )
      .execute();
  });
}

/** Cache a validated Client ID Metadata Document for 24 h (MCP-OA-04). Never overwrites a pre-registered client. */
export async function cacheCimdClient(kernel: Kernel, metadata: ClientMetadata): Promise<void> {
  const now = kernel.clock();
  const expires = new Date(now.getTime() + CIMD_CACHE_MS);
  await kernel.db.transaction().execute(async (tx) => {
    await sql`SELECT set_config('app.actor_name', ${SYSTEM.actor.name}, true), set_config('app.channel', 'mcp', true)`.execute(
      tx,
    );
    await tx
      .insertInto("oauth_clients")
      .values({
        client_id: metadata.client_id,
        kind: "cimd",
        metadata: JSON.stringify(metadata) as unknown as Json,
        fetched_at: now,
        expires_at: expires,
      })
      .onConflict((oc) =>
        oc
          .column("client_id")
          .doUpdateSet({ metadata: JSON.stringify(metadata) as unknown as Json, fetched_at: now, expires_at: expires })
          .where("oauth_clients.kind", "=", "cimd"),
      )
      .execute();
  });
}

// --- Sign-in and consent ----------------------------------------------------------------------------

export interface OAuthSignIn {
  actor: UserActor;
  locale: "en" | "km";
  email: string;
}

type AuthMeta = Omit<RequestMeta, "actor"> & { ip?: string | null; userAgent?: string | null };

/**
 * MCP-OA-10: sign in for an OAuth authorization with the same rules as the web — argon2, lockout, audit —
 * and TOTP for privileged roles (and anyone who enabled it). A privileged user who has not enrolled TOTP
 * must enrol in the app first. The web session the check needs is revoked straight away: OAuth issues
 * its own tokens.
 */
export async function oauthSignIn(
  kernel: Kernel,
  cfg: AuthConfig,
  input: { email: string; password: string; code?: string },
  meta: AuthMeta,
): Promise<OAuthSignIn> {
  const { session } = await login(kernel, { email: input.email, password: input.password }, meta);
  try {
    if (session.totp === "enroll") throw new DomainError("TOTP_REQUIRED", { reason: "not_enrolled" });
    if (session.totp === "verify") {
      if (!input.code) throw new DomainError("TOTP_REQUIRED", { reason: "code_missing" });
      await verifyTotp(kernel, cfg, session, input.code, meta);
    }
  } finally {
    await kernel.db.updateTable("sessions").set({ revoked_at: kernel.clock() }).where("id", "=", session.sessionId).execute();
  }
  return { actor: session.actor, locale: session.locale, email: session.email };
}

/** The account behind a grant or token, if still active. */
export async function accountFor(kernel: Kernel, accountId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) return null;
  return loadActor(kernel, accountId);
}

/** Audit a consent decision (MCP-OA-11): who, which client, which scopes were granted and refused. */
export async function auditGrant(
  kernel: Kernel,
  meta: RequestMeta,
  row: { granted: string[]; refused: string[]; redirectHost: string; outcome: "ok" | "denied" },
): Promise<void> {
  await writeAudit(kernel.db, meta, {
    action: "oauth.grant",
    subject: meta.actor.type === "user" ? { type: "user", id: meta.actor.id } : undefined,
    input: { granted: row.granted, refused: row.refused, redirectHost: row.redirectHost },
    outcome: row.outcome,
    errorCode: row.outcome === "denied" ? "FORBIDDEN" : undefined,
  });
}
