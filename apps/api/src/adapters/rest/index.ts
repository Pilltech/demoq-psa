// REST adapter, generated from the core registry (ops with exposeTo ∋ 'web').
//   POST /api/v1/ops/<name>   body = input JSON   → result JSON, or problem+json
//   GET  /api/v1/ops          → catalogue of ops this surface exposes
// No business logic here (boundary rule 1).
import type { FastifyInstance } from "fastify";
import { execute, getOp, registry, type Kernel } from "@demoq/core";
import { sendProblem } from "../../problem";

export async function registerRestAdapter(app: FastifyInstance, kernel: Kernel) {
  const webOps = registry.filter((op) => op.exposeTo.includes("web"));

  app.get("/api/v1/ops", async (req, reply) => {
    if (!req.session) return sendProblem(req, reply, "UNAUTHENTICATED", 401);
    return webOps.map((op) => ({ name: op.name, kind: op.kind, summary: op.summary, permission: op.permission }));
  });

  app.post<{ Params: { name: string } }>("/api/v1/ops/:name", async (req, reply) => {
    const session = req.session;
    if (!session) return sendProblem(req, reply, "UNAUTHENTICATED", 401);
    if (session.totp !== "ok") return sendProblem(req, reply, "TOTP_REQUIRED", 401, { reason: session.totp });
    const op = getOp(req.params.name);
    if (!op || !op.exposeTo.includes("web")) return sendProblem(req, reply, "NOT_FOUND", 404);
    const result = await execute(
      kernel,
      { actor: session.actor, channel: "web", requestId: req.id, locale: session.locale },
      op,
      req.body ?? {},
    );
    return reply.send(result ?? null);
  });
}
