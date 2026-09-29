// Public influencer work-log link (no account, channel `link`). Spec: specs/influencers/links.md (INF-LK-06…09)
//   GET  /api/v1/link/:token               → link.view   (what to submit, submissions left, EN/KM texts)
//   POST /api/v1/link/:token/submissions   → link.submit (201; waits for DemoQ's approval)
// The token is the only authority: no cookie, no session and no CSRF header are read on these routes (app.ts skips
// them). Unknown tokens answer 404 without detail; dead links 410 LINK_EXPIRED. 20 requests/minute per IP and per
// token (§9.1); small bodies only. No business logic here (boundary rule 1).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { execute, influencers, sha256, type Kernel } from "@demoq/core";
import { PUBLIC_LINK_PREFIX, requestLocale, sendProblem } from "../../problem";

export const LINK_PREFIX = PUBLIC_LINK_PREFIX;
export const LINK_RATE_PER_MIN = 20;
export const LINK_BODY_LIMIT = 16 * 1024;

type TokenRequest = FastifyRequest<{ Params: { token: string } }>;

export async function registerLinkAdapter(app: FastifyInstance, kernel: Kernel) {
  const window = { max: LINK_RATE_PER_MIN, timeWindow: 60_000 };
  const byIp = app.createRateLimit(window);
  const byToken = app.createRateLimit({
    ...window,
    keyGenerator: (req) => `link:${sha256(String((req.params as { token?: string }).token ?? ""))}`,
  });

  /** Headers for every link response; then both rate limits (either one refuses with 429 + Retry-After). */
  async function guard(req: FastifyRequest, reply: FastifyReply) {
    reply
      .header("cache-control", "no-store")
      .header("x-robots-tag", "noindex, nofollow")
      .header("referrer-policy", "no-referrer");
    for (const limit of [byIp, byToken]) {
      const r = await limit(req);
      if (!r.isAllowed && r.isExceeded) {
        reply.header("retry-after", String(r.ttlInSeconds));
        return sendProblem(req, reply, "RATE_LIMITED", 429);
      }
    }
  }

  const meta = async (req: TokenRequest) => {
    const actor = await influencers.resolveLinkActor(kernel, req.params.token);
    if (!actor) return null;
    return {
      actor,
      channel: "link" as const,
      requestId: req.id,
      locale: requestLocale(req),
      ip: req.ip,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    };
  };

  app.get<{ Params: { token: string } }>(`${LINK_PREFIX}:token`, { onRequest: guard }, async (req, reply) => {
    const m = await meta(req);
    if (!m) return sendProblem(req, reply, "NOT_FOUND", 404);
    return execute(kernel, m, influencers.linkView, { token: req.params.token });
  });

  app.post<{ Params: { token: string } }>(
    `${LINK_PREFIX}:token/submissions`,
    { onRequest: guard, bodyLimit: LINK_BODY_LIMIT },
    async (req, reply) => {
      const m = await meta(req);
      if (!m) return sendProblem(req, reply, "NOT_FOUND", 404);
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const result = await execute(kernel, m, influencers.linkSubmit, { ...body, token: req.params.token });
      return reply.code(201).send(result);
    },
  );
}
