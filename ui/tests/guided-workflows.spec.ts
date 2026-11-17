// SPDX-License-Identifier: GPL-3.0-only
import { test, expect } from "@playwright/test";
const auth = { configured: true, authenticated: true, internal_auth: false };
test("equipment setup retries token creation without duplicating a sensor and waits for a packet", async ({
  page,
}, info) => {
  let sensor: any = null,
    creates = 0,
    keys = 0,
    packets = false;
  await page.route("**/api/v1/**", async (r) => {
    const p = new URL(r.request().url()).pathname,
      m = r.request().method();
    let body: any = [];
    if (p.endsWith("/auth/status")) body = auth;
    else if (p.endsWith("/diagnostics"))
      body = { collection_enabled: true, control_enabled: true };
    else if (p.endsWith("/resources/sensors") && m === "POST") {
      creates++;
      sensor = { id: "emu", kind: "sensors", ...r.request().postDataJSON() };
      body = sensor;
    } else if (p.endsWith("/resources/sensors")) body = sensor ? [sensor] : [];
    else if (p.endsWith("/sensors/emu/key")) {
      keys++;
      if (keys === 1)
        return r.fulfill({
          status: 503,
          json: { error: "Token generation failed" },
        });
      body = { token: "fixture-private-token" };
    } else if (p.endsWith("/resources/sensors/emu"))
      body = {
        ...sensor,
        data: {
          ...sensor.data,
          ...(packets
            ? {
                last_seen: Date.now(),
                last_automatic: { time: Date.now(), values: { angle: 45 } },
              }
            : {}),
        },
      };
    else if (m !== "GET") throw Error("Unexpected write: " + p);
    await r.fulfill({ json: body });
  });
  await page.goto("/sensors");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Test iSpindel");
  await page
    .getByRole("button", { name: "Connect equipment", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText("Token generation failed");
  await page
    .getByRole("button", { name: "Connect equipment", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Waiting for the first reading",
      exact: true,
    }),
  ).toBeVisible();
  expect(creates).toBe(1);
  expect(keys).toBe(2);
  await page.screenshot({
    path: `../state/equipment-setup-${test.info().project.name}.png`,
    fullPage: true,
  });
  await expect(page.getByLabel("Receiving token", { exact: true })).toHaveValue(
    "fixture-private-token",
  );
  packets = true;
  await expect(
    page.getByRole("heading", { name: "First reading received", exact: true }),
  ).toBeVisible({ timeout: 7000 });
  await expect(
    page.getByRole("link", { name: "Calibrate sensor", exact: true }),
  ).toBeVisible();
});

test("service setup saves disabled, previews locally and requires explicit activation", async ({
  page,
}) => {
  let target: any = null;
  const writes: any[] = [];
  const sensor = {
    id: "s",
    kind: "sensors",
    name: "SG source",
    data: { last_seen: Date.now(), last_values: { gravity: 1.04 } },
  };
  await page.route("**/api/v1/**", async (r) => {
    const p = new URL(r.request().url()).pathname,
      m = r.request().method();
    let body: any = [];
    if (p.endsWith("/auth/status")) body = auth;
    else if (p.endsWith("/diagnostics")) body = { exports_enabled: true };
    else if (p.endsWith("/resources/sensors")) body = [sensor];
    else if (p.endsWith("/resources/integrations") && m === "POST") {
      target = { id: "i", kind: "integrations", ...r.request().postDataJSON() };
      writes.push(target.data.enabled);
      body = target;
    } else if (p.endsWith("/resources/integrations/i")) {
      if (m === "PUT") {
        target = { ...target, ...r.request().postDataJSON() };
        writes.push(target.data.enabled);
      }
      body = target;
    } else if (p.endsWith("/resources/integrations"))
      body = target ? [target] : [];
    else if (p.endsWith("/integrations/i/preview"))
      body = { name: "SG source", gravity: 1.04, gravity_unit: "G" };
    else if (m !== "GET") throw Error("Unexpected write: " + p);
    await r.fulfill({ json: body });
  });
  await page.goto("/integrations");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Data source", exact: true })
    .selectOption("s");
  await page
    .getByLabel("Brewfather HTTPS endpoint", { exact: true })
    .fill("https://receiver.example/ingest");
  await page
    .getByRole("button", { name: "Save and preview", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review delivery", exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([false]);
  await page.screenshot({
    path: `../state/integration-setup-${test.info().project.name}.png`,
    fullPage: true,
  });
  await expect(
    page.getByText("No test message has been sent.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Activate delivery", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(writes).toEqual([false, true]);
});

test("finishing with control handles failed commands and retries batch save without repeating control", async ({
  page,
}) => {
  let commands = 0,
    saves = 0;
  const device = {
    id: "d",
    kind: "devices",
    name: "Test controller",
    data: {
      unit: "C",
      collection_enabled: true,
      control_claimed: true,
      last_seen: Date.now(),
      last_values: { fridge_set: 7, state: 0 },
    },
  };
  let batch: any = {
    id: "b",
    kind: "batches",
    name: "Test batch",
    data: { status: "active", device: "d", created: new Date().toISOString() },
  };
  await page.route("**/api/v1/**", async (r) => {
    const p = new URL(r.request().url()).pathname,
      m = r.request().method();
    let body: any = [];
    if (p.endsWith("/auth/status")) body = auth;
    else if (p.endsWith("/diagnostics"))
      body = { control_enabled: true, collection_enabled: true };
    else if (p.endsWith("/resources/devices/d")) body = device;
    else if (p.endsWith("/resources/devices")) body = [device];
    else if (p.endsWith("/resources/batches/b")) {
      if (m === "PUT") {
        saves++;
        if (saves === 1)
          return r.fulfill({
            status: 500,
            json: { error: "Batch save failed" },
          });
        batch = { ...batch, ...r.request().postDataJSON() };
      }
      body = batch;
    } else if (p.endsWith("/devices/d/command")) {
      commands++;
      expect(r.request().postDataJSON().mode).toBe("o");
      if (commands === 1)
        return r.fulfill({
          status: 503,
          json: { error: "No controller confirmation" },
        });
      body = { confirmed: true };
    } else if (m !== "GET") throw Error("Unexpected write: " + p);
    await r.fulfill({ json: body });
  });
  await page.goto("/batches/b");
  await page.getByRole("button", { name: "Finish batch", exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal
    .getByLabel("Temperature control after this batch")
    .selectOption("o");

  await modal
    .getByRole("button", { name: "Finish batch", exact: true })
    .click();
  await expect(modal.getByRole("alert")).toHaveText(
    "No controller confirmation",
  );
  expect(saves).toBe(0);
  await modal
    .getByRole("button", { name: "Finish batch", exact: true })
    .click();
  await expect(modal.getByRole("alert")).toHaveText("Batch save failed");
  expect(commands).toBe(2);
  await modal
    .getByRole("button", { name: "Finish batch", exact: true })
    .click();
  await expect(modal).toHaveCount(0);
  expect(commands).toBe(2);
  expect(batch.data.status).toBe("completed");
});

test("reconnecting restored controller preserves its suspended profile without claiming control", async ({
  page,
}) => {
  let device: any = {
    id: "restore",
    kind: "devices",
    name: "Restored controller",
    data: {
      unit: "C",
      host: "fixture.invalid",
      port: 23,
      connection_type: "wifi",
      collection_enabled: false,
      control_claimed: false,
      profile: "suspended",
      profile_started: 123,
    },
  };
  let writes = 0;
  await page.route("**/api/v1/**", async (r) => {
    const p = new URL(r.request().url()).pathname,
      m = r.request().method();
    let body: any = [];
    if (p.endsWith("/auth/status")) body = auth;
    else if (p.endsWith("/diagnostics"))
      body = { collection_enabled: true, control_enabled: true };
    else if (p.endsWith("/resources/devices/restore")) {
      if (m === "PUT") {
        writes++;
        device = { ...device, ...r.request().postDataJSON() };
      }
      body = device;
    } else if (p.endsWith("/resources/devices")) body = [device];
    else if (m !== "GET") throw Error("Unexpected hardware mutation: " + p);
    await r.fulfill({ json: body });
  });
  await page.goto("/devices/restore/connect");
  await expect(
    page.getByText("A previously assigned profile is suspended.", {
      exact: false,
    }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Connect equipment", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Waiting for the first reading",
      exact: true,
    }),
  ).toBeVisible();
  expect(writes).toBe(1);
  expect(device.data.collection_enabled).toBe(true);
  expect(device.data.control_claimed).toBe(false);
  expect(device.data.profile).toBe("suspended");
});
