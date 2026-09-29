// OAuth 2.1 authorization server for MCP (Claude Code via CIMD, Cowork via a pre-registered client).
// panva oidc-provider does the protocol; our tables are its storage (core/src/mcp/oauth.ts).
// Spec: specs/channels/mcp-oauth.md (MCP-OA-*); plan §5.6; decisions D-MC-1..3.
import { createHmac, generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import formbody from "@fastify/formbody";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Provider, {
  interactionPolicy,
  errors as oidcErrors,
  type Adapter,
  type AdapterPayload,
  type Configuration,
  type KoaContextWithOIDC,
} from "oidc-provider";
import { DomainError, mcp, type Kernel, type identity } from "@demoq/core";
import { errorMessage, LoginInput, TOTP_REQUIRED_ROLES, type Locale } from "@demoq/shared";
import type { Config } from "../../config";
import { CimdError, fetchCimd, isCimdClientId } from "./cimd";
import { consentPage, loginPage, messagePage, pageCsp, t } from "./pages";

export const ACCESS_TOKEN_TTL_S = 3600; // D-MC-2
export const REFRESH_TOKEN_TTL_S = 30 * 86_400; // D-MC-2
export const GRANT_TTL_S = 30 * 86_400; // D-MC-2: consent remembered per client for 30 days
const ELEVATED = new Set(["write", "approvals:decide"]);

export interface OAuthServer {
  provider: Provider;
  issuer: string;
  /** RFC 8707 resource indicator of /mcp — the only audience tokens are issued for. */
  resource: string;
  resourceMetadataUrl: string;
  /** Validate a bearer at /mcp: live, for our audience, grant still there. */
  verifyAccessToken(token: string): Promise<OAuthAccess | null>;
}

export interface OAuthAccess {
  accountId: string;
  clientId: string;
  grantId: string;
  scopes: string[];
}

export function oauthSettings(config: Config) {
  const issuer = (config.PUBLIC_BASE_URL ?? `http://localhost:${config.PORT}`).replace(/\/+$/, "");
  return {
    issuer,
    resource: `${issuer}/mcp`,
    resourceMetadataUrl: `${issuer}/.well-known/oauth-protected-resource/mcp`,
    coworkClientId: config.MCP_COWORK_CLIENT_ID ?? "demoq-cowork",
    coworkRedirectUri: config.MCP_COWORK_REDIRECT_URI ?? "https://claude.ai/api/mcp/auth_callback",
    allowHttpCimd: config.OAUTH_DEV_ALLOW_HTTP_CIMD === "true" && config.NODE_ENV !== "production",
    ratePerMin: config.OAUTH_RATE_PER_MIN ?? 120,
  };
}

// Dev/test only (production requires both in config): one key set per process.
let devJwks: { keys: Record<string, unknown>[] } | undefined;
const devCookieKey = randomBytes(32).toString("base64url");
function jwksFor(config: Config) {
  if (config.OAUTH_JWKS) return JSON.parse(config.OAUTH_JWKS) as { keys: Record<string, unknown>[] };
  if (!devJwks) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    devJwks = { keys: [{ ...privateKey.export({ format: "jwk" }), kid: "dev-rs256", use: "sig", alg: "RS256" }] };
  }
  return devJwks;
}

/** Pick EN/KM: ?lang= wins, then ui_locales, then the person's own locale, then Accept-Language. */
function pickLocale(req: FastifyRequest, uiLocales?: unknown, userLocale?: Locale): Locale {
  const q = (req.query as { lang?: string } | undefined)?.lang;
  if (q === "km" || q === "en") return q;
  if (typeof uiLocales === "string" && /^km\b/.test(uiLocales)) return "km";
  if (userLocale) return userLocale;
  return /\bkm\b/i.test(String(req.headers["accept-language"] ?? "")) ? "km" : "en";
}

