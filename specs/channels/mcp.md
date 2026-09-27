# channels/mcp — Claude Code and Cowork access (S2 shell: personal access tokens)

**Status:** signed with defaults · **Sprint:** S2 (OAuth in S4) · **Quotation refs:** Q-27, Q-28, Q-29 · **Invariants:** INV-19

## Rules

| ID     | Rule                                                                                                                                                                                                      | Error code     |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| MCP-01 | `/mcp` speaks MCP over streamable HTTP, stateless per request. Tools are generated from the registry: every op with `exposeTo ∋ mcp`, named `<resource>_<action>`, with a JSON schema from its zod input. | —              |
| MCP-02 | Requests authenticate with a personal access token (`Authorization: Bearer dq_pat_…`). Missing/invalid/expired/revoked → HTTP 401 with `WWW-Authenticate: Bearer`.                                        | —              |
| MCP-03 | Tokens are shown once, stored as SHA-256, expire in ≤ 30 days, can be revoked, and record last use. Issuing one needs a TOTP-verified web session.                                                        | `VALIDATION`   |
| MCP-04 | Token scopes: `read` (queries) and `write` (commands). Privileged roles (ceo, director, ops_lead, finance, admin) can only get `read` tokens. A write tool with a read token is refused.                  | `FORBIDDEN`    |
| MCP-05 | Every tool call runs through `execute()` with channel `mcp` — the same permissions, gates and audit as the screens — and is audited by the user's name with the token's client label.                     | —              |
| MCP-06 | Domain errors come back as tool errors (`isError: true`) with the stable code and the message in the user's language — never a stack trace.                                                               | —              |
| MCP-07 | 60 calls per minute per token; over that → HTTP 429 with `Retry-After`.                                                                                                                                   | `RATE_LIMITED` |
