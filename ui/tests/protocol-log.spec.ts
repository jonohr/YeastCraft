// SPDX-License-Identifier: GPL-3.0-only
import { test, expect } from "@playwright/test";
test("raw BrewPi traffic loads on demand without sending commands", async ({
  page,
}) => {
  let reads = 0,
    writes = 0;
  const d = {
    id: "d",
    kind: "devices",
    name: "Mock controller",
    data: {
      unit: "C",
      collection_enabled: true,
      control_claimed: true,
      last_seen: Date.now(),
      last_values: { fridge_set: 6.5, fridge_temp: 7, state: 0 },
    },
  };
  await page.route("**/api/v1/**", async (r) => {
    const p = new URL(r.request().url()).pathname;
    let body: any = [];
    if (r.request().method() !== "GET") {
      writes++;
      return r.abort();
    }
    if (p.endsWith("/auth/status"))
      body = { configured: true, authenticated: true, internal_auth: false };
    else if (p.endsWith("/diagnostics"))
      body = { collection_enabled: true, control_enabled: true };
    else if (p.endsWith("/resources/devices/d")) body = d;
    else if (p.endsWith("/resources/devices")) body = [d];
    else if (p.endsWith("/protocol-log")) {
      reads++;
      body = [
        { time: Date.now(), direction: "TX", line: "t", truncated: false },
        {
          time: Date.now(),
          direction: "RX",
          line: 'T:{"bt":6.6,"fs":6.5}',
          truncated: false,
        },
        {
          time: Date.now(),
          direction: "RX",
          line: "D:" + "x".repeat(2048),
          truncated: true,
        },
      ];
    }
    await r.fulfill({ json: body });
  });
  await page.goto("/devices/d");
  expect(reads).toBe(0);
  await page.getByText("BrewPi raw log", { exact: true }).click();
  await expect(page.getByLabel("Raw BrewPi traffic")).toContainText(
    'T:{"bt":6.6,"fs":6.5}',
  );
  await expect(page.getByLabel("Raw BrewPi traffic")).toContainText(
    "[truncated]",
  );
  await page.getByRole("button", { name: "Refresh log", exact: true }).click();
  await expect.poll(() => reads).toBe(2);
  expect(writes).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByText(/only controller owner|No other application/),
  ).toHaveCount(0);
});
