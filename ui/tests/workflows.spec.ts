import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
test("active target follows fridge/beer mode and preserves zero", async ({
  page,
}, testInfo) => {
  const devices = [
    { id: "target-fridge", name: "Target fridge", beer: null, fridge: 7 },
    { id: "target-beer", name: "Target beer", beer: 18, fridge: 4 },
    { id: "target-zero", name: "Target zero", beer: null, fridge: 0 },
    { id: "target-missing", name: "Target missing", beer: null, fridge: null },
  ].map((d) => ({
    id: d.id,
    kind: "devices",
    name: d.name,
    data: {
      unit: "C",
      collection_enabled: true,
      control_claimed: true,
      last_seen: Date.now(),
      last_values: {
        beer_temp: 6,
        fridge_temp: 6.5,
        beer_set: d.beer,
        fridge_set: d.fridge,
        temp_format: "C",
      },
    },
  }));
  let displayUnit = "C";
  await page.route("**/api/v1/**", async (route) => {
    expect(route.request().method()).toBe("GET");
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    let body: unknown = [];
    if (path.endsWith("/auth/status"))
      body = { configured: true, authenticated: true, internal_auth: false };
    else if (path.endsWith("/overview"))
      body = {
        counts: { devices: 4, batches: 0, sensors: 0 },
        measurements: 2,
      };
    else if (path.endsWith("/resources/devices")) body = devices;
    else if (path.includes("/resources/devices/"))
      body = devices.find((d) => path.endsWith("/" + d.id));
    else if (path.endsWith("/diagnostics")) body = { control_enabled: true };
    else if (path.endsWith("/resources/settings"))
      body = [{ data: { unit: displayUnit } }];
    else if (path.includes("/measurements/"))
      body = [0, 1].map((i) => ({
        time: Date.now() - (1 - i) * 30000,
        values: {
          beer_temp: 6,
          fridge_temp: 6.5,
          beer_set: null,
          fridge_set: 7,
          temp_format: "C",
        },
      }));
    await route.fulfill({ json: body });
  });
  await page.goto("/");
  const card = (name: string) =>
    page.locator(".device-card").filter({ hasText: name });
  const target = (name: string) =>
    card(name).getByLabel("Current target temperature");
  await expect(target("Target fridge")).toContainText("7.0");
  await expect(target("Target fridge")).toContainText("CHAMBER");
  await expect(target("Target beer")).toContainText("18.0");
  await expect(target("Target beer")).toContainText("BEER");
  await expect(target("Target zero")).toContainText("0.0");
  await expect(target("Target missing")).toContainText("—");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: `../state/${testInfo.project.name}-target-overview.png`,
    fullPage: true,
  });
  await card("Target fridge").click();
  await expect(page).toHaveURL(/\/devices\/target-fridge$/);
  await expect(
    page.getByRole("heading", { name: "Temperature control" }),
  ).toBeVisible();
  await expect(page.getByLabel("Current target temperature")).toContainText(
    "7.0",
  );
  await page
    .getByRole("button", { name: "Change target", exact: true })
    .click();
  await expect(
    page.getByLabel("Target temperature °C", { exact: true }),
  ).toHaveValue("7");
  await expect(page.locator("canvas")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: `../state/${testInfo.project.name}-target-detail.png`,
    fullPage: true,
  });
  await page.goto("/devices/target-zero");
  await page
    .getByRole("button", { name: "Change target", exact: true })
    .click();
  await expect(page.getByLabel("Control mode")).toHaveValue("f");
  await expect(
    page.getByLabel("Target temperature °C", { exact: true }),
  ).toHaveValue("0");
  await page.goto("/devices/target-beer");
  await page
    .getByRole("button", { name: "Change target", exact: true })
    .click();
  await expect(page.getByLabel("Control mode")).toHaveValue("b");
  await expect(
    page.getByLabel("Target temperature °C", { exact: true }),
  ).toHaveValue("18");
  displayUnit = "F";
  await page.goto("/");
  await expect(target("Target fridge")).toContainText("44.6");
  await expect(target("Target fridge")).toContainText("°F");
});

