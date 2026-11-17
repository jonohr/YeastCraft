import { test, expect } from "@playwright/test";
import { stateBand, stateIntervals } from "../src/controller";

test("drift band renders red blue and green below the temperature plot", async ({
  page,
}, testInfo) => {
  const now = Date.now();
  const device = {
    id: "band",
    kind: "devices",
    name: "Driftband",
    data: {
      unit: "C",
      collection_enabled: true,
      last_seen: now,
      last_values: { beer_set: null, fridge_set: 7, state: 4 },
    },
  };
  await page.route("**/api/v1/**", async (route) => {
    expect(route.request().method()).toBe("GET");
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    let body: unknown = [];
    if (path.endsWith("/auth/status"))
      body = { configured: true, authenticated: true, internal_auth: false };
    else if (path.endsWith("/resources/devices/band")) body = device;
    else if (path.endsWith("/resources/devices")) body = [device];
    else if (path.endsWith("/diagnostics")) body = { control_enabled: false };
    else if (path.includes("/measurements/"))
      body = [3, 3, 0, 0, 4, 4, 0, 0].map((state, i) => ({
        time: now - (7 - i) * 30000,
        values: {
          state,
          beer_temp: 6 + i * 0.1,
          fridge_temp: 6.5,
          fridge_set: 7,
          temp_format: "C",
        },
      }));
    await route.fulfill({ json: body });
  });
  await page.goto("/devices/band");
  await expect(page.locator("canvas")).toBeVisible();
  await expect
    .poll(async () =>
      page.locator("canvas").evaluate((canvas) => {
        const c = canvas as HTMLCanvasElement;
        const pixels = c
          .getContext("2d")!
          .getImageData(0, 0, c.width, c.height).data;
        const counts = { red: 0, blue: 0, green: 0 };
        for (let i = 0; i < pixels.length; i += 4) {
          const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
          if (r === 214 && g === 75 && b === 67) counts.red++;
          if (r === 56 && g === 127 && b === 195) counts.blue++;
          if (r === 66 && g === 148 && b === 100) counts.green++;
        }
        return Object.values(counts).every((n) => n > 50);
      }),
    )
    .toBe(true);
  await expect(page.getByLabel("Operating state colours")).toBeVisible();
  const layout = await page.locator(".chart-card").evaluate((card) => {
    const chart = card.querySelector(".chart")!.getBoundingClientRect();
    const legend = card.querySelector(".plot-legend")!.getBoundingClientRect();
    const labels = [...card.querySelectorAll(".plot-legend button")].map((e) =>
      e.getBoundingClientRect(),
    );
    return {
      belowPlot: legend.top >= chart.bottom + 6,
      overlap: labels.some((a, i) =>
        labels.some(
          (b, j) =>
            i !== j &&
            a.left < b.right &&
            a.right > b.left &&
            a.top < b.bottom &&
            a.bottom > b.top,
        ),
      ),
    };
  });
  expect(layout).toEqual({ belowPlot: true, overlap: false });
  await page
    .locator(".chart-card")
    .screenshot({ path: `../state/${testInfo.project.name}-drift-band.png` });
});

test("operating band uses active outputs and leaves measurement gaps empty", () => {
  for (const state of [3, 9])
    expect(stateBand(state)).toEqual({ label: "Heating", color: "#d64b43" });
  for (const state of [4, 8])
    expect(stateBand(state)).toEqual({ label: "Cooling", color: "#387fc3" });
  for (const state of [0, 5, 6, 7])
    expect(stateBand(state)).toEqual({ label: "Idle", color: "#429464" });
  for (const state of [1, 2, null, 42])
    expect(stateBand(state).color).toBe("#a8aea8");
  expect(
    stateIntervals([
      { time: 0, values: { state: 3 } },
      { time: 30000, values: { state: 4 } },
      { time: 60000, values: { state: 0 } },
      { time: 240000, values: {} },
    ]),
  ).toEqual([
    [0, 30000, 3],
    [30000, 60000, 4],
    [60000, 150000, 0],
    [240000, 270000, -1],
  ]);
});

