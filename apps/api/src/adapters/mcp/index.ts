// MCP adapter (Claude Code / Cowork): tools generated from the core registry (exposeTo ∋ mcp).
// Stateless streamable HTTP. Credentials: OAuth access tokens for /mcp (S4) or personal access tokens (S2).
// Specs: specs/channels/mcp.md, specs/channels/mcp-oauth.md
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";
import { zodToJsonSchema } from "zod-to-json-schema";
import { DomainError, execute, mcp, profile, registry, type Kernel, type OpDef, type UserActor } from "@demoq/core";
import { errorMessage, TOTP_REQUIRED_ROLES, type ErrorCode } from "@demoq/shared";
import type { OAuthServer } from "../oauth";

export const MCP_CALLS_PER_MINUTE = 60;

/** Plan §5.6 names for the two-step approval tools (the `.claude` ask rule matches `confirm_*`). */
const TOOL_NAMES: Record<string, string> = {
  "approval.prepare_decide": "prepare_decide_approval",
  "approval.confirm_decide": "confirm_decide_approval",
};
/** Decided over MCP only through prepare → confirm (MCP-OA-14), never in one call. */
const NOT_ON_MCP = new Set(["approval.decide"]);
// Prepare needs only `read` here: it answers DECIDE_IN_APP (INV-19) to anyone, then checks approvals:decide itself.
const SCOPE_OVERRIDE: Record<string, string> = {
  "approval.prepare_decide": "read",
  "approval.confirm_decide": "approvals:decide",
};
const ELEVATED = ["write", "approvals:decide"];

export const toolName = (op: OpDef) => TOOL_NAMES[op.name] ?? op.name.replace(/\./g, "_");
/** The token scope an op needs (MCP-OA-09): queries read, commands write, approval decisions approvals:decide. */
const scopeFor = (op: OpDef) => SCOPE_OVERRIDE[op.name] ?? (op.kind === "query" ? "read" : "write");

const json = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x), 2);

interface Credential {
  actor: UserActor;
  locale: "en" | "km";
  scopes: Set<string>;
  /** Rate-limit bucket: the PAT, or the person for OAuth (more grants never buy more calls). */
  rateKey: string;
  mcpClient: string;
  mcpGrantId: string;
}

