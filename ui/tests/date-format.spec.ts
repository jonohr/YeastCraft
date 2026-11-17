// SPDX-License-Identifier: GPL-3.0-only
import { test, expect } from "@playwright/test";
import { defaults, formatDate } from "../src/preferences";
import { controllerEvent } from "../src/controller";
test("date formats respect time zone and historical modes are readable", () => {
  const time = "2026-01-02T23:04:05Z";
  for (const [date_format, expected] of [
    ["YYYY-MM-DD", "2026-01-03"],
    ["DD/MM/YYYY", "03/01/2026"],
    ["DD.MM.YYYY", "03.01.2026"],
    ["MM/DD/YYYY", "01/03/2026"],
  ] as const) {
    expect(formatDate(time, { ...defaults, date_format })).toBe(
      expected + " 00:04:05",
    );
  }
  expect(formatDate(time, { ...defaults, timezone: "UTC" })).toBe(
    "2026-01-02 23:04:05",
  );
  expect(formatDate(0, { ...defaults, timezone: "UTC" })).toBe(
    "1970-01-01 00:00:00",
  );
  expect(controllerEvent("Mode set to f")).toBe(
    "Control changed to fixed chamber temperature",
  );
  expect(controllerEvent("Mode set to p.")).toBe(
    "Control changed to fermentation profile",
  );
  expect(controllerEvent("Mode set to x")).toBe("Mode set to x");
  expect(controllerEvent("My note: Mode set to p")).toBe(
    "My note: Mode set to p",
  );
});
test("date format persists and changes displayed history without rewriting notes", async ({
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
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  const response = await page.request.post("/api/v1/resources/notes", {
    data: {
      name: "Mode set to p",
      data: { text: "Mode set to f", created: "2026-01-02T23:04:05Z" },
    },
  });
  expect(response.ok()).toBeTruthy();
  const note = await response.json();
  for (const dateFormat of ["DD.MM.YYYY", "MM/DD/YYYY", "YYYY-MM-DD"]) {
    await page.goto("/settings");
    await page
      .getByLabel("Date format", { exact: true })
      .selectOption(dateFormat);
    await page
      .getByRole("button", { name: "Save preferences", exact: true })
      .click();
    await expect(page.getByRole("status")).toHaveText("Preferences saved.");
    await page.goto("/notes/" + note.id);
    await expect(
      page.getByRole("heading", {
        name: "Control changed to fermentation profile",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Control changed to fixed chamber temperature", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator(".card small").first()).toHaveText(
      formatDate("2026-01-02T23:04:05Z", {
        ...defaults,
        date_format: dateFormat as any,
      }),
    );
  }
  await page.goto("/settings");
  await page.getByLabel("Appearance", { exact: true }).selectOption("system");
  await page
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText("Preferences saved.");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const stored = await (
    await page.request.get("/api/v1/resources/notes/" + note.id)
  ).json();
  expect(stored.name).toBe("Mode set to p");
  expect(stored.data.text).toBe("Mode set to f");
});
