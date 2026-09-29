# channels/mcp-oauth — OAuth sign-in for Claude Code and Cowork, approvals from chat

**Status:** signed with defaults (D-MC-1, D-MC-2, D-MC-3 adopted 2026-09-29; DemoQ may still override) · **Sprint:** S4 (S4-08)
· **Quotation refs:** Q-27, Q-28, Q-29 · **Invariants:** INV-19
**Owner (dev):** Dev C · **Reviewer:** Dev A (security owner)

## Why

Claude Code and Cowork must reach DemoQ as the person using them, with the same permissions and rules as the
screens, and every call recorded under that person's name and the app they used. A personal access token is a
long-lived secret someone has to copy and store; OAuth lets people sign in with their DemoQ password (and TOTP)
and gives each app its own revocable grant. Deciding approvals from chat is useful for low-risk kinds but must never
happen by accident or through a prompt injection, and never for the high-risk kinds (INV-19).

## Rules

| ID        | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Error code                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| MCP-OA-01 | Discovery. `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` (RFC 9728) return `resource` exactly `${PUBLIC_BASE_URL}/mcp`, `authorization_servers: [PUBLIC_BASE_URL]` and `scopes_supported: [read, write, approvals:decide]`. The issuer is `PUBLIC_BASE_URL`; its metadata is at `/.well-known/oauth-authorization-server` (RFC 8414) and `/.well-known/openid-configuration`, with `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`, `client_id_metadata_document_supported: true` and no `registration_endpoint`. Discovery answers in under 10 s.      | —                                                      |
| MCP-OA-02 | `/mcp` without a valid credential answers HTTP 401 with `WWW-Authenticate: Bearer resource_metadata="${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/mcp", scope="read"` (plus `error="invalid_token"` when a token was sent). Asking for `read` only keeps clients from requesting every advertised scope.                                                                                                                                                                                                                                                                                                                               | —                                                      |
| MCP-OA-03 | Clients. Dynamic client registration is off (no endpoint; `/oauth/reg` is 404). Exactly two kinds of client exist: the one pre-registered Cowork / claude.ai client, whose ID and redirect URI come from configuration (`MCP_COWORK_CLIENT_ID`, `MCP_COWORK_REDIRECT_URI`) and are mirrored into `oauth_clients` at start-up, and CIMD clients (MCP-OA-04). All are public clients (`token_endpoint_auth_method: none`). An unknown client or an unregistered redirect URI gets an error page, never a redirect.                                                                                                                                  | `invalid_client`                                       |
| MCP-OA-04 | CIMD (Claude Code). A `client_id` that is an https URL with a path is fetched (5 s timeout, ≤ 5 KB, `redirect: manual`, JSON object) and accepted only if its `client_id` equals the URL, it carries no secret, its auth method is `none`, its grant/response types are within code + refresh, and every redirect URI is https or http on `localhost`/`127.0.0.1`. The host must not resolve to a private, loopback or link-local address. Accepted documents are cached 24 h in `oauth_clients`, then fetched again. http://127.0.0.1 documents are accepted only with `OAUTH_DEV_ALLOW_HTTP_CIMD=true`, which production configuration refuses. | `invalid_client`                                       |
| MCP-OA-05 | Loopback redirect URIs (`http://localhost/...`, `http://127.0.0.1/...`) registered by a CIMD client match any port (RFC 8252 §7.3); scheme, host and path must match.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `invalid_redirect_uri`                                 |
| MCP-OA-06 | PKCE is required on every authorization request, and only `S256`; a missing challenge or `plain` is refused, and a code only redeems with its verifier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `invalid_request`, `invalid_grant`                     |
| MCP-OA-07 | Resource indicators (RFC 8707). The only resource is `${PUBLIC_BASE_URL}/mcp` (the default when a client sends none); any other `resource` is `invalid_target`, at authorization and at refresh. Access tokens carry that audience, and `/mcp` refuses (401) any token whose audience differs, whose grant is gone, or whose person is inactive.                                                                                                                                                                                                                                                                                                  | `invalid_target`                                       |
| MCP-OA-08 | Tokens (D-MC-2). The token endpoint takes `application/x-www-form-urlencoded` and answers RFC 6749 JSON errors. Access tokens are opaque, last 1 h. Every grant gets a refresh token that lasts 30 days and rotates on every use; presenting a used refresh token is `invalid_grant` and revokes the whole grant (theft detection).                                                                                                                                                                                                                                                                                                               | `invalid_grant`, `invalid_request`                     |
| MCP-OA-09 | Scopes. `read` is always granted and is the default; `write` and `approvals:decide` must be requested. Privileged roles (ceo, director, ops_lead, finance, admin) are never granted `write` or `approvals:decide` (the consent page lists them as refused), and `/mcp` drops them at call time if a person becomes privileged later. Effective permission = the person's permissions ∩ the token's scopes: queries need `read`, commands need `write`, `confirm_decide_approval` needs `approvals:decide` (a write PAT carries it).                                                                                                               | `FORBIDDEN`                                            |
| MCP-OA-10 | Sign-in. Every authorization shows the sign-in page (so no app gets a code without the person present); it checks email and password with the web's rules (argon2, lockout after 5 failures, per-IP rate limit) and requires the authenticator code for privileged roles and anyone who enabled TOTP. A privileged person who has not enrolled is sent to the app to enrol. Each attempt is audited (`auth.login`, `auth.totp_verify`) on channel `mcp` with the client id.                                                                                                                                                                       | `INVALID_CREDENTIALS`, `TOTP_REQUIRED`, `TOTP_INVALID` |
| MCP-OA-11 | Consent. An EN/KM page shows the client name and ID, the person's name, the host it will redirect to and each scope with its meaning, and the scopes refused for the person's role. The answer is remembered per person and client for 30 days (a new scope asks again). Allow is audited as `oauth.grant` (granted/refused scopes, redirect host, grant id); Deny returns `access_denied` and is audited. The pages load nothing external, run no script and send a strict CSP; forms carry an HMAC CSRF token bound to the interaction and refuse foreign `Origin`s.                                                                            | `access_denied`                                        |
| MCP-OA-12 | Audit and limits. Every MCP call is audited by the person's name with `mcp_client` = the OAuth `client_id` (CIMD URL or pre-registered ID) and `mcp_grant_id` = the grant; PAT calls keep `pat:<label>` and `pat:<token id>`. 60 calls per minute per person for OAuth (all grants together) and per PAT; over that → HTTP 429 with `Retry-After`.                                                                                                                                                                                                                                                                                                | `RATE_LIMITED`                                         |
| MCP-OA-13 | `mcp.writes` (D-MC-3): a `settings` row, off unless it is JSON `true` (the migration ships no row). While off, every command over MCP — PAT or OAuth, approvals included — fails with `MCP_WRITES_DISABLED` and write tools are hidden from `tools/list`. An admin switches it with `mcp.set_writes` (web, `admin.config`, audited). Tests and dev switch it on explicitly.                                                                                                                                                                                                                                                                       | `MCP_WRITES_DISABLED`                                  |
| MCP-OA-14 | `prepare_decide_approval` (op `approval.prepare_decide`) returns a summary, a field-level diff, the typed text inside `untrusted_content`, and a one-time token (`dq_mct_…`, stored as SHA-256) bound to the person, the credential (OAuth grant or `pat:<id>`), the approval, the decision and outcome, and the approval version and subject version/hash; single use, 5 minutes. `approval_decide` itself is not an MCP tool: decisions from chat always take these two steps.                                                                                                                                                                  | `NOT_FOUND`, `ALREADY_DECIDED`, `SELF_APPROVAL`        |
| MCP-OA-15 | `confirm_decide_approval` (op `approval.confirm_decide`, `destructiveHint: true`) runs `approval.decide` on channel `mcp` in the same transaction as it burns the token, and audits `approval.decide` like every other channel. A token that is unknown, another person's or another grant's, used, expired, or stale (approval or subject changed since prepare) is refused and nothing is decided.                                                                                                                                                                                                                                              | `CONFIRM_TOKEN_INVALID`                                |
| MCP-OA-16 | INV-19. For `margin_floor`, `gate_bypass`, `bypass_review`, `influencer_work` and an out-of-scope "absorb", and for any kind whose policy does not allow MCP, prepare answers `DECIDE_IN_APP` with a link to `${PUBLIC_BASE_URL}/inbox?approval=<id>` — also for read-only people, before any scope check — and issues no token. Backstop: `approvals_inv19_not_over_mcp` refuses recording such a decision with channel `mcp`.                                                                                                                                                                                                                   | `DECIDE_IN_APP`                                        |

