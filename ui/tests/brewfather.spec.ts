// SPDX-License-Identifier: GPL-3.0-only
import { test, expect } from "@playwright/test";
test("Brewfather preview in the application: plan, final choice and review without writes", async ({
  page,
  request,
}) => {
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
  await page.goto("/integrations");
  await page.getByRole("link", { name: "Browse Brewfather batches" }).click();
  await expect(page.locator("#list-error")).toContainText("not connected");
  const b = {
    id: "synthetic",
    name: "Synthetic beer",
    number: 1,
    status: "Planning",
    og: 1.05,
    fg: null,
    recipe: "Demo",
    profile: {
      name: "Demo",
      steps: [{ name: "Primary", temperature: 18, days: 2, ramp: 1 }],
    },
  };
  let calls = 0;
  await page.route("**/api/v1/brewfather/**", async (route) => {
    expect(route.request().method()).toBe("GET");
    calls++;
    const url = route.request().url();
    await route.fulfill({
      json: url.endsWith("/batches")
        ? {
            batches: [b, { ...b, id: "zero", name: "Needs review" }],
            next: null,
            fetched: 1795000000,
          }
        : url.endsWith("/zero")
          ? {
              batch: b,
              readings: [],
              fetched: 1795000000,
              candidate: {
                status: "review_required",
                reason: "Step 1 has no duration; review its intent",
              },
            }
          : {
              batch: b,
              readings: [],
              fetched: 1795000000,
              candidate: {
                status: "ready",
                warnings: [
                  "First-step ramp omitted (1 days). YC sets 18 °C immediately and keeps the specified hold time.",
                ],
                total_hours: 48,
                profile: {
                  unit: "C",
                  end_behavior: "hold",
                  steps: [
                    {
                      name: "Primary",
                      temperature: 18,
                      hours: 48,
                      transition: "hold",
                    },
                  ],
                },
              },
            },
    });
  });
  await page.locator("#retry").click();
  await page.locator("#batch").selectOption("synthetic");
  await expect(page.locator("#yc-duration")).toHaveText("2d total");
  await expect(page.locator("#yc-steps li")).toHaveCount(1);
  await expect(page.locator("#yc-warnings")).toContainText(
    "First-step ramp omitted",
  );
  const before = calls;
  await page.locator("#end-behavior").selectOption("off");
  await expect(page.locator("#yc-ending")).toContainText(
    "turn temperature control off",
  );
  expect(calls).toBe(before);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: `/tmp/yc-brewfather-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.locator("#batch").selectOption("zero");
  await expect(page.locator("#yc-blocked")).toContainText("no duration");
  await expect(page.locator("#yc-plan")).toBeHidden();
});
