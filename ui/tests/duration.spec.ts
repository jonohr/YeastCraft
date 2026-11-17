// SPDX-License-Identifier: GPL-3.0-only
import { test, expect } from "@playwright/test";
import { duration } from "../src/duration";
test("short profile holds retain hours and minutes instead of rounded days", () => {
  expect(duration(1.5)).toBe("1 hour 30 minutes");
  expect(duration(1)).toBe("1 hour");
  expect(duration(10)).toBe("10 hours");
  expect(duration(48)).toBe("2 days");
  expect(duration(25.5)).toBe("1 day 1 hour 30 minutes");
  expect(duration(1 / 120)).toBe("<1 minute");
});