## Commands and queries

| Name                      | Permission                                              | exposeTo | Risk   | Audit subject                         |
| ------------------------- | ------------------------------------------------------- | -------- | ------ | ------------------------------------- |
| `approval.prepare_decide` | `approval.view` (+ approver check in run)               | mcp      | normal | approval                              |
| `approval.confirm_decide` | `approval.view` (+ approver check in `approval.decide`) | mcp      | high   | approval (+ an `approval.decide` row) |
| `mcp.set_writes`          | `admin.config`                                          | web      | normal | —                                     |

MCP tool names: `prepare_decide_approval`, `confirm_decide_approval` (plan §5.6; the repo's `ask` rule matches
`mcp__demoq__confirm_*`). Sign-in, consent and token issuance are not registry commands (there is no actor yet), like
`identity/auth.ts`; they are audited as `auth.login`, `auth.totp_verify` and `oauth.grant`.

## Permission matrix delta

None. The new ops reuse `approval.view` (with the existing approver checks) and `admin.config`.

## Data

- `oidc_payloads(model, id, payload jsonb, grant_id, uid, account_id, client_id, expires_at, consumed_at)` — the
  `oidc-provider` adapter. Ids are stored as SHA-256; token models (access, refresh, code) drop their `jti` from the
  payload, so the table never yields a usable token. Protocol state only: the app role may DELETE here (expiry,
  revocation) and nowhere else; no row-change trigger (semantic audit instead).
