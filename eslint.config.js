import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.dependency-cruiser.cjs",
      ".claude/worktrees/**",
      "**/dist/**",
      "**/node_modules/**",
      "packages/db/src/types.ts",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "off",
      eqeqeq: ["error", "always"],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: "Money is integers: use parseMoney from @demoq/shared.",
        },
      ],
    },
  },
  {
    // Core never reads the wall clock: use ctx.now so tests and audit agree (principle 6).
    files: ["packages/core/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "Use ctx.now (or kernel.clock()), never new Date().",
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: "Use ctx.now (or kernel.clock()).",
        },
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: "Money is integers: use parseMoney from @demoq/shared.",
        },
      ],
    },
  },
);
