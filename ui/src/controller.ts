// SPDX-License-Identifier: GPL-3.0-only
import type { Entity } from "./api";

export function stateBand(state: unknown) {
  if (state === 3 || state === 9) return { label: "Heating", color: "#d64b43" };
  if (state === 4 || state === 8) return { label: "Cooling", color: "#387fc3" };
  if (state === 0 || state === 5 || state === 6 || state === 7)
    return { label: "Idle", color: "#429464" };
  return {
    label: state === 1 ? "Off" : state === 2 ? "Door open" : "Unknown",
    color: "#a8aea8",
  };
}

export function stateIntervals(points: any[]) {
  return points.flatMap((point, index) => {
    const next = points[index + 1];
    // Do not invent a continuous operating state across missing/decimated data.
    const end = Math.min(next?.time ?? point.time + 30000, point.time + 90000);
    return end > point.time
      ? [[point.time, end, point.values.state ?? -1]]
      : [];
  });
}

export function activeTarget(device: Entity) {
  const values = device.data.last_values;
  const unit = values?.temp_format || device.data.unit || "C";
  if (typeof values?.beer_set === "number" && Number.isFinite(values.beer_set))
    return { mode: "b", value: values.beer_set as number, unit };
  if (
    typeof values?.fridge_set === "number" &&
    Number.isFinite(values.fridge_set)
  )
    return { mode: "f", value: values.fridge_set as number, unit };
  return { mode: null, value: null, unit };
}

// BrewPi's state enum is defined by upstream Fermentrack app/models.py (BeerLogPoint).
// Minimum-run states still mean the corresponding output is active.
export function operatingState(device: Entity) {
  if (
    !device.data.collection_enabled ||
    !device.data.last_seen ||
    Date.now() - Number(device.data.last_seen) >= 120000 ||
    device.data.last_error
  )
    return { label: "Operating state unavailable", tone: "unknown" };
  const states: Record<number, { label: string; tone: string }> = {
    0: { label: "Idle", tone: "waiting" },
    1: { label: "Off", tone: "off" },
    2: { label: "Door open", tone: "waiting" },
    3: { label: "Heating", tone: "heating" },
    4: { label: "Cooling", tone: "cooling" },
    5: { label: "Waiting to cool", tone: "waiting" },
    6: { label: "Waiting to heat", tone: "waiting" },
    7: { label: "Waiting for peak detection", tone: "waiting" },
    8: { label: "Cooling · minimum run time", tone: "cooling" },
    9: { label: "Heating · minimum run time", tone: "heating" },
  };
  const code = device.data.last_values?.state;
  return (
    (typeof code === "number" && states[code]) || {
      label: "Unknown operating state",
      tone: "unknown",
    }
  );
}

// Translate only recognized historical BrewPi events at presentation time.
// Keep stored/imported text and unknown messages unchanged.
export function controllerEvent(text: string) {
  const match =
    /^mode set to\s+['"]?([fbpo])['"]?(?: in web interface)?[.!]?$/i.exec(
      text.trim(),
    );
  if (!match) return text;
  return (
    {
      f: "Control changed to fixed chamber temperature",
      b: "Control changed to fixed beer temperature",
      p: "Control changed to fermentation profile",
      o: "Temperature control turned off",
    } as Record<string, string>
  )[match[1].toLowerCase()];
}
