// MCP adapter (Claude Code / Cowork): tools generated from the core registry (exposeTo ∋ mcp).
// Stateless streamable HTTP; personal access tokens in S2, OAuth in S4. Spec: specs/channels/mcp.md
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";
import { zodToJsonSchema } from "zod-to-json-schema";
import { DomainError, execute, profile, registry, type Kernel, type OpDef } from "@demoq/core";
import { errorMessage, TOTP_REQUIRED_ROLES } from "@demoq/shared";

export const MCP_CALLS_PER_MINUTE = 60;

export const toolName = (op: OpDef) => op.name.replace(/\./g, "_");

const json = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x), 2);

export async function registerMcpAdapter(app: FastifyInstance, kernel: Kernel) {
  const ops = registry.filter((op) => op.exposeTo.includes("mcp"));
  const byTool = new Map(ops.map((op) => [toolName(op), op]));
  const tools = ops.map((op) => ({
    name: toolName(op),
    description: `${op.summary}${op.kind === "command" ? " (changes data; needs a write token)" : ""}`,
    inputSchema: zodToJsonSchema(op.input, { target: "jsonSchema7", $refStrategy: "none" }) as { type: "object" },
    annotations: { readOnlyHint: op.kind === "query", destructiveHint: op.kind === "command" && op.risk === "high" },
  }));

  // MCP-07: 60 calls/minute per token (per-instance window; the edge limits too).
  const windows = new Map<string, { start: number; count: number }>();
  const allow = (tokenId: string, now: number) => {
    const w = windows.get(tokenId);
    if (!w || now - w.start >= 60_000) {
      windows.set(tokenId, { start: now, count: 1 });
      return 0;
    }
    w.count++;
    return w.count > MCP_CALLS_PER_MINUTE ? Math.ceil((w.start + 60_000 - now) / 1000) : 0;
  };

  app.post("/mcp", async (req, reply) => {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const tok = await profile.resolvePat(kernel, bearer);
    if (!tok) {
      // MCP-02
      return reply
        .code(401)
        .header("WWW-Authenticate", 'Bearer realm="demoq-psa", error="invalid_token"')
        .send({ error: "invalid_token" });
    }
    const retryAfter = allow(tok.tokenId, kernel.clock().getTime());
    if (retryAfter) {
      return reply
        .code(429)
        .header("Retry-After", String(retryAfter))
        .send({ error: "rate_limited", message: errorMessage("RATE_LIMITED", tok.locale) });
    }

    const server = new Server({ name: "demoq-psa", version: "0.2.0" }, { capabilities: { tools: {} } });
    // MCP-04 at call time: a later promotion to a privileged role turns an old write token read-only.
    const canWrite = tok.scopes.includes("write") && !tok.actor.roles.some((r) => TOTP_REQUIRED_ROLES.includes(r));
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      // A read token only lists read tools (MCP-04).
      tools: tools.filter((t) => canWrite || byTool.get(t.name)!.kind === "query"),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const op = byTool.get(call.params.name);
      const fail = (code: Parameters<typeof errorMessage>[0]) => ({
        isError: true,
        content: [{ type: "text" as const, text: `${code}: ${errorMessage(code, tok.locale)}` }],
      });
      if (!op) return fail("NOT_FOUND");
      if (op.kind === "command" && !canWrite) return fail("FORBIDDEN");
      try {
        // MCP-05: the same execute() as the screens; audited by name with the token label as client.
        const result = await execute(
          kernel,
          { actor: tok.actor, channel: "mcp", requestId: req.id, locale: tok.locale, mcpClient: `pat:${tok.label}` },
          op,
          call.params.arguments ?? {},
        );
        return { content: [{ type: "text" as const, text: json(result ?? null) }] };
      } catch (err) {
        if (err instanceof DomainError) return fail(err.code); // MCP-06: stable code + localized text, no internals
        req.log.error({ err, tool: call.params.name }, "mcp tool failed");
        return fail("INTERNAL");
      }
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // Stateless server: no SSE stream or session to resume or delete.
  app.get("/mcp", (_req, reply) => reply.code(405).header("Allow", "POST").send({ error: "method_not_allowed" }));
  app.delete("/mcp", (_req, reply) => reply.code(405).header("Allow", "POST").send({ error: "method_not_allowed" }));
}
