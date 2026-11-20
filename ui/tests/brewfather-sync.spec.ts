// SPDX-License-Identifier: GPL-3.0-only
import { test, expect } from "@playwright/test";
test("linked batch sync retains manual SG on failure and stops on completion", async ({
  page,
}) => {
  let status = "active",
    fail = false,
    calls = 0;
  let sync: any = {};
  await page.route("**/api/v1/**", async (r) => {
    const p = new URL(r.request().url()).pathname;
    let body: any = [];
    if (p.endsWith("/auth/status"))
      body = { configured: true, authenticated: true, internal_auth: false };
    else if (p.endsWith("/resources/settings"))
      body = [{ data: { theme: "dark" } }];
    else if (p.endsWith("/resources/batches/test"))
      body = {
        id: "test",
        kind: "batches",
        name: "Synthetic batch",
        data: {
          status,
          created: "2026-11-20T08:00:00Z",
          brewfather: { id: "remote", number: 44 },
          brewfather_sync: sync,
        },
      };
    else if (p.endsWith("/batches/test/brewfather-sync")) {
      expect(r.request().method()).toBe("POST");
      calls++;
      sync = fail
        ? {
            ...sync,
            error:
              "Could not sync manual readings. Existing readings are retained.",
          }
        : {
            last_success: 1795162000000,
            latest: { sg: 1.033, time: 1795161614546 },
          };
      body = sync;
    }
    await r.fulfill({ json: body });
  });
  await page.goto("/batches/test");
  const panel = page.getByRole("region", { name: "Brewfather readings" });
  await expect(panel).toContainText("No readings synced yet");
  await panel.getByRole("button", { name: "Sync readings" }).click();
  await expect(panel).toContainText("1.033 SG");
  await expect(panel).toContainText("Manual · Brewfather");
  expect(calls).toBe(1);
  const box = await panel.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await panel.screenshot({
    path: `/tmp/yc-sg-${test.info().project.name}.png`,
  });
  fail = true;
  await panel.getByRole("button", { name: "Sync readings" }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "Existing readings are retained",
  );
  await expect(panel).toContainText("1.033 SG");
  status = "completed";
  await page.reload();
  await expect(panel).toContainText("Sync stopped");
  await expect(
    panel.getByRole("button", { name: "Sync readings" }),
  ).toHaveCount(0);
});
