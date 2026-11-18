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

test("preferences wait for stored settings before accepting edits", async ({
  page,
}) => {
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settings = {
    id: "existing",
    kind: "settings",
    name: "Settings",
    data: { ...defaults, date_format: "DD.MM.YYYY" },
  };
  let saved: any = null;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/status"))
      return route.fulfill({
        json: { configured: true, authenticated: true, internal_auth: false },
      });
    if (
      path.endsWith("/resources/settings") &&
      route.request().method() === "GET"
    ) {
      await loaded;
      return route.fulfill({ json: [settings] });
    }
    if (
      path.includes("/resources/settings") &&
      route.request().method() !== "GET"
    ) {
      saved = {
        path,
        method: route.request().method(),
        ...route.request().postDataJSON(),
      };
      settings = { ...settings, data: saved.data };
      return route.fulfill({ json: settings });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto("/settings");
  const appearance = page.getByLabel("Appearance", { exact: true });
  try {
    await expect(appearance).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Save preferences", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(appearance).toBeEnabled();
  await expect(page.getByLabel("Date format", { exact: true })).toHaveValue(
    "DD.MM.YYYY",
  );
  await appearance.selectOption("system");
  await page
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText("Preferences saved.");
  expect(saved.method).toBe("PUT");
  expect(saved.path).toBe("/api/v1/resources/settings/existing");
  expect(saved.data.theme).toBe("system");
  expect(saved.data.date_format).toBe("DD.MM.YYYY");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
