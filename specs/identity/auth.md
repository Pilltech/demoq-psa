# identity/auth — sign-in, sessions, two-factor

**Status:** draft · **Sprint:** S1 · **Quotation refs:** base ("login and permissions")

## Rules
| ID | Rule | Error code |
|---|---|---|
| ID-AU-01 | Passwords are stored as argon2id hashes only; the plain password never reaches logs or audit. | — |
| ID-AU-02 | Wrong email and wrong password give the same error, in similar time (unknown emails are checked against a dummy hash). | `INVALID_CREDENTIALS` |
| ID-AU-03 | After 5 consecutive wrong passwords the account is locked for 15 minutes; the error stays the same. | `INVALID_CREDENTIALS` |
| ID-AU-04 | Sessions are server-side; the cookie holds a random token and only its SHA-256 is stored. Cookie is HttpOnly, Secure (in prod), SameSite=Lax. | — |
| ID-AU-05 | Sessions expire after 7 days, or 12 hours idle, and on logout. Changing a user's roles revokes their sessions. | `UNAUTHENTICATED` |
| ID-AU-06 | ceo, director, ops_lead, finance and admin must pass TOTP on every login; until then every API call except TOTP enrolment/verification is refused. | `TOTP_REQUIRED` |
| ID-AU-07 | A TOTP code cannot be used twice (replay), and codes older than one 30-second step are refused. | `TOTP_INVALID` |
| ID-AU-08 | TOTP seeds are encrypted at rest (AES-256-GCM); audit rows mask secrets. | — |
| ID-AU-09 | Every sign-in, failed sign-in, logout and TOTP verification is audited with the name typed or the user's name. | — |
| ID-AU-10 | Login attempts are rate-limited per IP. | `RATE_LIMITED` |