export async function registerOAuth(
  app: FastifyInstance,
  kernel: Kernel,
  config: Config,
  authCfg: identity.AuthConfig,
): Promise<OAuthServer> {
  const s = oauthSettings(config);
  const cookieKeys = (config.OAUTH_COOKIE_KEYS ?? devCookieKey).split(",").filter(Boolean);
  const cimdOpts = { allowHttpLoopback: s.allowHttpCimd };

  // D-MC-1: the Cowork client is configuration, mirrored into oauth_clients at start-up.
  await mcp.upsertPreregisteredClient(kernel, {
    client_id: s.coworkClientId,
    client_name: "Claude (Cowork / claude.ai)",
    redirect_uris: [s.coworkRedirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    application_type: "web",
  });

  // Storage adapter: oidc_payloads for protocol state, oauth_clients (+ CIMD fetch) for clients.
  const adapter = (model: string): Adapter => {
    if (model === "Client") {
      return {
        async find(id: string) {
          const known = await mcp.findClient(kernel, id);
          if (known?.fresh) return known.metadata as AdapterPayload;
          if (known?.kind === "preregistered" || !isCimdClientId(id, cimdOpts)) return undefined;
          try {
            const metadata = await fetchCimd(id, cimdOpts);
            await mcp.cacheCimdClient(kernel, metadata);
            return metadata as AdapterPayload;
          } catch (err) {
            app.log.warn({ clientId: id, reason: err instanceof CimdError ? err.message : String(err) }, "cimd refused");
            return undefined;
          }
        },
        // Dynamic registration is off: nothing ever writes clients through the provider.
        async upsert() {},
        async findByUid() {},
        async findByUserCode() {},
        async consume() {},
        async destroy() {},
        async revokeByGrantId() {},
      };
    }
    const store = mcp.oidcStore(kernel, model);
    return {
      upsert: (id, payload, expiresIn) => store.upsert(id, payload as Record<string, unknown>, expiresIn),
      find: async (id) => (await store.find(id)) as AdapterPayload | undefined,
      findByUid: async (uid) => (await store.findByUid(uid)) as AdapterPayload | undefined,
      findByUserCode: async () => undefined,
      consume: (id) => store.consume(id),
      destroy: (id) => store.destroy(id),
      revokeByGrantId: (grantId) => store.revokeByGrantId(grantId),
    };
  };

  // Every authorization signs in again (so a loopback client can never get a code without the person),
  // while consent is remembered per client for 30 days (D-MC-2) — hence no native-client consent re-prompt.
  const policy = interactionPolicy.base();
  policy
    .get("login")!
    .checks.add(
      new interactionPolicy.Check("sign_in_each_authorization", "every authorization signs in again", (ctx) =>
        ctx.oidc.result?.login ? interactionPolicy.Check.NO_NEED_TO_PROMPT : interactionPolicy.Check.REQUEST_PROMPT,
      ),
    );
  policy.get("consent")!.checks.remove("native_client_prompt");

  const configuration: Configuration = {
    adapter,
    clients: [],
    clientDefaults: {
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    clientAuthMethods: ["none"],
    responseTypes: ["code"],
    pkce: { required: () => true }, // S256 only (the provider supports no other method)
    cookies: { keys: cookieKeys },
    jwks: jwksFor(config) as Configuration["jwks"],
    routes: {
      authorization: "/oauth/auth",
      token: "/oauth/token",
      jwks: "/oauth/jwks",
      revocation: "/oauth/token/revocation",
      end_session: "/oauth/session/end",
      userinfo: "/oauth/me",
      introspection: "/oauth/token/introspection",
      registration: "/oauth/reg",
      pushed_authorization_request: "/oauth/request",
      code_verification: "/oauth/device",
      device_authorization: "/oauth/device/auth",
      backchannel_authentication: "/oauth/backchannel",
      challenge: "/oauth/challenge",
    },
    interactions: { url: (_ctx, interaction) => `/oauth/interaction/${interaction.uid}`, policy },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: false }, // MCP-OA-03: no dynamic client registration
      revocation: { enabled: true },
      userinfo: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      pushedAuthorizationRequests: { enabled: false },
      dPoP: { enabled: false },
      introspection: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: async () => s.resource,
        useGrantedResource: async () => true,
        // MCP-OA-07: the only resource is /mcp; any other indicator is invalid_target.
        getResourceServerInfo: async (_ctx, indicator) => {
          if (indicator !== s.resource) throw new oidcErrors.InvalidTarget();
          return {
            scope: mcp.OAUTH_SCOPES.join(" "),
            audience: s.resource,
            accessTokenTTL: ACCESS_TOKEN_TTL_S,
            accessTokenFormat: "opaque",
          };
        },
      },
    },
    discovery: { client_id_metadata_document_supported: true, service_documentation: `${s.issuer}/` },
    ttl: {
      AccessToken: ACCESS_TOKEN_TTL_S,
      AuthorizationCode: 60,
      RefreshToken: REFRESH_TOKEN_TTL_S,
      Grant: GRANT_TTL_S,
      Interaction: 600,
      Session: 600,
      IdToken: 3600,
    },
    // MCP-OA-08: refresh tokens for every grant, rotated on every use; not tied to the short sign-in session.
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    rotateRefreshToken: () => true,
    expiresWithSession: async () => false,
    loadExistingGrant: async (ctx) => {
      const grantId =
        ctx.oidc.result?.consent?.grantId ??
        (ctx.oidc.session?.accountId && ctx.oidc.client
          ? await mcp.rememberedGrantId(kernel, ctx.oidc.session.accountId, ctx.oidc.client.clientId)
          : undefined);
      return grantId ? ctx.oidc.provider.Grant.find(grantId) : undefined;
    },
    // Protocol errors that cannot go back to the client (unknown client, bad redirect_uri): a plain page.
    renderError: async (ctx, out) => {
      ctx.type = "html";
      ctx.set("content-security-policy", pageCsp([]));
      ctx.body = messagePage("en", `${out.error}: ${out.error_description ?? ""}`);
    },
    findAccount: async (_ctx, sub) => {
      const who = await mcp.accountFor(kernel, sub);
      return who ? { accountId: sub, claims: async () => ({ sub }) } : undefined;
    },
  };

  const provider = new Provider(s.issuer, configuration);
  // URLs the provider builds (discovery, redirects) and cookie security come from the issuer, never from
  // client-supplied Host / X-Forwarded-* headers: toProvider() pins them before every request.
  provider.proxy = true;
  const issuerUrl = new URL(s.issuer);
  provider.on("server_error", (_ctx: unknown, err: Error) => app.log.error({ err }, "oauth server_error"));

  provider.use(async (ctx, next) => {
    // "read" is the default scope and always part of a request (plan §5.6).
    if (ctx.method === "GET" && ctx.path === "/oauth/auth") {
      const q = { ...ctx.query };
      const scopes = new Set([
        "read",
        ...String(q.scope ?? "")
          .split(" ")
          .filter(Boolean),
      ]);
      q.scope = [...scopes].join(" ");
      ctx.query = q;
    }
    await next();
    const c = ctx as KoaContextWithOIDC;
    if (c.oidc?.route === "discovery" && ctx.body && typeof ctx.body === "object") {
      (ctx.body as Record<string, unknown>).scopes_supported = [...mcp.OAUTH_SCOPES];
    }
  });

  const callback = provider.callback();
  const toProvider = (rewrite?: string) => (req: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();
    if (rewrite) req.raw.url = rewrite;
    req.raw.headers.host = issuerUrl.host;
    req.raw.headers["x-forwarded-host"] = issuerUrl.host;
    req.raw.headers["x-forwarded-proto"] = issuerUrl.protocol.slice(0, -1);
    req.raw.headers["x-forwarded-for"] = req.ip;
    return callback(req.raw as IncomingMessage, reply.raw as ServerResponse);
  };

  // Protocol endpoints: the provider reads its own bodies (form-encoded token requests), so this scope
  // registers a pass-through parser and Fastify never consumes the stream.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, _payload, done) => done(null, undefined));
    const rateLimit = { max: s.ratePerMin, timeWindow: "1 minute" };
    scope.all("/oauth/*", { config: { rateLimit } }, toProvider());
    scope.get("/.well-known/openid-configuration", { config: { rateLimit } }, toProvider());
    // RFC 8414 location for an issuer without a path.
    scope.get(
      "/.well-known/oauth-authorization-server",
      { config: { rateLimit } },
      toProvider("/.well-known/openid-configuration"),
    );
  });

  // RFC 9728 protected-resource metadata (MCP-OA-01).
  const prm = {
    resource: s.resource,
    authorization_servers: [s.issuer],
    scopes_supported: [...mcp.OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "DemoQ PSA",
    resource_documentation: `${s.issuer}/`,
  };
  app.get("/.well-known/oauth-protected-resource", async () => prm);
  app.get("/.well-known/oauth-protected-resource/mcp", async () => prm);

  registerInteractions(app, kernel, provider, s, cookieKeys[0]!, authCfg, config);

  return {
    provider,
    issuer: s.issuer,
    resource: s.resource,
    resourceMetadataUrl: s.resourceMetadataUrl,
    async verifyAccessToken(token) {
      const at = await provider.AccessToken.find(token).catch(() => undefined);
      if (!at || at.isExpired || !at.accountId || !at.grantId || !at.clientId) return null;
      // MCP-OA-07: RFC 8707 audience — exactly our /mcp resource.
      const aud = Array.isArray(at.aud) ? (at.aud.length === 1 ? at.aud[0] : undefined) : at.aud;
      if (aud !== s.resource) return null;
      const grant = await provider.Grant.find(at.grantId).catch(() => undefined);
      if (!grant || grant.accountId !== at.accountId || grant.clientId !== at.clientId) return null;
      return {
        accountId: at.accountId,
        clientId: at.clientId,
        grantId: at.grantId,
        scopes: (at.scope ?? "").split(" ").filter(Boolean),
      };
    },
  };
}

