# Runbook — ZAP baseline scan (S4-09, plan §9.1)

**Trigger:** weekly (Monday 08:17 ICT), every push to `main`, or on demand (Actions → "ZAP baseline" → Run workflow;
optional `target` = a staging URL).

**What it is:** the OWASP ZAP _baseline_ (passive) scan: it spiders the app and reports header, cookie and disclosure
problems. It does not attack. The active scan is part of the external pen test (W9).

**Checks**

1. The job starts a fresh local build with synthetic seed data (`scripts/e2e-server.sh`) unless `target` is given.
2. `.zap/rules.tsv` sets each rule to FAIL, WARN or IGNORE. A FAIL fails the job; WARN is reported only.
3. The HTML/JSON/Markdown reports are uploaded as the `zap-report` artifact (14 days). On schedule and manual runs the
   action also opens or updates one GitHub issue with the findings.

**Steps when it fails**

1. Open the `zap-report` artifact; find the FAIL rule and the URL.
2. Fix it in code (usually `@fastify/helmet` options or cookie flags in `apps/api/src/app.ts`), with a test.
3. Only if the finding is a false positive: change the rule to WARN or IGNORE in `.zap/rules.tsv` with the reason in
   the third column, in a PR the tech lead approves.

**Verification:** re-run the workflow; it is green and the issue closes itself.

**Notify:** tech lead (Dev A). Security findings of High risk also go to the PO the same day.
