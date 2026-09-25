---
name: spec
description: Write or update a feature spec with numbered, testable rules before any code. Use when starting a feature, e.g. /spec commercial/quote-builder.
disable-model-invocation: true
argument-hint: <module>/<feature>
---

# /spec $ARGUMENTS

You are writing the spec for **$ARGUMENTS**. Work in plan mode. Do not write code.

1. Read `docs/scope.md` (the quotation — the contract), the relevant rows of `docs/plan/DemoQ-PSA-Build-Plan.md`
   (§2.2 invariants, §4 domain model and state machines, §5 permissions/approvals), and `docs/decision-log.md`.
2. Copy `specs/_template.md` to `specs/$ARGUMENTS.md` if it does not exist.
3. **Interview the developer.** Ask about every business rule you are not sure of. Never guess a rule, a
   threshold, a permission or a Khmer string. Anything unanswered goes to "Open questions" with the default
   that ships if DemoQ does not answer (Appendix B style).
4. Fill in: rules with IDs `MOD-FEAT-NN` (each testable, each with an error code), the quotation refs (Q-xx),
   commands/queries with permission + `exposeTo` + risk, the permission-matrix delta (as proposed CSV rows —
   humans apply them), data + DB backstop per invariant, events, UI + new i18n keys, edge cases.
5. Write `specs/$ARGUMENTS` into `.claude/state/spec` and `spec` into `.claude/state/phase`.
6. Ask the `spec-reviewer` subagent to review; address its findings. End with `QUESTION:` listing what the
   PO must confirm.
