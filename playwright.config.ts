import { defineConfig, devices } from "@playwright/test";

// Uses the pre-installed Chromium when PW_CHROMIUM is set (CI images pin their own).
const executablePath = process.env.PW_CHROMIUM || undefined;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { executablePath },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath } } },
    { name: "phone", use: { ...devices["Pixel 7"], launchOptions: { executablePath } }, grep: /@phone/ },
  ],
  webServer: {
    command: "bash scripts/e2e-server.sh",
    url: "http://127.0.0.1:3100/healthz",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
