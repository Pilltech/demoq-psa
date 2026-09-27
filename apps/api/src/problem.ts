import type { FastifyReply, FastifyRequest } from "fastify";
import { errorMessage, type ErrorCode, type Locale, type Problem } from "@demoq/shared";
import { DomainError } from "@demoq/core";

export function requestLocale(req: FastifyRequest): Locale {
  const fromSession = req.session?.locale;
  if (fromSession) return fromSession;
  return /^km\b/i.test(req.headers["accept-language"] ?? "") ? "km" : "en";
}

export function sendProblem(
  req: FastifyRequest,
  reply: FastifyReply,
  code: ErrorCode,
  status: number,
  params?: Record<string, unknown>,
) {
  const locale = requestLocale(req);
  const body: Problem = {
    type: `https://psa.demoq.com/errors/${code.toLowerCase()}`,
    title: errorMessage(code, locale),
    status,
    code,
    requestId: req.id,
    ...(params && Object.keys(params).length ? { params } : {}),
  };
  return reply.code(status).type("application/problem+json").send(body);
}

export function errorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof DomainError) {
    // Never echo internals: only whitelisted params reach the client.
    const { issues, min, stage, kind, reason, missing, openDependencies, oosStatus } = err.params as Record<string, unknown>;
    const safe = Object.fromEntries(
      Object.entries({ issues, min, stage, kind, reason, missing, openDependencies, oosStatus }).filter(
        ([, v]) => v !== undefined,
      ),
    );
    return sendProblem(req, reply, err.code, err.status, safe);
  }
  const e = err as { statusCode?: number; code?: string };
  if (e.statusCode === 429) return sendProblem(req, reply, "RATE_LIMITED", 429);
  if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return sendProblem(req, reply, "VALIDATION", e.statusCode);
  req.log.error({ err }, "unhandled error");
  return sendProblem(req, reply, "INTERNAL", 500);
}
