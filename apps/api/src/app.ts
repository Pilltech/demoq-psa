// HTTP surface. No business logic here: routes resolve the actor and call @demoq/core.
import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { identity, PERMISSIONS, scopesFor, type Kernel, type Permission } from "@demoq/core";
import { LoginInput, TotpCodeInput } from "@demoq/shared";
import type { Config } from "./config";
import { errorHandler, requestLocale, sendProblem } from "./problem";
import { registerRestAdapter } from "./adapters/rest";

export const SESSION_COOKIE = "psa_session";
/** Custom header required on every mutating request: cross-site forms cannot send it (CSRF defence). */
export const CSRF_HEADER = "x-psa-csrf";

declare module "fastify" {
  interface FastifyRequest {
    session: identity.SessionInfo | null;
  }
}

export async function buildApp(kernel: Kernel, config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.NODE_ENV === "test" ? false : { level: "info", redact: ["req.headers.cookie", "req.headers.authorization"] },
    genReqId: () => `req_${randomUUID()}`,
    trustProxy: true,
    bodyLimit: 1_048_576,
  });
  const secure = config.NODE_ENV === "production";
  const authCfg: identity.AuthConfig = { totpEncKey: config.TOTP_ENC_KEY };

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  app.setErrorHandler(errorHandler);
  // Money and ids are bigint in core; they travel as strings.
  app.setReplySerializer((payload) => JSON.stringify(payload, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
  app.setNotFoundHandler((req, reply) => sendProblem(req, reply, "NOT_FOUND", 404));

  app.decorateRequest("session", null);
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers[CSRF_HEADER] !== "1") {
      return sendProblem(req, reply, "FORBIDDEN", 403, { reason: "csrf" });
    }
    req.session = await identity.resolveSession(kernel, req.cookies[SESSION_COOKIE]);
  });

  const baseMeta = (req: { id: string; ip: string; headers: Record<string, unknown> }, locale: "en" | "km") => ({
    channel: "web" as const,
    requestId: req.id,
    locale,
    ip: req.ip,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.post(
    "/api/v1/auth/login",
    { config: { rateLimit: { max: config.LOGIN_RATE_PER_MIN, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const input = LoginInput.safeParse(req.body);
      if (!input.success) return sendProblem(req, reply, "VALIDATION", 422);
      const { token, session } = await identity.login(kernel, input.data, baseMeta(req, requestLocale(req)));
      reply.setCookie(SESSION_COOKIE, token, {
        path: "/",
        httpOnly: true,
        secure,
        sameSite: "lax",
        maxAge: identity.SESSION_ABSOLUTE_MS / 1000,
      });
      return { user: publicUser(session), totp: session.totp };
    },
  );

  app.post("/api/v1/auth/logout", async (req, reply) => {
    if (req.session) await identity.logout(kernel, req.session, baseMeta(req, req.session.locale));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/v1/auth/me", async (req, reply) => {
    if (!req.session) return sendProblem(req, reply, "UNAUTHENTICATED", 401);
    return { user: publicUser(req.session), totp: req.session.totp };
  });

  app.post(
    "/api/v1/auth/totp/enroll",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!req.session) return sendProblem(req, reply, "UNAUTHENTICATED", 401);
      return identity.beginTotpEnrollment(kernel, authCfg, req.session);
    },
  );

  app.post(
    "/api/v1/auth/totp/verify",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!req.session) return sendProblem(req, reply, "UNAUTHENTICATED", 401);
      const input = TotpCodeInput.safeParse(req.body);
      if (!input.success) return sendProblem(req, reply, "TOTP_INVALID", 401);
      await identity.verifyTotp(kernel, authCfg, req.session, input.data.code, baseMeta(req, req.session.locale));
      return { ok: true, totp: "ok" };
    },
  );

  await registerRestAdapter(app, kernel);

  if (config.WEB_DIST) {
    await app.register(fastifyStatic, { root: config.WEB_DIST, wildcard: false });
    // SPA fallback for client-side routes.
    app.get("/*", (req, reply) => {
      if (req.url.startsWith("/api/")) return sendProblem(req, reply, "NOT_FOUND", 404);
      return reply.sendFile("index.html");
    });
  }
  return app;
}

function publicUser(s: identity.SessionInfo) {
  // Scopes per permission, so the UI can hide what the server would refuse anyway.
  const permissions = Object.fromEntries(
    (Object.keys(PERMISSIONS) as Permission[])
      .map((p) => [p, [...scopesFor(s.actor, p)]] as const)
      .filter(([, scopes]) => scopes.length > 0),
  );
  return { id: s.actor.id, name: s.actor.name, email: s.email, roles: s.actor.roles, teamId: s.actor.teamId, locale: s.locale, permissions };
}
