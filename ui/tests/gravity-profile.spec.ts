// SPDX-License-Identifier: GPL-3.0-only
import { test, expect } from "@playwright/test";
test("gravity conditions can be built, reviewed and reopened without invented completion times", async ({
  page,
}, info) => {
  let profile: any;
  const sensor = {
    id: "synthetic-sg",
    kind: "sensors",
    name: "Synthetic iSpindel",
    data: { sensor_type: "ispindel" },
  };
  await page.route("**/api/v1/**", async (r) => {
    const p = new URL(r.request().url()).pathname,
      m = r.request().method();
    let body: any = [];
    if (p.endsWith("/auth/status"))
      body = { configured: true, authenticated: true, internal_auth: false };
    else if (p.endsWith("/resources/sensors")) body = [sensor];
    else if (p.endsWith("/resources/profiles") && m === "POST") {
      profile = {
        id: "sg-profile",
        kind: "profiles",
        ...r.request().postDataJSON(),
      };
      body = profile;
    } else if (p.endsWith("/resources/profiles"))
      body = profile ? [profile] : [];
    else if (p.endsWith("/resources/profiles/sg-profile")) body = profile;
    else if (m !== "GET") throw Error("Unexpected write " + p);
    await r.fulfill({ json: body });
  });
  await page.goto("/profiles");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Gravity fermentation");
  await page.getByLabel("Step ends").selectOption("sg");
  await expect(page.getByLabel("Step ends").locator("..")).toContainText(
    "Finish this step",
  );
  await page.getByLabel("Profile reading source").selectOption("ispindel");
  await page.getByLabel("Profile gravity sensor").selectOption(sensor.id);
  await page.getByLabel("SG at or below").fill("1.020");
  await expect(
    page.getByRole("button", { name: "Ramp", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(/At least 3 readings over 10 minutes/),
  ).toBeHidden();
  await expect(
    page.locator(".step-fields").getByLabel("Profile gravity sensor"),
  ).toBeVisible();
  const temperature = await page.getByLabel("Target temperature").boundingBox();
  const condition = await page.getByLabel("Step ends").boundingBox();
  expect(temperature!.y).toBeLessThan(condition!.y);
  await expect(
    page.locator("label").filter({ has: page.getByLabel("Step ends") }),
  ).toBeVisible();
  await page.getByText("Advanced", { exact: true }).click();
  await expect(
    page.getByText(/At least 3 readings over 10 minutes/),
  ).toBeVisible();
  await page.getByText("Advanced", { exact: true }).click();
  await expect(page.getByLabel("Days", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page.getByRole("button", { name: "Hold temperature" }).click();
  await page.getByLabel("Target temperature").fill("21");
  await page.getByLabel("Step ends").selectOption("stable");
  await page.getByLabel("Stable for (hours)").fill("48");
  await expect(page.getByLabel("Profile gravity sensor")).toHaveValue(
    sensor.id,
  );
  await expect(page.getByLabel("Maximum SG range")).toBeHidden();
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByLabel("Maximum SG range").fill("0.002");
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByLabel("Profile reading source").selectOption("manual");
  await expect(page.getByLabel("Profile gravity sensor")).toHaveValue(
    sensor.id,
  );
  await page.getByLabel("Profile reading source").selectOption("ispindel");
  await expect(
    page.getByText("Then finish the profile and keep holding 21 °C."),
  ).toBeVisible();
  await page.getByRole("button", { name: /Primary fermentation/ }).click();
  await expect(page.getByLabel("Step ends").locator("..")).toContainText(
    "Move to next step",
  );
  await expect(
    page.locator("label").filter({ has: page.getByLabel("Step ends") }),
  ).toBeVisible();
  await expect(page.getByText("Then hold at 21 °C in step 2.")).toBeVisible();
  await page.getByRole("button", { name: /Hold temperature/ }).click();
  await expect(page.getByLabel("Maximum SG range")).toHaveValue("0.002");
  await expect(page.getByText(/Timing depends on gravity/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: `../state/gravity-profile-${info.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect.poll(() => profile?.data.steps.length).toBe(2);
  expect(profile.data.steps[0].until).toEqual({ kind: "sg", sg: 1.02 });
  expect(profile.data.steps[1].until).toEqual({
    kind: "stable",
    hours: 48,
    tolerance: 0.002,
  });
  expect(profile.data.gravity_readings).toBe("ispindel");
  await page.goto("/profiles/sg-profile");
  await expect(
    page.getByText("Until SG ≤ 1.020", { exact: false }).first(),
  ).toBeVisible();
});

test("running gravity profile shows persisted progress rather than elapsed-time completion", async ({
  page,
}) => {
  const plan = {
    unit: "C",
    gravity_readings: "manual",
    gravity_sensor: "s",
    steps: [
      {
        name: "Wait for gravity",
        temperature: 18,
        hours: 1,
        transition: "hold",
        until: { kind: "sg", sg: 1.02 },
      },
      { name: "Rest", temperature: 21, hours: 24, transition: "hold" },
    ],
  };
  const device = {
    id: "d",
    kind: "devices",
    name: "Synthetic chamber",
    data: {
      unit: "C",
      collection_enabled: true,
      control_claimed: true,
      profile: "p",
      profile_started: Date.now() - 10 * 86400000,
      last_seen: Date.now(),
      last_values: { fridge_temp: 18, fridge_set: 18, state: 0 },
      profile_run: {
        profile: plan,
        step: 0,
        entered: Date.now() - 10 * 86400000,
        applied: true,
        status: "Waiting for gravity readings to confirm the condition",
      },
    },
  };
  await page.route("**/api/v1/**", async (r) => {
    const p = new URL(r.request().url()).pathname;
    let body: any = [];
    if (p.endsWith("/auth/status"))
      body = { configured: true, authenticated: true, internal_auth: false };
    else if (p.endsWith("/diagnostics"))
      body = { collection_enabled: true, control_enabled: true };
    else if (p.endsWith("/resources/devices/d")) body = device;
    else if (p.endsWith("/resources/devices")) body = [device];
    else if (p.endsWith("/resources/profiles"))
      body = [{ id: "p", kind: "profiles", name: "SG run", data: plan }];
    if (r.request().method() !== "GET") throw Error("Unexpected write");
    await r.fulfill({ json: body });
  });
  await page.goto("/devices/d");
  await expect(
    page.getByText("Waiting for gravity readings to confirm the condition", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.locator(".schedule-summary").getByText("Current", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".schedule-summary").getByText("Complete", { exact: true }),
  ).toHaveCount(0);
});
