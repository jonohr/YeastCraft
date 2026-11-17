import { test, expect } from "@playwright/test";

test("30-second updates preserve chart and drafts and report controller state", async ({
  page,
}, testInfo) => {
  await page.clock.install();
  let state: number | null = 3,
    count = 2,
    fail = false;
  let measurements = 0,
    overviewReads = 0;
  await page.route("**/api/v1/**", async (route) => {
    expect(route.request().method()).toBe("GET");
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const now = await page.evaluate(() => Date.now());
    const device = {
      id: "live-controller",
      kind: "devices",
      name: "Live controller",
      data: {
        unit: "C",
        host: "controller.test",
        collection_enabled: true,
        control_claimed: true,
        last_seen: now,
        last_values: {
          beer_temp: 6,
          fridge_temp: 6.5,
          beer_set: null,
          fridge_set: 7,
          temp_format: "C",
          state,
        },
      },
    };
    let body: unknown = [];
    if (path.endsWith("/auth/status"))
      body = { configured: true, authenticated: true, internal_auth: false };
    else if (path.endsWith("/overview")) {
      overviewReads++;
      body = {
        counts: { devices: 1, batches: 0, sensors: 0 },
        measurements: count,
      };
    } else if (path.endsWith("/resources/devices")) body = [device];
    else if (path.endsWith("/resources/devices/live-controller")) body = device;
    else if (path.endsWith("/diagnostics")) body = { control_enabled: true };
    else if (path.includes("/measurements/")) {
      measurements++;
      if (fail)
        return route.fulfill({
          status: 503,
          json: { error: "Test av nätverksfel" },
        });
      body = Array.from({ length: count }, (_, i) => ({
        time: now - (count - i) * 30000,
        values: device.data.last_values,
      }));
    }
    await route.fulfill({ json: body });
  });
  await page.goto("/devices/live-controller");
  const status = page.getByLabel("Operating state", { exact: true }).last();
  await expect(status).toHaveText("Heating");
  await expect(page.locator("canvas")).toBeVisible();
  await page
    .locator("canvas")
    .evaluate((el) => el.setAttribute("data-live-marker", "retained"));
  const beerLegend = page.getByLabel("Chart series").getByRole("button",{name:"Beer",exact:true});
  await beerLegend.click();
  await expect(beerLegend).toHaveAttribute("aria-pressed","false");
  await page.getByLabel("Time period").selectOption("1");
  await page
    .getByRole("button", { name: "Change target", exact: true })
    .click();
  await page.getByLabel("Target temperature °C", { exact: true }).fill("9");
  await expect(page.getByText(/^2 displayed points\./)).toBeVisible();
  state = 4;
  count = 3;
  await page.clock.fastForward(30000);
  await expect(status).toHaveText("Cooling");
  await expect(beerLegend).toHaveAttribute("aria-pressed","false");
  await expect(page.getByText(/^3 displayed points\./)).toBeVisible();
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-live-marker",
    "retained",
  );
  await expect(
    page.getByLabel("Target temperature °C", { exact: true }),
  ).toHaveValue("9");
  await expect(page.getByLabel("Time period")).toHaveValue("1");

  fail = true;
  await page.clock.fastForward(30000);
  await expect(page.getByRole("alert")).toContainText("Test av nätverksfel");
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-live-marker",
    "retained",
  );
  await page.clock.fastForward(120000);
  await expect(status).toHaveText("Operating state unavailable");
  fail = false;
  state = 5;
  count = 4;
  await page.clock.fastForward(30000);
  await expect(status).toHaveText("Waiting to cool");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText(/^4 displayed points\./)).toBeVisible();
  await expect(
    page.getByLabel("Target temperature °C", { exact: true }),
  ).toHaveValue("9");

  for (const [code, label] of [
    [0, "Idle"],
    [1, "Off"],
    [2, "Door open"],
    [6, "Waiting to heat"],
    [7, "Waiting for peak detection"],
    [8, "Cooling · minimum run time"],
    [9, "Heating · minimum run time"],
    [42, "Unknown operating state"],
    [null, "Unknown operating state"],
  ] as const) {
    state = code;
    await page.clock.fastForward(30000);
    await expect(status).toHaveText(label);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: `../state/${testInfo.project.name}-live-updates.png`,
    fullPage: true,
  });
  const detailReads = measurements;
  state = 4;
  await page.getByRole("dialog").press("Escape");
  await page.goto("/");
  await expect(status).toHaveText("Cooling");
  const before = overviewReads;
  state = 3;
  await page.clock.fastForward(30000);
  await expect(status).toHaveText("Heating");
  expect(overviewReads).toBe(before + 1);
  expect(measurements).toBe(detailReads + 2);
});
