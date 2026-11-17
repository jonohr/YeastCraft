// SPDX-License-Identifier: GPL-3.0-only
import type { Entity } from "./api";
export const batchStatus = (e: Entity) =>
  ({
    active: "Active",
    planned: "Planned",
    completed: "Finished",
    archived: "Archived",
  })[e.data.status as string] || "Imported history · status unknown";
export const newestFirst = (rows: Entity[]) =>
  [...rows].sort(
    (a, b) =>
      (Date.parse(b.data.created) || 0) - (Date.parse(a.data.created) || 0),
  );
export function profileSteps(data: Record<string, any>) {
  if (data.steps?.length) return data.steps;
  const points = (data.legacy_steps || [])
    .map((p: any) => ({
      hour: Number(p.ttl) / 3600000000,
      temp: Number(p.temperature_setting),
      unit: p.temp_format || data.unit || "C",
    }))
    .sort((a: any, b: any) => a.hour - b.hour);
  if (
    points.some(
      (p: any, i: number) =>
        !Number.isFinite(p.hour) ||
        !Number.isFinite(p.temp) ||
        p.hour < 0 ||
        (i > 0 && p.hour <= points[i - 1].hour),
    ) ||
    points[0]?.hour === 0
  )
    return [];
  const unit = data.unit || "C";
  let previous = 0;
  return points.flatMap((p: any, i: number) => {
    const hours = p.hour - previous;
    previous = p.hour;
    const temperature =
      p.unit === unit
        ? p.temp
        : p.unit === "F"
          ? ((p.temp - 32) * 5) / 9
          : (p.temp * 9) / 5 + 32;
    return hours > 0
      ? [
          {
            name: i === 0 ? "Initial hold" : `Imported ramp ${i}`,
            hours,
            temperature,
            transition: i === 0 ? "hold" : "ramp",
          },
        ]
      : [];
  });
}