test("pin inventory, explicit edits, conflict handling and running-mode guard", async ({
  page,
}, testInfo) => {
  let running = false,
    reads = 0,
    writes = 0;
  let inventory = {
    revision: "r1",
    version: { v: "0.2.4", b: "e" },
    installed: [
      { i: 0, h: 1, p: 5, f: 2, x: 1 },
      { i: 1, h: 2, p: 12, a: "28FF000000000001", f: 5, j: "-0.250", v: "6.2" },
    ],
    available: [{ i: -1, h: 1, p: 14, f: 0, x: 1 }],
  };
  await page.route("**/api/v1/**", async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === "/api/v1/devices/pins/pins") {
      if (route.request().method() === "GET") {
        reads++;
        return route.fulfill({ json: inventory });
      }
      expect(route.request().method()).toBe("PUT");
      writes++;
      const body = route.request().postDataJSON();
      expect(body.confirm_ownership).toBe(true);
      expect(body.hardware).toBe(1);
      expect(body.pin).toBe(5);
      expect(body.function).toBe(3);
      if (writes === 1)
        return route.fulfill({
          status: 409,
          json: {
            error:
              "Configuration changed. Refresh the inventory before saving.",
          },
        });
      expect(body.expected_revision).toBe("r2");
      expect(body.inverted).toBe(false);
      inventory = {
        ...inventory,
        revision: "r3",
        installed: inventory.installed.map((r) =>
          r.i === 0 ? { ...r, f: 3, x: 0 } : r,
        ),
      };
      return route.fulfill({
        json: { confirmed: true, configuration: inventory },
      });
    }
    expect(route.request().method()).toBe("GET");
    const device = {
      id: "pins",
      kind: "devices",
      name: "Pin controller",
      data: {
        unit: "C",
        collection_enabled: true,
        control_claimed: true,
        last_seen: Date.now(),
        last_values: {
          beer_set: null,
          fridge_set: running ? 7 : null,
          state: running ? 4 : 1,
        },
      },
    };
    let body: unknown = [];
    if (path.endsWith("/auth/status"))
      body = { configured: true, authenticated: true, internal_auth: false };
    else if (path.endsWith("/resources/devices/pins")) body = device;
    else if (path.endsWith("/resources/devices")) body = [device];
    else if (path.endsWith("/diagnostics")) body = { control_enabled: true };
    await route.fulfill({ json: body });
  });
  await page.goto("/devices/pins");
  await page
    .getByRole("link", { name: "Temperature probes & outputs", exact: true })
    .click();
  await expect(page.locator("#pin-config")).toBeInViewport();
  await expect(
    page.getByRole("heading", {
      name: "Temperature probes & outputs",
      level: 1,
    }),
  ).toBeVisible();
  await expect.poll(() => reads).toBe(1);
  await expect(
    page.getByRole("heading", { name: "Cooling relay", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Pin or sensor for Chamber sensor")).toHaveValue(
    "2:12:28FF000000000001:",
  );
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  const colors = await page
    .locator(".pin-row")
    .first()
    .evaluate((el) => ({
      background: getComputedStyle(el).backgroundColor,
      text: getComputedStyle(el).color,
    }));
  expect(colors.background).toBe("rgb(36, 41, 39)");
  expect(colors.text).toBe("rgb(240, 241, 236)");
  await page.screenshot({
    path: "../state/pins-dark-" + test.info().project.name + ".png",
    fullPage: true,
  });
  await page
    .getByLabel("Pin or sensor for Cooling relay")
    .selectOption("1:5::");
  await page.getByLabel("I have checked the assignment").check();

  await page
    .getByRole("button", { name: "Save and verify", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Configuration changed");
  await expect(page.getByLabel("Pin function")).toHaveValue("Cooling relay");
  inventory = { ...inventory, revision: "r2" };
  await page.getByRole("button", { name: "Refresh inventory" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page
    .getByLabel("Pin or sensor for Cooling relay")
    .selectOption("1:5::");
  await page.getByLabel("Inverted output / input").uncheck();
  await page.getByLabel("I have checked the assignment").check();

  await page
    .getByRole("button", { name: "Save and verify", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(
    page.getByText("Controller readback confirmed the assignment."),
  ).toBeVisible();
  await expect(page.getByLabel("Pin or sensor for Cooling relay")).toHaveValue(
    "1:5::",
  );
  await page
    .getByLabel("Pin or sensor for Chamber sensor")
    .selectOption("2:12:28FF000000000001:");
  await expect(page.getByLabel("Pin calibration")).toHaveValue("-0.25");
  await expect(page.getByLabel("Pin function")).toHaveValue("Chamber sensor");
  running = true;
  await page.reload();
  await expect(page.locator("#pin-config")).toBeInViewport();
  await page.getByRole("button", { name: "Refresh inventory" }).click();
  await page
    .getByLabel("Pin or sensor for Cooling relay")
    .selectOption("1:5::");
  await page.getByLabel("I have checked the assignment").check();
  await expect(
    page.getByRole("button", { name: "Save and verify", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Turn temperature control off and stop any running profile"),
  ).toBeVisible();
  expect(writes).toBe(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: `../state/${testInfo.project.name}-pin-config.png`,
    fullPage: true,
  });
});
