// Boundary rules (plan §3.3). Checked in CI and by the Claude Stop hook.
module.exports = {
  forbidden: [
    {
      name: "apps-no-db",
      comment: "Adapters call @demoq/core only. The DB is core's business (server.ts wires the pool).",
      severity: "error",
      from: { path: "^apps/", pathNot: ["^apps/api/src/(server|worker)\\.ts$", "\\.test\\.ts$"] },
      to: { path: "^packages/db/" },
    },
    {
      name: "only-core-imports-db",
      severity: "error",
      from: { path: "^packages/(shared)/" },
      to: { path: "^packages/db/" },
    },
    {
      name: "shared-is-pure",
      comment: "shared runs in the browser too: no I/O.",
      severity: "error",
      from: { path: "^packages/shared/", pathNot: "\\.test\\.ts$" },
      to: { dependencyTypes: ["core"], path: "^(fs|net|http|https|child_process|node:)" },
    },
    {
      name: "shared-no-db-libs",
      severity: "error",
      from: { path: "^packages/shared/" },
      to: { path: "node_modules/(pg|kysely)/" },
    },
    {
      name: "core-modules-via-index",
      comment: "A core module reaches another module only through its index.ts.",
      severity: "error",
      from: { path: "^packages/core/src/([^/]+)/" },
      to: {
        path: "^packages/core/src/([^/]+)/",
        pathNot: ["^packages/core/src/$1/", "^packages/core/src/[^/]+/index\\.ts$"],
      },
    },
    {
      name: "web-no-server-packages",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^packages/(core|db|testkit)/" },
    },
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(node_modules|dist)/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "default"],
      extensions: [".ts", ".tsx", ".js"],
    },
  },
};
