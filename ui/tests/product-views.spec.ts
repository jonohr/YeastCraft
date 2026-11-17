// SPDX-License-Identifier: GPL-3.0-only
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
test("all composed product views, custom reviews, history and keyboard navigation", async ({
  page,
  request,
}, info) => {
  test.setTimeout(120000);
  const credentials = {
    username: "browser-test",
    password: "browser-test-password-123",
  };
  const status = await (await request.get("/api/v1/auth/status")).json();
  if (!status.configured)
    await request.post("/api/v1/auth/setup", { data: credentials });
  await page.goto("/");
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  const create = async (kind: string, name: string, data: any) => {
    const response = await page.request.post("/api/v1/resources/" + kind, {
      data: { name: name + " " + info.project.name, data },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const now = Date.now();
  const device = await create("devices", "Preview fridge", {
    unit: "C",
    connection_type: "wifi",
    host: "controller.example",
    port: 23,
    collection_enabled: false,
    control_claimed: false,
    last_seen: now,
    last_values: {
      beer_temp: 18.4,
      fridge_temp: 17.9,
      room_temp: 21.2,
      beer_set: 18.5,
      fridge_set: null,
      state: 0,
      temp_format: "C",
    },
  });
  const sensor = await create("sensors", "Preview iSpindel", {
    sensor_type: "ispindel",
    device: device.id,
    unit: "C",
    gravity_source: "server",
    reported_gravity_unit: "SG",
    last_seen: now,
    last_values: {
      gravity: 1.018,
      angle: 42.6,
      gravity_temp: 18.4,
      battery: 3.9,
      temp_format: "C",
    },
  });
  const batch = await create("batches", "Summer IPA", {
    device: device.id,
    sensor: sensor.id,
    status: "active",
    unit: "C",
    created: new Date(now - 5 * 86400000).toISOString(),
    original_gravity: 1.052,
  });
  const profile = await create("profiles", "American Ale", {
    unit: "C",
    control_sensor: "beer",
    end_behavior: "hold",
    steps: [
      {
        name: "Primary fermentation",
        temperature: 18.5,
        hours: 168,
        transition: "hold",
      },
      {
        name: "Finish fermentation",
        temperature: 20,
        hours: 48,
        transition: "ramp",
      },
      { name: "Diacetyl rest", temperature: 20, hours: 48, transition: "hold" },
      { name: "Cold condition", temperature: 7, hours: 72, transition: "ramp" },
    ],
  });
  const note = await create("notes", "Dry hopping", {
    batch: batch.id,
    text: "Added Citra for dry hopping.",
    created: new Date(now - 3600000).toISOString(),
  });
  const integration = await create(
    "integrations",
    "BrewfatherLongImportedIntegrationName",
    {
      type: "brewfather",
      source: sensor.id,
      enabled: false,
      url: "https://example.invalid/ingest",
      interval: 15,
    },
  );
  for (const [angle, gravity] of [
    [25, 1],
    [36, 1.012],
    [48, 1.026],
    [60, 1.044],
  ]) {
    const r = await page.request.post(
      "/api/v1/sensors/" + sensor.id + "/measurement",
      {
        data: {
          angle,
          gravity,
          gravity_temp: 18.4,
          temp_format: "C",
          calibration_reference: true,
        },
      },
    );
    expect(r.ok()).toBe(true);
  }
  const points = Array.from({ length: 48 }, (_, i) => ({
    time: now - (47 - i) * 1800000,
    source: batch.id,
    values: {
      beer_temp: 18.4 + Math.sin(i / 5) * 0.5,
      fridge_temp: 17.9,
      beer_set: 18.5,
      fridge_set: null,
      temp_format: "C",
      gravity: 1.052 - i * 0.0007,
      state: [0, 4, 0, 3][Math.floor(i / 4) % 4],
    },
  }));
  await page.route("**/api/v1/measurements/**", (r) =>
    r.fulfill({ json: points }),
  );
  // Expose controls for visual inspection, while preventing any actual command.
  await page.route("**/api/v1/diagnostics", (r) =>
    r.fulfill({
      json: {
        control_enabled: true,
        collection_enabled: true,
        exports_enabled: false,
        database_bytes: 123456,
        version: "0.1.0",
      },
    }),
  );
  const commandRequests: any[] = [];
  await page.route("**/api/v1/devices/*/profile", (r) => {
    expect(r.request().method()).toBe("POST");
    commandRequests.push(r.request().postDataJSON());
    return r.fulfill({ json: { assigned: true } });
  });
  const folder = "../state/ui-acceptance/" + info.project.name;
  mkdirSync(folder, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const capture = async (name: string) => {
    await expect(page.locator(".loading")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      name + " overflow",
    ).toBe(false);
    await page.screenshot({
      path: folder + "/" + name + ".png",
      fullPage: true,
    });
  };
  for (const [name, path] of [
    ["overview", "/"],
    ["batches", "/batches"],
    ["equipment", "/devices"],
    ["sensors", "/sensors"],
    ["profiles", "/profiles"],
    ["integrations", "/integrations"],
    ["notes", "/notes"],
    ["settings", "/settings"],
    ["diagnostics", "/diagnostics"],
    ["import", "/import"],
    ["backup", "/backup"],
    ["firmware", "/firmware"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    if (name === "overview") await expect(page.locator("canvas")).toBeVisible();
    await capture(name);
    if (name === "integrations") {
      const originalViewport = page.viewportSize()!;
      await page.setViewportSize({ width: 768, height: 900 });
      await capture("integrations-tablet");
      await page.setViewportSize(originalViewport);
    }
  }
  await page.goto("/batches/" + batch.id);
  await expect(page.locator("canvas")).toBeVisible();
  await capture("batch-fermentation");
  await page.getByRole("button", { name: "Readings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Measurement history" }),
  ).toBeVisible();
  await capture("batch-readings");
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page.getByText("Added Citra for dry hopping.")).toBeVisible();
  await capture("batch-notes");
  await page.getByRole("button", { name: "Finish batch", exact: true }).click();
  await page.getByLabel("Final gravity SG").fill("1.012");
  await capture("finish-batch");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Finish batch", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const finished = await (
    await page.request.get("/api/v1/resources/batches/" + batch.id)
  ).json();
  expect(finished.data.status).toBe("completed");
  expect(finished.data.final_gravity).toBe(1.012);
  expect(
    (
      await (
        await page.request.get("/api/v1/resources/devices/" + device.id)
      ).json()
    ).data,
  ).toEqual(device.data);
  await page.goto("/devices/" + device.id);
  await expect(page.locator("canvas")).toBeVisible();
  await capture("controller");
  await page
    .getByRole("button", { name: "Change target", exact: true })
    .click();
  await capture("change-target");
  await page.getByRole("dialog").press("Escape");
  await page.goto("/sensors/" + sensor.id);
  await page.getByLabel("Measured gravity SG").waitFor();
  await expect(
    page
      .locator(".measurement-card")
      .filter({ hasText: "Sensor temperature" })
      .locator("strong"),
  ).toContainText("18.4");
  await capture("manual-reading");
  await page.getByRole("button", { name: "Connection", exact: true }).click();
  await capture("sensor-connection");
  await page
    .getByRole("button", { name: "Calibration & source", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start calibration", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Check calibration curve", exact: true }),
  ).toBeEnabled();
  await capture("calibration-references");
  await page
    .getByRole("button", { name: "Check calibration curve", exact: true })
    .click();
  await expect(
    page.getByRole("img", {
      name: "Calibration curve against measured references",
    }),
  ).toBeVisible();
  await capture("calibration-fit");
  await page.goto("/profiles/" + profile.id);
  await expect(
    page.getByRole("img", { name: "Temperature schedule preview" }),
  ).toBeVisible();
  await capture("profile-detail");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".profile-page-editor")).toBeVisible();
  await capture("profile-editor");
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await capture("profile-add-step");
  await page
    .getByRole("button", { name: "Ramp gradually", exact: false })
    .click();
  await expect(page.locator(".profile-step")).toHaveCount(5);
  await page.getByLabel("Remove step", { exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await capture("profile-remove-review");
  await page.getByRole("alertdialog").press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.locator(".profile-step")).toHaveCount(5);
  await page.goto("/profiles/" + profile.id);
  await page
    .getByRole("button", { name: "Use this profile", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Controller", exact: true })
    .selectOption(device.id, { timeout: 10000 });
  await page
    .getByRole("button", { name: "Review & start", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Start time", exact: true })
    .selectOption("later");

  await capture("profile-start-review");
  await page
    .getByRole("button", { name: "Start profile", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect.poll(() => commandRequests.length).toBe(1);
  expect(commandRequests[0].profile).toBe(profile.id);
  expect(commandRequests[0].start_at).toBeGreaterThan(Date.now());
  await page.goto("/notes/" + note.id);
  await expect(page.getByText("Added Citra for dry hopping.")).toBeVisible();
  await capture("note-detail");
  await page.goto("/integrations/" + integration.id);
  await capture("integration-detail");
  await page.route("**/api/v1/resources/settings", (route) =>
    route.fulfill({
      json: [
        {
          id: "dark-preview",
          kind: "settings",
          name: "Settings",
          data: {
            theme: "dark",
            unit: "C",
            gravity_unit: "SG",
            timezone: "Europe/Stockholm",
            date_format: "YYYY-MM-DD",
          },
        },
      ],
    }),
  );
  for (const [name, path] of [
    ["overview-dark", "/"],
    ["profile-dark", "/profiles/" + profile.id],
    ["settings-dark", "/settings"],
  ]) {
    await page.goto(path);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await capture(name);
  }
  expect(errors).toEqual([]);
});
