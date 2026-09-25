# ADR-0002 · Four packages and two apps

**Status:** accepted (S1). `packages/core` (the only DB user; all rules), `packages/shared` (pure: money, contracts, i18n — also runs in the browser), `packages/db` (migrations, runner, generated types), `packages/testkit` (template DBs, factories, seed); `apps/api` (Fastify adapters), `apps/web` (PWA). Boundaries are enforced by dependency-cruiser (`.dependency-cruiser.cjs`) in `pnpm lint`, CI and the Stop hook.