function registerInteractions(
  app: FastifyInstance,
  kernel: Kernel,
  provider: Provider,
  s: ReturnType<typeof oauthSettings>,
  csrfKey: string,
  authCfg: identity.AuthConfig,
  config: Config,
) {
  const csrfFor = (uid: string) => createHmac("sha256", csrfKey).update(`oauth-csrf:${uid}`).digest("base64url");
  const csrfOk = (req: FastifyRequest, uid: string) => {
    const origin = req.headers.origin;
    if (origin && origin !== new URL(s.issuer).origin) return false;
    const got = Buffer.from(String((req.body as { csrf?: unknown } | undefined)?.csrf ?? ""));
    const want = Buffer.from(csrfFor(uid));
    return got.length === want.length && timingSafeEqual(got, want);
  };

  const load = async (req: FastifyRequest<{ Params: { uid: string } }>, reply: FastifyReply) => {
    const details = await provider.interactionDetails(req.raw, reply.raw).catch(() => undefined);
    if (!details || details.uid !== req.params.uid) return undefined;
    const clientId = String(details.params.client_id ?? "");
    const client = await provider.Client.find(clientId).catch(() => undefined);
    if (!client) return undefined;
    const redirectUri = String(details.params.redirect_uri ?? client.redirectUris?.[0] ?? "");
    let redirect: URL | undefined;
    try {
      redirect = new URL(redirectUri);
    } catch {
      return undefined;
    }
    return { details, client, clientId, clientName: client.clientName ?? clientId, redirect };
  };

  const html = (reply: FastifyReply, status: number, body: string, redirect?: URL) =>
    reply
      .code(status)
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header("content-security-policy", pageCsp(redirect ? [redirect.origin] : []))
      .send(body);

  const langHref = (req: FastifyRequest, locale: Locale) => `${req.url.split("?")[0]}?lang=${locale === "km" ? "en" : "km"}`;

  const meta = (req: FastifyRequest, locale: Locale, clientId: string) => ({
    channel: "mcp" as const,
    requestId: req.id,
    locale,
    mcpClient: clientId,
    ip: req.ip,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
  });

  /** Scopes this person may be granted: `read` always; elevated ones never for privileged roles (MCP-OA-09). */
  const splitScopes = (requested: string, roles: readonly string[]) => {
    const wanted = new Set(requested.split(" ").filter((x) => (mcp.OAUTH_SCOPES as readonly string[]).includes(x)));
    wanted.add("read");
    const privileged = roles.some((r) => (TOTP_REQUIRED_ROLES as readonly string[]).includes(r));
    const granted = [...wanted].filter((x) => !(privileged && ELEVATED.has(x)));
    const refused = [...wanted].filter((x) => privileged && ELEVATED.has(x));
    return { granted, refused };
  };

  app.register(async (ui) => {
    await ui.register(formbody, { bodyLimit: 4096 });

    ui.get<{ Params: { uid: string } }>("/oauth/interaction/:uid", async (req, reply) => {
      const it = await load(req, reply);
      if (!it) return html(reply, 400, messagePage(pickLocale(req), t(pickLocale(req), "expired")));
      const { details } = it;
      if (details.prompt.name === "login") {
        const locale = pickLocale(req, details.params.ui_locales);
        return html(
          reply,
          200,
          loginPage({
            locale,
            uid: details.uid,
            csrf: csrfFor(details.uid),
            clientName: it.clientName,
            langHref: langHref(req, locale),
          }),
          it.redirect,
        );
      }
      const who = details.session?.accountId ? await mcp.accountFor(kernel, details.session.accountId) : null;
      if (!who) return html(reply, 400, messagePage(pickLocale(req), t(pickLocale(req), "expired")));
      const locale = pickLocale(req, details.params.ui_locales, who.locale);
      const { granted, refused } = splitScopes(String(details.params.scope ?? ""), who.actor.roles);
      return html(
        reply,
        200,
        consentPage({
          locale,
          uid: details.uid,
          csrf: csrfFor(details.uid),
          clientName: it.clientName,
          clientId: it.clientId,
          userName: who.actor.name,
          redirectHost: it.redirect.host,
          granted,
          refused,
          langHref: langHref(req, locale),
        }),
        it.redirect,
      );
    });

    ui.post<{ Params: { uid: string }; Body: Record<string, string> }>(
      "/oauth/interaction/:uid/login",
      { config: { rateLimit: { max: config.LOGIN_RATE_PER_MIN, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const it = await load(req, reply);
        if (!it || it.details.prompt.name !== "login" || !csrfOk(req, it.details.uid)) {
          return html(reply, 403, messagePage(pickLocale(req), t(pickLocale(req), "expired")));
        }
        const locale = pickLocale(req, it.details.params.ui_locales);
        const body = req.body ?? {};
        const again = (status: number, error: string) =>
          html(
            reply,
            status,
            loginPage({
              locale,
              uid: it.details.uid,
              csrf: csrfFor(it.details.uid),
              clientName: it.clientName,
              email: typeof body.email === "string" ? body.email.slice(0, 254) : "",
              error,
              langHref: langHref(req, locale),
            }),
            it.redirect,
          );
        const input = LoginInput.safeParse({ email: body.email, password: body.password });
        if (!input.success) return again(422, errorMessage("INVALID_CREDENTIALS", locale));
        const code = typeof body.code === "string" && body.code.trim() ? body.code.trim() : undefined;
        try {
          const who = await mcp.oauthSignIn(kernel, authCfg, { ...input.data, code }, meta(req, locale, it.clientId));
          reply.hijack();
          await provider.interactionFinished(
            req.raw,
            reply.raw,
            { login: { accountId: who.actor.id } },
            { mergeWithLastSubmission: false },
          );
        } catch (err) {
          if (!(err instanceof DomainError)) throw err;
          if (err.code === "TOTP_REQUIRED" && err.params?.reason === "not_enrolled") return again(401, t(locale, "notEnrolled"));
          return again(401, errorMessage(err.code, locale));
        }
      },
    );

    ui.post<{ Params: { uid: string } }>("/oauth/interaction/:uid/consent", async (req, reply) => {
      const it = await load(req, reply);
      if (!it || it.details.prompt.name !== "consent" || !csrfOk(req, it.details.uid)) {
        return html(reply, 403, messagePage(pickLocale(req), t(pickLocale(req), "expired")));
      }
      const { details } = it;
      const accountId = details.session?.accountId;
      const who = accountId ? await mcp.accountFor(kernel, accountId) : null;
      if (!who || !accountId) return html(reply, 403, messagePage(pickLocale(req), t(pickLocale(req), "expired")));
      const { granted, refused } = splitScopes(String(details.params.scope ?? ""), who.actor.roles);
      // Extend the remembered grant only if it is this person's grant for this client.
      const existing = details.grantId ? await provider.Grant.find(details.grantId) : undefined;
      const grant =
        existing && existing.accountId === accountId && existing.clientId === it.clientId
          ? existing
          : new provider.Grant({ accountId, clientId: it.clientId });
      grant.addResourceScope(s.resource, granted.join(" "));
      if (refused.length) grant.rejectResourceScope(s.resource, refused.join(" "));
      const promptDetails = details.prompt.details as { missingOIDCScope?: string[]; missingOIDCClaims?: string[] };
      if (promptDetails.missingOIDCScope?.length) grant.addOIDCScope(promptDetails.missingOIDCScope.join(" "));
      if (promptDetails.missingOIDCClaims?.length) grant.addOIDCClaims(promptDetails.missingOIDCClaims);
      const grantId = await grant.save();
      await mcp.auditGrant(
        kernel,
        { actor: who.actor, channel: "mcp", requestId: req.id, locale: who.locale, mcpClient: it.clientId, mcpGrantId: grantId },
        { granted, refused, redirectHost: it.redirect.host, outcome: "ok" },
      );
      reply.hijack();
      await provider.interactionFinished(req.raw, reply.raw, { consent: { grantId } }, { mergeWithLastSubmission: true });
    });

    ui.post<{ Params: { uid: string } }>("/oauth/interaction/:uid/abort", async (req, reply) => {
      const it = await load(req, reply);
      if (!it || !csrfOk(req, it.details.uid)) {
        return html(reply, 403, messagePage(pickLocale(req), t(pickLocale(req), "expired")));
      }
      const accountId = it.details.session?.accountId;
      const who = accountId ? await mcp.accountFor(kernel, accountId) : null;
      if (who) {
        await mcp.auditGrant(
          kernel,
          { actor: who.actor, channel: "mcp", requestId: req.id, locale: who.locale, mcpClient: it.clientId },
          { granted: [], refused: [], redirectHost: it.redirect.host, outcome: "denied" },
        );
      }
      reply.hijack();
      await provider.interactionFinished(
        req.raw,
        reply.raw,
        { error: "access_denied", error_description: "The person declined." },
        { mergeWithLastSubmission: false },
      );
    });
  });
}
