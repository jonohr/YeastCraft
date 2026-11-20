// SPDX-License-Identifier: GPL-3.0-only
import { duration } from "./duration";
export default function PlanPreview({
  steps,
  unit,
}: {
  steps: any[];
  unit: string;
}) {
  if (
    !steps.length ||
    steps.some((s) => !Number.isFinite(s.hours) || s.hours <= 0 || s.until)
  )
    return null;
  const total = steps.reduce((n, s) => n + s.hours, 0),
    temps = steps.map((s) => s.temperature),
    low = Math.min(...temps) - 1,
    high = Math.max(...temps) + 1;
  const y = (t: number) => 95 - ((t - low) / (high - low)) * 75;
  let time = 0,
    previous = temps[0];
  const points = [`10,${y(previous)}`];
  for (const s of steps) {
    if (s.transition !== "ramp")
      points.push(`${10 + (time / total) * 580},${y(s.temperature)}`);
    time += s.hours;
    previous = s.temperature;
    points.push(`${10 + (time / total) * 580},${y(previous)}`);
  }
  return (
    <>
      <svg
        className="batch-plan-chart"
        viewBox="0 0 600 125"
        role="img"
        aria-label={`Temperature plan, ${duration(total)}, ${temps[0]} to ${temps.at(-1)} degrees ${unit}`}
      >
        <line x1="10" x2="590" y1="100" y2="100" stroke="#526359" />
        <polyline
          points={points.join(" ")}
          fill="none"
          stroke="#b9d39f"
          strokeWidth="3"
        />
        <text x="10" y="120" fill="currentColor" fontSize="13">
          Start · {temps[0]} °{unit}
        </text>
        <text
          x="590"
          y="120"
          textAnchor="end"
          fill="currentColor"
          fontSize="13"
        >
          {duration(total)} · {temps.at(-1)} °{unit}
        </text>
      </svg>
    </>
  );
}
