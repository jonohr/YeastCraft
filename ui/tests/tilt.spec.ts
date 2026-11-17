// SPDX-License-Identifier: GPL-3.0-only
import { test, expect } from "@playwright/test";
for (const type of ["tilt", "tiltbridge"]) {
  test(`${type} experimental setup, receipt and connection tools`, async ({
    page,
  }) => {
    let sensor: any = null,
      received = false,
      created = 0;
    await page.route("**/api/v1/**", async (route) => {
      const p = new URL(route.request().url()).pathname,
        method = route.request().method();
      let data: any = [];
      const current = () =>
        sensor && {
          ...sensor,
          data: {
            ...sensor.data,
            ingest_hash: "synthetic-hash",
            ...(received
              ? {
                  last_seen: Date.now(),
                  last_values: {
                    gravity: 1.0123,
                    gravity_temp: 20,
                    temp_format: "C",
                    reading_source: type,
                  },
                }
              : {}),
          },
        };
      if (p.endsWith("auth/status"))
        data = { configured: true, authenticated: true, internal_auth: false };
      else if (p.endsWith("diagnostics")) data = { collection_enabled: true };
      else if (p.endsWith("resources/sensors") && method === "POST") {
        created++;
        sensor = {
          id: "tilt-test",
          kind: "sensors",
          ...route.request().postDataJSON(),
        };
        data = sensor;
      } else if (p.endsWith("resources/sensors"))
        data = sensor ? [current()] : [];
      else if (p.endsWith("resources/sensors/tilt-test")) data = current();
      else if (p.endsWith("sensors/tilt-test/key"))
        data = {
          token: "synthetic-receiver",
          path: `/ingest/${type}/synthetic-receiver`,
        };
      else if (p.includes("/measurements/"))
        data = [
          {
            source: "tilt-test",
            time: Date.now(),
            values: {
              gravity: 1.0123,
              gravity_temp: 20,
              temp_format: "C",
              reading_source: type,
            },
          },
        ];
      else if (method !== "GET") throw Error(`Unexpected write ${p}`);
      await route.fulfill({ json: data });
    });
    await page.goto("/sensors");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Test Tilt");
    await page
      .getByRole("combobox", { name: "Sensor type", exact: true })
      .selectOption(type);
    await expect(
      page.getByText(/Experimental — protocol tested/),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Connect equipment", exact: true })
      .click();
    await expect(page.getByRole("alert")).toHaveText("Choose a Tilt color.");
    await page
      .getByRole("combobox", { name: "Tilt color", exact: true })
      .selectOption("PINK");
    if (type === "tilt") {
      await page
        .getByLabel("Tilt MAC address (optional)")
        .fill("aa:bb:cc:dd:ee:ff");
      await page.getByLabel("Sender UTC offset (minutes)").fill("60");
    } else {
      await page.getByLabel("TiltBridge mDNS ID").fill("test-bridge");
    }
    await page.screenshot({
      path: `../state/${type}-setup-${test.info().project.name}.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Connect equipment", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Waiting for the first reading" }),
    ).toBeVisible();
    expect(created).toBe(1);
    expect(sensor.data.tilt_color).toBe("PINK");
    expect(sensor.data.sensor_type).toBe(type);
    await expect(page.getByLabel("Receiving URL", { exact: true })).toHaveValue(
      `http://127.0.0.1:8316/ingest/${type}/synthetic-receiver`,
    );
    received = true;
    await expect(
      page.getByRole("heading", { name: "First reading received" }),
    ).toBeVisible({ timeout: 7000 });
    await expect(
      page.getByRole("link", { name: "Calibrate sensor", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("link", { name: "Open gravity sensor" }).click();
    await expect(
      page.getByText(/Experimental — protocol tested/).first(),
    ).toBeVisible();
    await expect(page.locator("canvas").first()).toBeVisible();
    await expect(
      page.getByText("Reported by Tilt sender", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Tilt angle", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText("Server calibration", { exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".measurement-card").first()).toContainText(
      "1.0123",
    );
    await expect(page.getByLabel("Operating state colours")).toHaveCount(0);
    await page.getByRole("button", { name: "Connection", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Generate receiving URL" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Calibration & source", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: `../state/${type}-connection-${test.info().project.name}.png`,
      fullPage: true,
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflow).toBe(false);
  });
}