export async function registerMcpAdapter(app: FastifyInstance, kernel: Kernel, oauth?: OAuthServer) {
  const ops = registry.filter((op) => op.exposeTo.includes("mcp") && !NOT_ON_MCP.has(op.name));
  const byTool = new Map(ops.map((op) => [toolName(op), op]));
  const tools = ops.map((op) => ({
    name: toolName(op),
    description: `${op.summary}${op.kind === "command" ? ` (changes data; needs the ${scopeFor(op)} scope)` : ""}`,
    inputSchema: zodToJsonSchema(op.input, { target: "jsonSchema7", $refStrategy: "none" }) as { type: "object" },
    annotations: { readOnlyHint: op.kind === "query", destructiveHint: op.kind === "command" && op.risk === "high" },
  }));

  // MCP-07: 60 calls/minute per token / person (per-instance window; the edge limits too).
  const windows = new Map<string, { start: number; count: number }>();
  const allow = (key: string, now: number) => {
    const w = windows.get(key);
    if (!w || now - w.start >= 60_000) {
      windows.set(key, { start: now, count: 1 });
      return 0;
    }
    w.count++;
    return w.count > MCP_CALLS_PER_MINUTE ? Math.ceil((w.start + 60_000 - now) / 1000) : 0;
  };

  const resolve = async (bearer: string | undefined): Promise<Credential | null> => {
    if (!bearer) return null;
    if (bearer.startsWith(profile.PAT_PREFIX)) {
      const tok = await profile.resolvePat(kernel, bearer);
      if (!tok) return null;
      // A write PAT may also decide approvals (two steps, bound to the token); headless use only (plan §5.6).
      const scopes = new Set<string>(tok.scopes);
      if (scopes.has("write")) scopes.add("approvals:decide");
      return {
        actor: tok.actor,
        locale: tok.locale,
        scopes,
        rateKey: `pat:${tok.tokenId}`,
        mcpClient: `pat:${tok.label}`,
        mcpGrantId: `pat:${tok.tokenId}`,
      };
    }
    const at = await oauth?.verifyAccessToken(bearer);
    if (!at) return null;
    const who = await mcp.accountFor(kernel, at.accountId);
    if (!who) return null;
    return {
      actor: who.actor,
      locale: who.locale,
      scopes: new Set(at.scopes),
      rateKey: `oauth:${at.accountId}`,
      // MCP-OA-12: the trusted client identity is the OAuth client_id (CIMD URL or pre-registered id) + grant.
      mcpClient: at.clientId,
      mcpGrantId: at.grantId,
    };
  };

  app.post("/mcp", async (req, reply) => {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const cred = await resolve(bearer);
    if (!cred) {
      // MCP-02 / MCP-OA-02: point clients at the protected-resource metadata; ask for `read` only.
      const challenge = oauth
        ? `Bearer ${bearer ? 'error="invalid_token", ' : ""}resource_metadata="${oauth.resourceMetadataUrl}", scope="read"`
        : 'Bearer realm="demoq-psa", error="invalid_token"';
      return reply.code(401).header("WWW-Authenticate", challenge).send({ error: "invalid_token" });
    }
    const retryAfter = allow(cred.rateKey, kernel.clock().getTime());
    if (retryAfter) {
      return reply
        .code(429)
        .header("Retry-After", String(retryAfter))
        .send({ error: "rate_limited", message: errorMessage("RATE_LIMITED", cred.locale) });
    }

    const server = new Server({ name: "demoq-psa", version: "0.4.0" }, { capabilities: { tools: {} } });
    // MCP-04 / MCP-OA-09 at call time: effective permission = the person's permissions ∩ token scopes, and a
    // privileged role never writes or decides from chat, whatever an older token says.
    const privileged = cred.actor.roles.some((r) => TOTP_REQUIRED_ROLES.includes(r));
    const scopes = new Set([...cred.scopes].filter((x) => !(privileged && ELEVATED.includes(x))));
    // MCP-OA-13 (D-MC-3): no command runs over MCP while the mcp.writes flag is off.
    const writesOn = await mcp.writesEnabled(kernel);
    const usable = (op: OpDef) => (op.kind === "query" || writesOn) && scopes.has(scopeFor(op));
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.filter((t) => usable(byTool.get(t.name)!)),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const op = byTool.get(call.params.name);
      const fail = (code: ErrorCode, params?: Record<string, unknown>) => {
        const link = typeof params?.deepLink === "string" && oauth ? ` Open in DemoQ: ${oauth.issuer}${params.deepLink}` : "";
        return {
          isError: true,
          content: [{ type: "text" as const, text: `${code}: ${errorMessage(code, cred.locale)}${link}` }],
        };
      };
      if (!op) return fail("NOT_FOUND");
      if (op.kind === "command" && !writesOn) return fail("MCP_WRITES_DISABLED");
      if (!scopes.has(scopeFor(op))) return fail("FORBIDDEN");
      try {
        // MCP-05: the same execute() as the screens; audited by name with the client identity and grant.
        const result = await execute(
          kernel,
          {
            actor: cred.actor,
            channel: "mcp",
            requestId: req.id,
            locale: cred.locale,
            mcpClient: cred.mcpClient,
            mcpGrantId: cred.mcpGrantId,
            mcpScopes: [...scopes],
          },
          op,
          call.params.arguments ?? {},
        );
        return { content: [{ type: "text" as const, text: json(result ?? null) }] };
      } catch (err) {
        if (err instanceof DomainError) return fail(err.code, err.params); // MCP-06: stable code + localized text
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
