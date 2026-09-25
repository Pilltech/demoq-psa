import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/**/*.unit.test.ts", "tests/unit/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "db",
          include: ["packages/**/*.db.test.ts", "apps/**/*.db.test.ts", "tests/db/**/*.test.ts"],
          globalSetup: ["packages/testkit/src/global-setup.ts"],
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
