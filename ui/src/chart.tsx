// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useRef, useState } from "react";
import {
  usePreferences,
  temperature,
  density,
  formatDate,
  formatTime,
} from "./preferences";
import * as echarts from "echarts/core";
import { LineChart, CustomChart } from "echarts/charts";
import { stateBand, stateIntervals } from "./controller";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
echarts.use([
  LineChart,
  CustomChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  CanvasRenderer,
]);
const plotSeries = [
  ["Beer", "beer_temp", "beer"],
  ["Beer target", "beer_set", "beer-target"],
  ["Chamber", "fridge_temp", "chamber"],
  ["Chamber target", "fridge_set", "chamber-target"],
  ["Gravity", "gravity", "gravity"],
  ["Sample temperature", "gravity_temp", "sample"],
] as const;
export default function Chart({ points }: { points: any[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const instance = useRef<ReturnType<typeof echarts.init> | null>(null);
  const prefs = usePreferences();
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    instance.current = chart;
    chart.setOption({
      animation: false,
      color: ["#A65331", "#A6ADA5", "#367FB1", "#9BAFBA", "#30734E"],
      tooltip: { trigger: "axis" },
      legend: {
        show: false,
        data: [
          "Beer",
          "Beer target",
          "Chamber",
          "Chamber target",
          "Gravity",
          "Sample temperature",
        ],
      },
      grid: [
        { top: 36, left: 46, right: 46, bottom: 116 },
        { left: 46, right: 46, bottom: 64, height: 12 },
      ],
      xAxis: [
        { type: "time", axisLabel: { hideOverlap: true } },
        { type: "time", gridIndex: 1, show: false },
      ],
      yAxis: [
        {
          type: "value",
          name: "°" + prefs.unit,
          scale: true,
        },
        { type: "value", name: prefs.gravity_unit, scale: true },
        { type: "value", gridIndex: 1, show: false, min: 0, max: 1 },
      ],
      dataZoom: [
        { type: "inside", xAxisIndex: [0, 1], filterMode: "weakFilter" },
        {
          type: "slider",
          xAxisIndex: [0, 1],
          filterMode: "weakFilter",
          bottom: 12,
          height: 20,
        },
      ],
    });
    const ro = new ResizeObserver(() => {
      chart.resize();
      chart.setOption({
        xAxis: [{ splitNumber: ref.current!.clientWidth < 450 ? 3 : 6 }],
      });
    });
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      instance.current = null;
    };
  }, []);
  useEffect(() => {
    // Merge data and theme changes without resetting zoom or legend selections.
    const style = getComputedStyle(document.documentElement);
    const ink = style.getPropertyValue("--ink").trim();
    const muted = style.getPropertyValue("--muted").trim();
    const line = style.getPropertyValue("--line").trim();
    const surface = style.getPropertyValue("--surface").trim();
    const dark = document.documentElement.dataset.theme === "dark";
    instance.current?.setOption({
      color: dark
        ? ["#efae87", "#dfc9b6", "#74c2f4", "#b2d1e6", "#77d8a4", "#cba5ee"]
        : ["#a65331", "#85705e", "#287ab1", "#637e91", "#30734e", "#8655ad"],
      textStyle: { color: ink },
      legend: {
        textStyle: { color: muted },
        inactiveColor: dark ? "#778079" : "#858b86",
      },
      dataZoom: [
        {},
        {
          textStyle: { color: muted },
          borderColor: line,
          backgroundColor: surface,
          fillerColor: dark ? "#74c2f426" : "#287ab126",
          dataBackground: {
            lineStyle: { color: muted },
            areaStyle: { color: line },
          },
          selectedDataBackground: {
            lineStyle: { color: dark ? "#74c2f4" : "#287ab1" },
            areaStyle: { color: dark ? "#74c2f4" : "#287ab1" },
          },
        },
      ],
      xAxis: [0, 1].map(() => ({
        min: points[0]?.time,
        max: points.at(-1)?.time,
        axisLabel: {
          formatter: (value: number) =>
            (points.at(-1)?.time - points[0]?.time > 86400000
              ? formatDate(value, prefs, false) + "\n"
              : "") + formatTime(value, prefs),
          hideOverlap: true,
          color: muted,
          lineHeight: 16,
          margin: 12,
          fontSize: 11,
        },
        axisLine: { lineStyle: { color: line } },
        axisTick: { lineStyle: { color: line } },
      })),
      tooltip: {
        backgroundColor: surface,
        borderColor: line,
        textStyle: { color: ink },
        valueFormatter: (value: unknown) =>
          value == null ? "—" : String(value),
        formatter: (items: any[]) => {
          if (!Array.isArray(items) || !items.length) return "";
          return (
            formatDate(items[0].value[0], prefs) +
            "<br/>" +
            items
              .map((i) => i.marker + i.seriesName + ": " + (i.value[1] ?? "—"))
              .join("<br/>")
          );
        },
      },
      yAxis: ["°" + prefs.unit, prefs.gravity_unit].map((name) => ({
        name,
        nameTextStyle: { color: muted },
        axisLabel: { color: muted },
        splitLine: { lineStyle: { color: line } },
        axisLine: { lineStyle: { color: line } },
      })),
      series: [
        ...[
          ["Beer", "beer_temp", 0],
          ["Beer target", "beer_set", 0],
          ["Chamber", "fridge_temp", 0],
          ["Chamber target", "fridge_set", 0],
          ["Gravity", "gravity", 1],
          ["Sample temperature", "gravity_temp", 0],
        ].map(([name, key, axis]) => ({
          name,
          type: "line",
          showSymbol: key === "gravity",
          lineStyle: {
            type: String(key).endsWith("_set") ? "dashed" : "solid",
          },
          symbolSize: 5,
          connectNulls: false,
          yAxisIndex: axis,
          data: points
            .filter((p) =>
              Object.prototype.hasOwnProperty.call(p.values, key as string),
            )
            .map((p) => [
              p.time,
              key === "gravity"
                ? density(p.values.gravity, prefs.gravity_unit)
                : temperature(
                    p.values[key as string] ??
                      (key === "beer_temp" ? p.values.temp : null),
                    p.values.temp_format || "C",
                    prefs.unit,
                  ),
            ]),
        })),
        {
          name: "Operating history",
          type: "custom",
          xAxisIndex: 1,
          yAxisIndex: 2,
          encode: { x: [0, 1] },
          animation: false,
          data: stateIntervals(points),
          tooltip: {
            trigger: "item",
            formatter: (params: any) => {
              const [start, end, state] = params.value;
              return `${stateBand(state).label}<br/>${formatDate(start, prefs)} – ${formatTime(end, prefs)}`;
            },
          },
          renderItem: (params: any, api: any) => {
            const start = api.coord([api.value(0), 0])[0];
            const end = api.coord([api.value(1), 0])[0];
            const shape = echarts.graphic.clipRectByRect(
              {
                x: start,
                y: params.coordSys.y,
                width: Math.max(1, end - start),
                height: params.coordSys.height,
              },
              params.coordSys,
            );
            return (
              shape && {
                type: "rect",
                shape,
                style: { fill: stateBand(api.value(2)).color },
              }
            );
          },
        },
      ],
    });
  }, [points, prefs]);
  return (
    <>
      <div
        ref={ref}
        className="chart"
        role="img"
        aria-label="Temperature and gravity over time"
      />
      <div className="plot-legend" aria-label="Chart series">
        {plotSeries.map(([name, key, color]) => (
          <button
            key={key}
            type="button"
            aria-pressed={!hidden[name]}
            onClick={() => {
              instance.current?.dispatchAction({
                type: "legendToggleSelect",
                name,
              });
              setHidden((previous) => ({
                ...previous,
                [name]: !previous[name],
              }));
            }}
          >
            <span
              className={
                "plot-swatch" + (key.endsWith("_set") ? " dashed" : "")
              }
              style={{ color: `var(--plot-${color})` }}
              aria-hidden="true"
            />
            {name}
          </button>
        ))}
      </div>
      <div className="drift-legend" aria-label="Operating state colours">
        <span>
          <i style={{ background: "#d64b43" }} />
          Heating
        </span>
        <span>
          <i style={{ background: "#387fc3" }} />
          Cooling
        </span>
        <span>
          <i style={{ background: "#429464" }} />
          Idle
        </span>
        <span>
          <i style={{ background: "#a8aea8" }} />
          Off / other
        </span>
      </div>
    </>
  );
}
