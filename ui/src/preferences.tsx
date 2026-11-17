// SPDX-License-Identifier: GPL-3.0-only
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { list } from "./api";
export type Preferences = {
  unit: "C" | "F";
  gravity_unit: "SG" | "Plato";
  timezone: string;
  date_format: "YYYY-MM-DD" | "DD/MM/YYYY" | "DD.MM.YYYY" | "MM/DD/YYYY";
  theme: "light" | "dark" | "system";
};
export const defaults: Preferences = {
  unit: "C",
  gravity_unit: "SG",
  timezone: "Europe/Stockholm",
  date_format: "YYYY-MM-DD",
  theme: "light",
};
const Context = createContext(defaults);
export let currentPreferences = defaults;
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState(defaults);
  useEffect(() => {
    let live = true;
    let revision = 0;
    const load = (event?: Event) => {
      const ticket = ++revision;
      const immediate = (event as CustomEvent<Preferences> | undefined)?.detail;
      if (immediate) {
        const next = { ...defaults, ...immediate };
        currentPreferences = next;
        setValue(next);
        applyTheme(next.theme);
      }
      return list("settings")
        .then((rows) => {
          if (live && ticket === revision) {
            const next = { ...defaults, ...rows[0]?.data };
            currentPreferences = next;
            setValue(next);
            applyTheme(next.theme);
          }
        })
        .catch(() => {});
    };
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const updateSystem = () => {
      applyTheme(currentPreferences.theme);
      setValue((v) => ({ ...v }));
    };
    media.addEventListener("change", updateSystem);
    load();
    window.addEventListener("preferences-changed", load);
    return () => {
      live = false;
      media.removeEventListener("change", updateSystem);
      window.removeEventListener("preferences-changed", load);
    };
  }, []);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const usePreferences = () => useContext(Context);
export function temperature(value: unknown, from: string, to: string) {
  if (typeof value !== "number") return null;
  if (from === to) return value;
  return from === "F" ? ((value - 32) * 5) / 9 : (value * 9) / 5 + 32;
}
export function density(value: unknown, unit: string) {
  if (typeof value !== "number") return null;
  return unit === "Plato"
    ? -616.868 +
        1111.14 * value -
        630.272 * value * value +
        135.997 * value * value * value
    : value;
}

export function formatDate(
  value: unknown,
  prefs = currentPreferences,
  includeTime = true,
) {
  if (value === null || value === undefined || value === "") return "—";
  const date = new Date(value as string | number);
  if (!Number.isFinite(date.getTime())) return String(value);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: prefs.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (key: string) => parts.find((p) => p.type === key)?.value || "";
  const dateText = (prefs.date_format || defaults.date_format)
    .replace("YYYY", get("year"))
    .replace("MM", get("month"))
    .replace("DD", get("day"));
  return includeTime
    ? `${dateText} ${get("hour")}:${get("minute")}:${get("second")}`
    : dateText;
}
export function formatTime(value: number, prefs = currentPreferences) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: prefs.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function applyTheme(theme: Preferences["theme"]) {
  document.documentElement.dataset.theme =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
}
