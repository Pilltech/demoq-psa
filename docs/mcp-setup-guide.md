# Using DemoQ from Claude Code (draft — S2 personal access tokens)

> Draft for the pilot. OAuth sign-in (no token to copy) replaces this in S4; the final guide and walkthrough are Q-30 (W12).

1. **Create a token.** In DemoQ open **Profile → Access tokens → New token**. Give it a label (e.g. "Claude Code
   laptop"). Choose _read_ (search clients, read deals and quotes, see your approvals) or _read + write_ (also move
   deals, edit quotes). CEO, directors, ops leads, finance and admins can only create _read_ tokens. The token is shown
   **once** — copy it into your password manager.
2. **Keep it out of files.** Put it in an environment variable, never in a committed file:
   ```bash
   export DEMOQ_PAT='dq_pat_…'   # in your shell profile, or read it from your password manager
   ```
3. **Add the server** to your project's `.mcp.json`:
   ```json
   {
     "mcpServers": {
       "demoq": { "type": "http", "url": "https://app.demoq.com.kh/mcp", "headers": { "Authorization": "Bearer ${DEMOQ_PAT}" } }
     }
   }
   ```
4. **Try it.** Ask Claude: "Find the client Angkor Beverages in DemoQ and list its open deals."
5. **What to expect.** Claude sees exactly what you see on screen — same permissions, same rules (e.g. a deal cannot
   be closed as Lost without a reason). Every call is recorded in DemoQ's audit log under your name. Approvals below
   the margin floor must be decided in the app or on Telegram, not from chat.
6. **Revoke** a token any time from Profile. Tokens expire after at most 30 days.