- `oauth_clients(client_id, kind preregistered|cimd, metadata, fetched_at, expires_at, disabled_at)` — CHECKs: CIMD rows
  carry a fetch time and expire ≤ 24 h later; every client is public (`none`, no secret). Row-change audited.
- `mcp_confirm_tokens(token_hash, user_id, grant_id, approval_id, decision, outcome, note, approval_version,
subject_version, subject_hash, expires_at, used_at, created_at)` — CHECK TTL ≤ 5 minutes; `outcome` can never be
  `absorb`. Row-change audited (hash redacted).
- `audit_events.mcp_grant_id` (plan §5.7).
- `approvals_inv19_not_over_mcp` CHECK on `approvals` (DB backstop for INV-19), mapped to `DECIDE_IN_APP`.
- Settings key `mcp.writes` (JSON boolean).

## Configuration

`PUBLIC_BASE_URL` (issuer; https required in production), `OAUTH_COOKIE_KEYS` and `OAUTH_JWKS` (required in
production; generated per process in dev/test), `MCP_COWORK_CLIENT_ID`, `MCP_COWORK_REDIRECT_URI`,
`OAUTH_DEV_ALLOW_HTTP_CIMD` (refused in production), `OAUTH_RATE_PER_MIN`.

## UI

Server-rendered sign-in and consent pages under `/oauth/interaction/:uid`, EN and KM (Khmer marked `KM-DRAFT:` until
the reviewer signs), `?lang=km|en` switch, no external assets or script, CSP with a hashed style.

## Edge cases

- A person's role changes after consent: `/mcp` recomputes scopes on every call (privileged → read only).
- A person is deactivated: `/mcp` refuses their tokens at once (401).
- Two grants for one person share one rate-limit budget.
- A remembered grant for a scope set does not cover a newly requested scope: consent is asked again.
- The OAuth sign-in session lasts 10 minutes and tokens never depend on it.

## Decisions taken while building (engineering)

- Issuer = `PUBLIC_BASE_URL` (no path) with endpoints under `/oauth/*`, so RFC 8414 metadata sits at the root
  `/.well-known/oauth-authorization-server`.
- CIMD is handled by our storage adapter (`oauth_clients` cache, SSRF guard, dev http flag), not the provider's
  built-in in-memory CIMD feature, which cannot persist or be pointed at a local test server.
- Every authorization signs in (password + TOTP where required) instead of reusing a browser session. With remembered
  consent this keeps RFC 8252's "native client impersonation" defence without re-asking consent every time.
- A write PAT carries `approvals:decide` (bound to that PAT) so headless use keeps the ability it had in S2.
- Direct `approval_decide` is removed from MCP; `approval.decide` keeps `mcp` in its `exposeTo` because
  `confirm_decide_approval` runs it on channel `mcp` (and the INV-19 guard inside it stays the second line).

## Open questions

- DemoQ may override D-MC-1..3 (client model, lifetimes, the writes flag default). Defaults above ship.
- The PWA inbox does not yet open the approval named in `?approval=<id>`; the link lands on the inbox (web slice).
