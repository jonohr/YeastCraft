// SPDX-License-Identifier: GPL-3.0-only
import { test, expect } from "@playwright/test";

test("manual iSpindel references, source units, fitted preview, apply and restore", async ({
  page,
  request,
}, info) => {
  const credentials = {
    username: "browser-test",
    password: "browser-test-password-123",
  };
  if (!(await (await request.get("/api/v1/auth/status")).json()).configured)
    await request.post("/api/v1/auth/setup", { data: credentials });
  await page.goto("/");
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  const client = page.context().request;
  const response = await client.post("/api/v1/resources/sensors", {
    data: {
      name: "Calibration " + info.project.name,
      data: { sensor_type: "ispindel", unit: "C" },
    },
  });
  expect(response.ok()).toBe(true);
  const sensor = await response.json();
  const path = "/api/v1/sensors/" + sensor.id;
  const log = await (
    await client.post("/api/v1/resources/gravity_logs", {
      data: {
        name: "References " + info.project.name,
        data: { device: sensor.id, status: "active" },
      },
    })
  ).json();
  await page.goto("/sensors/" + sensor.id);
  await page
    .getByText("Advanced angle & reference options", { exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Use latest received angle" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Calibration & source", exact: true })
    .click();
  await page
    .getByText("Gravity source & advanced settings", { exact: true })
    .click();
  await page.getByLabel("Gravity source").selectOption("device");
  await expect(
    page.getByRole("button", { name: "Save gravity source", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Device gravity units").selectOption("SG");
  await page
    .getByRole("button", { name: "Save gravity source", exact: true })
    .click();
  await expect(
    page.getByText("Gravity source saved for future readings."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Start calibration", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Add calibration point", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Enter the angle manually").check();
  for (const [angle, sg] of [
    [20, 1.005],
    [40, 1.025],
    [60, 1.065],
  ]) {
    await page.getByLabel("Measured gravity SG").fill(String(sg));
    await page.getByLabel("iSpindel angle").fill(String(angle));
    await page
      .getByRole("button", { name: "Add calibration point", exact: true })
      .click();
    await expect(page.getByLabel("Measured gravity SG")).toHaveValue("");
  }
  await expect(
    page.getByRole("checkbox", { name: /Select reference/ }),
  ).toHaveCount(3);
  const before = await (
    await client.get("/api/v1/measurements/" + sensor.id)
  ).json();
  expect(before).toHaveLength(3);
  expect(before.every((p: any) => p.values.reading_source === "manual")).toBe(
    true,
  );
  expect(
    await (await client.get("/api/v1/measurements/" + log.id)).json(),
  ).toHaveLength(3);
  await page
    .getByRole("button", { name: "Check calibration curve", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Check your calibration curve",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByText("Formula & technical details", { exact: true }).click();
  await expect(page.getByLabel("Formula producing SG")).toContainText("tilt^2");
  await page
    .getByRole("button", { name: "Continue to activation", exact: true })
    .click();
  await expect(
    page.getByText("With this calibration", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Back to curve", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Continue to activation", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Use this calibration in Fermentrack",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Calibration is active in Fermentrack.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Gravity source")).toHaveValue("server");
  const after = await (
    await client.get("/api/v1/measurements/" + sensor.id)
  ).json();
  expect(after).toEqual(before);

  await page.getByText("Previous calibration", { exact: true }).click();
  await page
    .getByRole("button", {
      name: "Restore previous calibration",
      exact: true,
    })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(
    page.getByText("Previous calibration and gravity source restored."),
  ).toBeVisible();
  await expect(page.getByLabel("Gravity source")).toHaveValue("device");
  await page
    .getByRole("button", { name: "Manual reading", exact: true })
    .click();
  await page
    .getByText("Advanced angle & reference options", { exact: true })
    .click();
  await page.getByLabel("Measured gravity SG").fill("1.04");
  await page.getByLabel("iSpindel angle").fill("45");
  await page.waitForTimeout(800);
  await expect(page.getByLabel("Measured gravity SG")).toHaveValue("1.04");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: `../state/${info.project.name}-calibration.png`,
    fullPage: true,
  });
  // A sensor's reference endpoints reject stale previews and foreign IDs, even without hardware enabled.
  const preview = await (
    await client.post(path + "/calibration/preview", { data: { degree: 2 } })
  ).json();
  expect(
    (
      await client.post(path + "/calibration/apply", {
        data: {
          degree: 2,
          expected_revision: preview.revision,
          confirm_apply: false,
        },
      })
    ).ok(),
  ).toBe(false);
  await client.post(path + "/source", {
    data: { gravity_source: "server", reported_gravity_unit: "SG" },
  });
  expect(
    (
      await client.post(path + "/calibration/apply", {
        data: {
          degree: 2,
          expected_revision: preview.revision,
          confirm_apply: true,
        },
      })
    ).status(),
  ).toBe(409);
});

test("guided calibration uses fresh packets automatically and blocks stale angles", async ({
  page,
}) => {
  const received = Date.now();
  const writes: any[] = [];
  const sensor = {
    id: "packet-test",
    kind: "sensors",
    name: "Packet fixture",
    data: {
      sensor_type: "ispindel",
      unit: "C",
      last_automatic: {
        time: received,
        values: { angle: 45, gravity_temp: 20, gravity: 1.04 },
      },
    },
  };
  await page.clock.install({ time: received });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: any = [];
    if (path.endsWith("/auth/status"))
      body = { configured: true, authenticated: true, internal_auth: false };
    else if (path.endsWith("/resources/sensors/packet-test")) body = sensor;
    else if (path.endsWith("/resources/sensors")) body = [sensor];
    else if (path.endsWith("/calibration/points"))
      body = { points: [], active_id: null };
    else if (path.endsWith("/measurement")) {
      writes.push(route.request().postDataJSON());
      body = { status: "ok" };
    }
    await route.fulfill({ json: body });
  });
  await page.goto("/sensors/packet-test/calibration");
  await page
    .getByRole("button", { name: "Start calibration", exact: true })
    .click();
  await expect(
    page.getByText("Latest received angle", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Measured gravity SG").fill("1.040");
  await page
    .getByRole("button", { name: "Add calibration point", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    gravity: 1.04,
    angle: 45,
    angle_received_at: received,
    calibration_reference: true,
  });
  await page.clock.fastForward(301000);
  await expect(
    page.getByRole("button", { name: "Add calibration point", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Waiting for a fresh angle", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Enter the angle manually").check();
  await page.getByLabel("Measured gravity SG").fill("1.030");
  await page.getByLabel("iSpindel angle").fill("40");
  await page
    .getByRole("button", { name: "Add calibration point", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({
    gravity: 1.03,
    angle: 40,
    angle_received_at: null,
    calibration_reference: true,
  });
});
