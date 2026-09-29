# Using DemoQ from Claude (Claude Code and Cowork)

> Pilot guide (S4). The final guide and walkthrough are Q-30 (W12). Rules: `specs/channels/mcp.md`,
> `specs/channels/mcp-oauth.md`.

DemoQ's MCP server is `https://app.demoq.com.kh/mcp`. You connect by **signing in with your DemoQ account** (OAuth):
there is no token to copy. Claude then sees exactly what you see on screen — same permissions, same rules (e.g. a deal
cannot be closed as Lost without a reason) — and every call is recorded in DemoQ's audit log under your name and the
app you used.

## Claude Code (interactive)

1. Add the server once:
   ```bash
   claude mcp add --transport http demoq https://app.demoq.com.kh/mcp
   ```
2. In Claude Code run `/mcp`, pick **demoq → Authenticate**. Your browser opens DemoQ's sign-in page.
3. Sign in with your DemoQ email and password. CEO, directors, ops leads, finance and admins (and anyone who turned on
   two-step sign-in) also type the 6-digit code from their authenticator app. If DemoQ says to set up two-step sign-in
   first, do that in the DemoQ app, then try again.
4. The consent page shows the app asking (Claude Code identifies itself with its published client metadata), the
   address it will return to (`localhost` or `127.0.0.1` on your computer) and what it asks for. Check them and click
   **Allow**. DemoQ remembers your answer for this app for 30 days; you still sign in each time an app connects.
5. Try it: "Find the client Angkor Beverages in DemoQ and list its open deals."

Access lasts one hour and renews itself for up to 30 days; after that, authenticate again from `/mcp`.

## Claude Cowork / claude.ai (custom connector)

An **organisation Owner** adds DemoQ once for everyone:

1. **Settings → Connectors → Add custom connector.**
2. URL: `https://app.demoq.com.kh/mcp`.
3. **Advanced settings → OAuth Client ID:** the DemoQ-issued ID (ask DemoQ ops; it is the value of
   `MCP_COWORK_CLIENT_ID`). Leave the client secret empty. DemoQ accepts this client only with Claude's callback URL
   (`MCP_COWORK_REDIRECT_URI`, by default `https://claude.ai/api/mcp/auth_callback`).
4. Each person then clicks **Connect** on the DemoQ connector and signs in and consents as above, so every call is
   made — and audited — in their own name. Never use a shared "static headers" connector: it is one credential for
   everyone and breaks "audited by name".
5. Keep DemoQ's write tools on **Ask** (Cowork tool permissions), so Claude asks you before changing anything.

## What Claude can do

| Access               | How you get it                                                                              | Notes                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read** (default)   | Every connection                                                                            | Search clients, read deals and quotes, your tasks, your approvals…                                                                                |
| **Write**            | The app asks for the `write` scope; never for CEO, directors, ops leads, finance and admins | Also off for everyone until DemoQ turns on "changes from Claude" (`mcp.writes`) after the security retest. Until then write tools do not appear.  |
| **Decide approvals** | The app asks for `approvals:decide`; same roles excluded                                    | Always two steps: Claude prepares the decision and shows you exactly what will change, then confirms it with a one-time code valid for 5 minutes. |

Some decisions are **never** made from chat: margin floor, gate bypass, monthly bypass review, influencer work and
absorbing out-of-scope work. Claude replies with a link to the approval in the DemoQ app (`/inbox?approval=…`) —
decide it there or on Telegram.

The repository's `.claude/settings.json` has an `ask` rule for `mcp__demoq__confirm_*`, so Claude Code always asks
before confirming a decision, even in auto mode.

## Headless use only: personal access tokens

For scripts, CI and `claude -p` (no browser), use a personal access token instead of OAuth:

1. **Profile → Access tokens → New token.** Label it (e.g. "CI report job"); choose _read_ or _read + write_ (CEO,
   directors, ops leads, finance and admins can only create _read_ tokens). The token is shown **once**. Tokens expire
   after at most 30 days and can be revoked from Profile at any time. A _read + write_ token can also decide approvals
   in the same two steps.
2. Keep it out of files — an environment variable filled from your password manager:
   ```bash
   export DEMOQ_PAT="$(op read op://demoq/mcp-pat/token)"
   ```
3. Reference it with env expansion in the project's `.mcp.json`, never as a literal:
   ```json
   {
     "mcpServers": {
       "demoq": { "type": "http", "url": "https://app.demoq.com.kh/mcp", "headers": { "Authorization": "Bearer ${DEMOQ_PAT}" } }
     }
   }
   ```

## Limits and troubleshooting

- 60 calls per minute per person (per token for PATs). Over that Claude gets "too many requests" and should wait.
- "This decision must be made in the DemoQ app" → open the link Claude shows.
- "Changing data from Claude is switched off for now" → `mcp.writes` is off; use the app.
- Claude cannot see something → your role decides what you see; ask your ops lead.
- To cut an app off: revoke the PAT from Profile, or ask ops to revoke the OAuth grant.

## For DemoQ ops (configuration)

`PUBLIC_BASE_URL=https://app.demoq.com.kh` (the issuer; the MCP resource is `…/mcp`), `OAUTH_COOKIE_KEYS` and
`OAUTH_JWKS` from the vault, `MCP_COWORK_CLIENT_ID` / `MCP_COWORK_REDIRECT_URI` for the Cowork connector.
`OAUTH_DEV_ALLOW_HTTP_CIMD` must stay unset outside dev/test. Cloudflare must let Anthropic's published outbound range
through to `/mcp`, `/oauth/*` and `/.well-known/oauth-*`. An admin switches writes over MCP with the `mcp.set_writes`
operation (audited); in dev: `POST /api/v1/ops/mcp.set_writes` with `{"enabled": true}` as `admin@demoq.test`.