test("setup/login, CRUD, notes, backup and responsive navigation", async ({
  page,
  request,
}, testInfo) => {
  const credentials = {
    username: "browser-test",
    password: "browser-test-password-123",
  };
  const st = await (await request.get("/api/v1/auth/status")).json();
  if (!st.configured)
    await request.post("/api/v1/auth/setup", { data: credentials });
  await page.goto("/");
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await page.goto("/batches");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Browser " + testInfo.project.name);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save draft", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: "Browser " + testInfo.project.name,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .locator(".batch-quick-actions")
    .getByRole("button", { name: "Add note", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Test note");
  await page
    .getByRole("dialog")
    .getByLabel("Note", { exact: true })
    .fill("Saved through browser");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByText("Saved through browser")).toBeVisible();
  await page.goto("/profiles");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page
    .locator(".profile-page-editor")
    .getByLabel("Name", { exact: true })
    .fill("Profile " + testInfo.project.name);
  await page.getByLabel("Days", { exact: true }).fill("2");
  await page.getByLabel("Control temperature").selectOption("chamber");
  await page
    .getByLabel("Turn temperature control off", { exact: false })
    .check();
  const before = await page
    .getByRole("img", { name: "Temperature schedule preview" })
    .locator("polyline")
    .getAttribute("points");
  await page.getByLabel("Target temperature °C").fill("19");
  await expect(
    page
      .getByRole("img", { name: "Temperature schedule preview" })
      .locator("polyline"),
  ).not.toHaveAttribute("points", before!);
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(page.locator(".profile-step")).toHaveCount(2);
  await page.getByLabel("Move step up", { exact: true }).click();

  await page.getByLabel("Remove step", { exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(page.locator(".profile-step")).toHaveCount(1);
  const bounds = await page.locator(".profile-builder").boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page
    .locator(".profile-page-editor")
    .getByRole("button", { name: "Save profile", exact: true })
    .click();
  await page
    .getByRole("link", {
      name: "Profile " + testInfo.project.name,
      exact: true,
    })
    .click();
  await expect(page.locator(".schedule-summary")).toContainText("2 days");
  const stored = (
    await (await page.request.get("/api/v1/resources/profiles")).json()
  ).find((p: any) => p.name === "Profile " + testInfo.project.name);
  expect(stored.data.steps[0].hours).toBe(48);
  expect(stored.data.control_sensor).toBe("chamber");
  expect(stored.data.end_behavior).toBe("off");
  await page.goto("/backup");
  await expect(
    page.getByRole("link", { name: "Download backup" }),
  ).toBeVisible();
  await page.goto("/devices");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page
    .getByRole("button", { name: "BrewPi controller", exact: false })
    .click();
  await expect(
    page.getByText("Collection is disabled on this server.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect equipment", exact: true }),
  ).toBeDisabled();
  await page.getByRole("dialog").press("Escape");
  const d = await (
    await page.request.post("/api/v1/resources/devices", {
      data: {
        name: "Device " + testInfo.project.name,
        data: { unit: "C", collection_enabled: false },
      },
    })
  ).json();
  await page.goto("/devices/" + d.id);
  await page
    .getByRole("button", { name: "Change target", exact: true })
    .click();
  await expect(
    page.getByText("Temperature control is disabled on this server."),
  ).toBeVisible();
  await page.goto("/");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: "../state/" + testInfo.project.name + "-overview.png",
    fullPage: true,
  });
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
});

test("legacy import, chart, SQLite backup preview and restore", async ({
  page,
  request,
}, testInfo) => {
  const credentials = {
    username: "browser-test",
    password: "browser-test-password-123",
  };
  const st = await (await request.get("/api/v1/auth/status")).json();
  if (!st.configured)
    await request.post("/api/v1/auth/setup", { data: credentials });
  await page.goto("/");
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await page.goto("/import");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByText("289", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Import reviewed data" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(
    page.getByText(/Import complete|Source already imported/),
  ).toBeVisible();
  await page.goto("/batches");
  await page.getByRole("link", { name: "Demo pale ale", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "Temperature and gravity over time" }),
  ).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
  await page.screenshot({
    path: "../state/" + testInfo.project.name + "-chart.png",
    fullPage: true,
  });
  await page.goto("/backup");
  const downloading = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download backup" }).click();
  const download = await downloading;
  const path = await download.path();
  expect(path).toBeTruthy();
  await page.getByLabel("Backup file").setInputFiles(path!);
  const backupSummary = await (
    await page.request.post("/api/v1/restore.sqlite?confirm=false", {
      headers: { "Content-Type": "application/vnd.sqlite3" },
      data: readFileSync(path!),
    })
  ).json();
  await page.getByRole("button", { name: "Analyze backup" }).click();
  expect(backupSummary.sample_names).toContain("Demo pale ale");
  expect(typeof backupSummary.first_measurement).toBe("number");
  expect(backupSummary.last_measurement).toBeGreaterThanOrEqual(
    backupSummary.first_measurement,
  );
  await expect(
    page.getByRole("button", { name: "Confirm restore" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Confirm restore" }).click();
  await page.getByLabel("Type RESTORE to continue").fill("RESTORE");
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(page.getByText(/Restore complete/)).toBeVisible();
});

test("external authentication skips local login and password management", async ({
  page,
  request,
}) => {
  const { spawn } = await import("node:child_process");
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const { randomUUID } = await import("node:crypto");
  const { once } = await import("node:events");
  const suffix = randomUUID(),
    db = `../state/proxy-${suffix}.sqlite`,
    file = `../state/proxy-${suffix}.proof`,
    proof = "e".repeat(64);
  writeFileSync(file, proof, { mode: 0o600 });
  const child = spawn(
    "../rust/target/debug/yeastcraft",
    [
      "--db",
      db,
      "--listen",
      "127.0.0.1:8317",
      "--static",
      "dist",
      "--disable-internal-auth",
      "--proxy-proof-file",
      file,
    ],
    { stdio: "ignore" },
  );
  try {
    await expect
      .poll(async () => {
        try {
          return (await request.get("http://127.0.0.1:8317/healthz")).status();
        } catch {
          return 0;
        }
      })
      .toBe(200);
    await page.goto("http://127.0.0.1:8317/");
    await expect(page.getByRole("alert")).toContainText("protected proxy");
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    await page.setExtraHTTPHeaders({ "X-Fermentrack-Proxy-Proof": proof });
    await page.goto("http://127.0.0.1:8317/");
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await page.goto("http://127.0.0.1:8317/settings");
    await expect(
      page.getByText("Sign-in is managed by your identity provider."),
    ).toBeVisible();
    await expect(page.getByLabel("Current password")).toHaveCount(0);
    await page.route("**/outpost.goauthentik.io/sign_out", (route) =>
      route.fulfill({
        body: "Logged out via proxy",
        contentType: "text/plain",
      }),
    );
    if (await page.getByRole("button", { name: "Open navigation" }).isVisible())
      await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByText("Logged out via proxy")).toBeVisible();
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    for (const p of [file, db, db + "-wal", db + "-shm"]) {
      try {
        unlinkSync(p);
      } catch {}
    }
  }
});
