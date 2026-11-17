import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
mkdirSync("../state", { recursive: true });
const testDatabase = `../state/browser-${randomUUID()}.sqlite`;
export default defineConfig({
  testDir: "tests",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:8316",
    headless: true,
    launchOptions: { executablePath: process.env.FERMENTRACK_CHROMIUM },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command: `../rust/target/debug/fermentrack-rs --db ${testDatabase} --listen 127.0.0.1:8316 --static dist --import-root ../fixtures/browser`,
    port: 8316,
    reuseExistingServer: false,
  },
  reporter: "list",
});
