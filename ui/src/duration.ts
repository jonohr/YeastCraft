// SPDX-License-Identifier: GPL-3.0-only
export function duration(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return "—";
  if (hours > 0 && hours * 60 < 1) return "<1 minute";
  const total = Math.round(hours * 60);
  const parts: string[] = [];
  for (const [count, unit] of [
    [Math.floor(total / 1440), "day"],
    [Math.floor((total % 1440) / 60), "hour"],
    [total % 60, "minute"],
  ] as const) {
    if (count) parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
  }
  return parts.join(" ") || "0 minutes";
}
