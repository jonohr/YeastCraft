// SPDX-License-Identifier: GPL-3.0-only
import { test, expect } from "@playwright/test";
test("stream setup is masked and batch delivery keeps the equipment name", async ({
  page,
}) => {
  let configured = false,
    enabled = false,
    status = "active";
  await page.route("**/api/v1/**", async (r) => {
    const path = new URL(r.request().url()).pathname;
    let body: any = [];
    if (path.endsWith("/auth/status"))
      body = { configured: true, authenticated: true, internal_auth: false };
    else if (path.endsWith("/resources/settings"))
      body = [{ data: { theme: "dark" } }];
    else if (path.endsWith("/brewfather/stream")) {
      if (r.request().method() === "PUT") {
        expect(r.request().postDataJSON()).toEqual({
          url: "https://log.brewfather.net/stream?id=synthetic-secret",
        });
        configured = true;
      }
      body = { configured, encrypted: configured, exports_enabled: true };
    } else if (path.endsWith("/resources/batches/test"))
      body = {
        id: "test",
        kind: "batches",
        name: "A recipe name",
        data: {
          status,
          created: "2026-11-20T08:00:00Z",
          device: "d",
          brewfather: { id: "remote", number: 44 },
          brewfather_export: { enabled },
        },
      };
    else if (path.endsWith("/batches/test/brewfather-export")) {
      if (r.request().method() === "PUT")
        enabled = r.request().postDataJSON().enabled;
      body = {
        enabled,
        device_name: "Lilla Kylen",
        connection: { configured, exports_enabled: true },
      };
    }
    await r.fulfill({ json: body });
  });
  await page.goto("/integrations");
  await page.getByRole("button", { name: "Set up Custom Stream" }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByLabel("Custom Stream URL", { exact: true });
  await expect(input).toHaveAttribute("type", "password");
  await input.fill("https://log.brewfather.net/stream?id=synthetic-secret");
  await expect(dialog).toContainText("No test measurement is sent");
  await dialog.getByRole("button", { name: "Save stream URL" }).click();
  await expect(dialog).toHaveCount(0);
  expect(enabled).toBe(false);
  await expect(
    page.getByRole("region", { name: "Brewfather outbound setup" }),
  ).toContainText("saved encrypted");
  await page.getByRole("button", { name: "Replace stream URL" }).click();
  await expect(input).toHaveValue("");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "synthetic-secret",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.goto("/batches/test");
  const panel = page.getByLabel("Send batch measurements");
  await expect(panel).toContainText("Device in Brewfather: Lilla Kylen");
  await expect(panel).toContainText("batch #44");
  await panel.getByRole("button", { name: "Start sending" }).click();
  await expect(panel).toContainText(
    "Manual Brewfather measurements are not sent back",
  );
  await panel.getByRole("button", { name: "Stop sending" }).click();
  await expect(panel).toContainText("Sending is off");
  const box = await panel.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await panel.screenshot({
    path: `/tmp/yc-stream-${test.info().project.name}.png`,
  });
  status = "completed";
  await page.reload();
  await expect(panel).toContainText("Sending stopped with this batch");
  await expect(panel.getByRole("button")).toHaveCount(0);
});
