// SPDX-License-Identifier: GPL-3.0-only
import { test, expect } from "@playwright/test";
import { newestBrewfatherFirst } from "../src/brewfather-picker";
test("Brewfather missing dates sort after real dates", () => {
  const rows = [
    { id: "missing", number: 99 },
    { id: "old", number: 2, brew_date: 100 },
    { id: "new", number: 3, brew_date: 200 },
    { id: "invalid", number: 1, brew_date: NaN },
  ];
  expect(newestBrewfatherFirst(rows as any).map((b) => b.id)).toEqual([
    "new",
    "old",
    "missing",
    "invalid",
  ]);
});
for (const source of ["brewfather", "yc"])
  test(`${source}: draft restoration and start retry`, async ({ page }) => {
    let batch: any = null,
      profile: any = null,
      connected = source === "yc",
      assignments = 0,
      creates = 0,
      profileCreates = 0,
      failed = false;
    const device = {
      id: "device",
      kind: "devices",
      name: "Test chamber",
      data: {
        unit: "F",
        collection_enabled: true,
        control_claimed: true,
        last_seen: Date.now(),
      },
    };
    const plan = {
      unit: "C",
      control_sensor: "beer",
      end_behavior: "hold",
      steps: [
        { name: "Primary", temperature: 18, hours: 48, transition: "hold" },
        { name: "Warm up", temperature: 20, hours: 24, transition: "ramp" },
      ],
    };
    const recent = {
      id: "new",
      name: "Newest beer",
      number: 46,
      status: "Planning",
      recipe: "House ale",
      og: 1.05,
      brew_date: 1794956400000,
    };
    const requests: string[] = [];
    await page.route("**/api/v1/**", async (r) => {
      const path = new URL(r.request().url()).pathname,
        method = r.request().method();
      requests.push(method + " " + path);
      let body: any = [];
      if (path.endsWith("/auth/status"))
        body = { configured: true, authenticated: true, internal_auth: false };
      else if (path.endsWith("/resources/settings"))
        body = [
          { data: { theme: source === "brewfather" ? "dark" : "light" } },
        ];
      else if (path.endsWith("/diagnostics"))
        body = { control_enabled: true, collection_enabled: true };
      else if (path.endsWith("/brewfather/connection")) {
        if (method === "PUT") connected = true;
        body = { connected, encrypted: connected };
      } else if (path.endsWith("/brewfather/batches"))
        body = {
          batches: [
            {
              ...recent,
              id: "undated",
              name: "Undated old beer",
              number: 3,
              brew_date: null,
            },
            recent,
            { ...recent, id: "old", name: "Older beer", number: 45 },
          ],
          next: null,
        };
      else if (path.endsWith("/brewfather/batches/new/plan"))
        body = {
          batch: recent,
          candidate: {
            status: "ready",
            profile: plan,
            total_hours: 72,
            warnings: [],
          },
        };
      else if (path.endsWith("/resources/devices")) body = [device];
      else if (path.endsWith("/resources/devices/device")) body = device;
      else if (path.endsWith("/resources/profiles")) {
        if (method === "POST") {
          profileCreates++;
          profile = {
            id: "copy",
            kind: "profiles",
            ...r.request().postDataJSON(),
          };
          body = profile;
        } else
          body = [
            { id: "yc", name: "House ale", kind: "profiles", data: plan },
          ];
      } else if (path.endsWith("/devices/device/profile")) {
        assignments++;
        (device.data as any).profile = r.request().postDataJSON().profile;
        body = { assigned: true };
      } else if (path.endsWith("/resources/batches") && method === "POST") {
        creates++;
        batch = { id: "batch", kind: "batches", ...r.request().postDataJSON() };
        body = batch;
      } else if (path.endsWith("/resources/batches/batch")) {
        if (method === "PUT") {
          const incoming = r.request().postDataJSON();
          if (incoming.data.status === "active" && !failed) {
            failed = true;
            return r.fulfill({
              status: 503,
              json: { error: "Temporary batch save failure" },
            });
          }
          batch = { ...batch, ...incoming };
        }
        body = batch;
      } else if (path.endsWith("/resources/batches"))
        body = batch ? [batch] : [];
      await r.fulfill({ json: body });
    });
    await page.goto("/batches");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page
      .getByRole("button", {
        name: source === "yc" ? /YC profile/ : /^Brewfather/,
      })
      .click();
    if (source === "brewfather") {
      await page.getByLabel("User ID", { exact: true }).fill("synthetic-user");
      await page.getByLabel("API key", { exact: true }).fill("synthetic-key");
      await page
        .getByRole("button", { name: "Connect Brewfather", exact: true })
        .click();
      await expect(page.locator(".batch-choice").first()).toContainText(
        "Newest beer",
      );
      await page.getByRole("button", { name: /#46 · Newest beer/ }).click();
    } else await page.getByRole("button", { name: /House ale/ }).click();
    await expect(
      page.getByRole("button", { name: "Continue", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: `/tmp/yc-choose-${source}-${test.info().project.name}.png`,
      scale: "css",
    });
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    if (source === "brewfather") {
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
        "Newest beer",
      );
      await expect(
        page.getByLabel("Original gravity SG · optional"),
      ).toHaveValue("1.05");
      await page.getByLabel("When finished").selectOption("off");
    } else
      await page
        .getByLabel("Name", { exact: true })
        .fill("Local profile batch");
    await page
      .getByLabel("Temperature controller", { exact: true })
      .selectOption("device");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    expect(assignments).toBe(0);
    expect(profileCreates).toBe(0);
    expect(batch.data.status).toBe("planned");
    await page.goto("/batches/batch");
    await page
      .getByRole("button", { name: "Start batch", exact: true })
      .click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    if (source === "brewfather")
      await expect(page.getByLabel("When finished")).toHaveValue("off");
    for (const b of await page.locator('[role="dialog"] button').all()) {
      const box = await b.boundingBox();
      if (box) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(
          page.viewportSize()!.width,
        );
      }
    }
    await page.getByRole("dialog").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({
      scale: "css",
      path: `/tmp/yc-start-${source}-${test.info().project.name}.png`,
      fullPage: false,
    });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Start batch", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "Temporary batch save failure",
    );
    expect(assignments).toBe(1);
    if (source === "brewfather") {
      await page.keyboard.press("Escape");
      await page.goto("/batches/batch");
      await page
        .getByRole("button", { name: "Start batch", exact: true })
        .click();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
    }
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Start batch", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(assignments).toBe(1);
    expect(creates).toBe(1);
    expect(batch.data.status).toBe("active");
    expect(profileCreates).toBe(source === "brewfather" ? 1 : 0);
    if (source === "brewfather") {
      expect(profile.data.end_behavior).toBe("off");
      expect(profile.data.unit).toBe("C");
      expect(batch.data.brewfather.id).toBe("new");
    }
    expect(
      requests.some(
        (p) => p.includes("brewfather/") && p.includes("/readings"),
      ),
    ).toBeFalsy();
    expect(
      requests.some((p) => p.startsWith("POST /api/v1/brewfather")),
    ).toBeFalsy();
  });
