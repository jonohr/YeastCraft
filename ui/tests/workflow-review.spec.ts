import { test, expect } from "@playwright/test";
import { profileSteps, newestFirst, batchStatus } from "../src/workflow";
import { controllerEvent } from "../src/controller";
test("imported history and schedules retain their meaning", () => {
  expect(
    batchStatus({ data: {}, kind: "batches", id: "x", name: "old" }),
  ).toContain("unknown");
  expect(
    profileSteps({
      unit: "C",
      legacy_steps: [
        { ttl: 172800000000, temperature_setting: 21 },
        { ttl: 216000000000, temperature_setting: -1 },
      ],
    }),
  ).toEqual([
    { name: "Initial hold", hours: 48, temperature: 21, transition: "hold" },
    { name: "Imported ramp 1", hours: 12, temperature: -1, transition: "ramp" },
  ]);
  expect(controllerEvent("Mode set to p in web interface")).toBe(
    "Control changed to fermentation profile",
  );
  expect(
    newestFirst([
      { id: "old", data: { created: "2024-01-01" } },
      { id: "new", data: { created: "2026-01-01" } },
    ] as any).map((e) => e.id),
  ).toEqual(["new", "old"]);
});
test("batch review retries a failed command using the same draft", async ({
  page,
}) => {
  let batch: any = null,
    creates = 0,
    commands = 0;
  const device = {
    id: "test",
    kind: "devices",
    name: "Test chamber",
    data: {
      unit: "C",
      collection_enabled: true,
      control_claimed: true,
      last_seen: Date.now(),
    },
  };
  await page.route("**/api/v1/**", async (r) => {
    const path = new URL(r.request().url()).pathname,
      method = r.request().method();
    let body: any = [];
    if (path.endsWith("/auth/status"))
      body = { configured: true, authenticated: true, internal_auth: false };
    else if (path.endsWith("/diagnostics"))
      body = { control_enabled: true, collection_enabled: true };
    else if (path.endsWith("/devices/test/command")) {
      commands++;
      if (commands === 1)
        return r.fulfill({
          status: 503,
          json: { error: "Controller unavailable" },
        });
      body = { confirmed: true };
    } else if (path.endsWith("/resources/devices/test")) body = device;
    else if (path.endsWith("/resources/devices")) body = [device];
    else if (path.endsWith("/resources/batches") && method === "POST") {
      creates++;
      const v = r.request().postDataJSON();
      batch = { id: "batch", kind: "batches", ...v };
      body = batch;
    } else if (path.endsWith("/resources/batches/batch")) {
      if (method === "PUT") batch = { ...batch, ...r.request().postDataJSON() };
      body = batch;
    } else if (path.endsWith("/resources/batches")) body = batch ? [batch] : [];
    await r.fulfill({ json: body });
  });
  await page.goto("/batches");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Test fermentation");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByLabel("Temperature controller", { exact: true })
    .selectOption("test");
  await page.getByLabel("Temperature plan").selectOption("b");
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await page.getByRole("button", { name: "Start batch", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Controller unavailable");
  expect(batch.data.status).toBe("planned");
  expect(creates).toBe(1);
  await page.getByRole("button", { name: "Start batch", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Test fermentation", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/batches\/batch$/);
  expect(creates).toBe(1);
  expect(commands).toBe(2);
  expect(batch.data.status).toBe("active");
});
