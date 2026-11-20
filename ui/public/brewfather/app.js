"use strict";
const $ = (id) => document.getElementById(id),
  ns = "http://www.w3.org/2000/svg";
let batches = [],
  next = null,
  current = null,
  selected = "",
  generation = 0,
  busy = false;
const date = (t) =>
  new Date(t).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const number = (v, d = 3) =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—";
function node(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function svg(tag, attrs, text) {
  const n = document.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}
async function api(path) {
  const r = await fetch("/api/v1/brewfather/" + path, {
    headers: { Accept: "application/json" },
    redirect: "error",
  });
  let d;
  try {
    d = await r.json();
  } catch {
    throw Error(
      "Unable to load data. Your login may have expired; reload this page.",
    );
  }
  if (!r.ok) throw Error(d.error || "Unable to load data.");
  return d;
}
function error(id, e) {
  $(id).textContent = e ? e.message : "";
  $(id).hidden = !e;
}
function options() {
  const search = $("search").value.toLowerCase();
  const items = batches.filter((b) =>
    [b.name, b.recipe, b.number].join(" ").toLowerCase().includes(search),
  );
  $("batch").replaceChildren(
    new Option(items.length ? "Choose a batch" : "No matching batches", ""),
  );
  for (const b of items)
    $("batch").add(
      new Option(
        `#${b.number ?? "—"} · ${b.name === "Batch" ? b.recipe || b.name : b.name} · ${b.status}`,
        b.id,
      ),
    );
  $("batch").value = selected;
  $("batch-count").textContent = batches.length;
}
async function loadList(more = false) {
  $("retry").hidden = true;
  $("more").disabled = true;
  error("list-error", null);
  try {
    const d = await api(
      "batches" + (more && next ? "?after=" + encodeURIComponent(next) : ""),
    );
    const all = more ? [...batches, ...d.batches] : d.batches;
    batches = [...new Map(all.map((b) => [b.id, b])).values()];
    next = d.next;
    options();
    $("more").hidden = !next;
  } catch (e) {
    error("list-error", e);
    $("retry").hidden = false;
  } finally {
    $("more").disabled = false;
  }
}
async function loadBatch() {
  const id = selected,
    token = ++generation;
  current = null;
  $("end-behavior").value = "hold";
  busy = false;
  $("loading").hidden = true;
  $("content").hidden = true;
  $("empty").hidden = !!id;
  error("error", null);
  if (!id) {
    $("refresh").disabled = true;
    return;
  }
  busy = true;
  $("refresh").disabled = true;
  $("loading").hidden = false;
  $("freshness").textContent = "Fetching selected batch…";
  try {
    const d = await api("batches/" + encodeURIComponent(id));
    if (token !== generation) return;
    current = d;
    render();
  } catch (e) {
    if (token === generation) {
      error("error", e);
      $("freshness").textContent = "Could not load this batch";
    }
  } finally {
    if (token === generation) {
      busy = false;
      $("loading").hidden = true;
      $("refresh").disabled = false;
    }
  }
}
async function refresh() {
  if (busy) return;
  if (!current) return loadBatch();
  const token = ++generation,
    id = selected;
  busy = true;
  $("refresh").disabled = true;
  error("error", null);
  $("freshness").textContent = "Checking Brewfather…";
  try {
    const d = await api("batches/" + encodeURIComponent(id));
    if (token === generation) {
      current = d;
      render();
    }
  } catch (e) {
    if (token === generation) {
      error("error", e);
      $("freshness").textContent =
        "Refresh failed · showing previously loaded data";
    }
  } finally {
    if (token === generation) {
      busy = false;
      $("refresh").disabled = false;
    }
  }
}
function render() {
  const { batch: b, readings: r, fetched } = current;
  $("content").hidden = false;
  $("empty").hidden = true;
  $("freshness").textContent =
    "Fetched " + date(fetched * 1000) + " · cached up to 60s";
  $("batch-number").textContent = "BATCH " + (b.number ?? "—");
  $("name").textContent = b.name === "Batch" ? b.recipe || b.name : b.name;
  $("recipe").textContent =
    b.recipe && b.recipe !== $("name").textContent ? b.recipe : "";
  $("status").textContent = b.status;
  $("og").textContent = number(b.og);
  $("fg").textContent = number(b.fg);
  const last = r.filter((x) => x.sg !== null).at(-1);
  $("sg").textContent = number(last?.sg);
  $("sg-source").textContent = last
    ? `${last.type === "manual" ? "Manual" : "Device"} · ${date(last.time)}`
    : "No gravity readings yet";
  $("profile-name").textContent = b.profile.name || "No fermentation profile";
  $("steps").replaceChildren();
  let days = 0,
    allDays = true;
  for (const [i, s] of b.profile.steps.entries()) {
    const li = node("li");
    li.append(node("span", String(i + 1).padStart(2, "0"), "step-index"));
    const box = node("div");
    box.append(
      node("h4", s.name || "Step " + (i + 1)),
      node("div", number(s.temperature, 1) + " °C", "step-value"),
      node(
        "p",
        s.days === null
          ? "Duration not supplied"
          : `${s.days} ${s.days === 1 ? "day" : "days"}`,
      ),
    );
    if (s.ramp !== null && s.ramp !== undefined)
      box.append(node("p", "Source ramp · " + durationHours(s.ramp * 24)));
    if (s.pressure !== null)
      box.append(node("p", "Pressure configured in Brewfather"));
    li.append(box);
    $("steps").append(li);
    if (s.days === null) allDays = false;
    else days += s.days;
  }
  $("duration").textContent = b.profile.steps.length
    ? (allDays ? `${days} days hold · ` : "") +
      `${b.profile.steps.length} steps`
    : "";
  if (!b.profile.steps.length)
    $("steps").append(node("p", "No steps have been supplied.", "footnote"));
  const manual = r.filter((x) => x.type === "manual");
  $("manual-count").textContent = `${manual.length} readings`;
  $("manual-empty").hidden = !!manual.length;
  $("manual").replaceChildren();
  for (const x of [...manual].reverse().slice(0, 50)) {
    const tr = node("tr");
    tr.append(
      node("td", date(x.time)),
      node("td", number(x.sg)),
      node("td", x.temp === null ? "—" : number(x.temp, 1) + " °C"),
    );
    $("manual").append(tr);
  }
  if (manual.length > 50)
    $("manual-count").textContent = `Latest 50 of ${manual.length}`;
  renderCandidate();
  renderCharts();
}
function slim(points, key) {
  if (points.length <= 600) return points;
  const size = Math.ceil(points.length / 300),
    out = [];
  for (let i = 0; i < points.length; i += size) {
    const bin = points.slice(i, i + size);
    let lo = bin[0],
      hi = bin[0];
    for (const p of bin) {
      if (p[key] < lo[key]) lo = p;
      if (p[key] > hi[key]) hi = p;
    }
    out.push(...[lo, hi].sort((a, b) => a.time - b.time));
  }
  out.unshift(points[0]);
  out.push(points.at(-1));
  return out;
}
function chart(id, key, rows) {
  const target = $(id);
  target.replaceChildren();
  const valid = rows.filter((r) => r[key] !== null);
  if (!valid.length) {
    target.append(
      node(
        "div",
        `No ${key === "sg" ? "gravity" : "temperature"} readings for this selection.`,
        "chart-empty",
      ),
    );
    return;
  }
  const w = Math.max(280, target.clientWidth),
    h = 230,
    pad = { l: 51, r: 12, t: 18, b: 38 };
  let minT = Infinity,
    maxT = -Infinity,
    minV = Infinity,
    maxV = -Infinity;
  for (const r of valid) {
    minT = Math.min(minT, r.time);
    maxT = Math.max(maxT, r.time);
    minV = Math.min(minV, r[key]);
    maxV = Math.max(maxV, r[key]);
  }
  const extra = Math.max((maxV - minV) * 0.15, key === "sg" ? 0.002 : 0.5);
  const low = minV - extra,
    high = maxV + extra;
  const x = (t) =>
      pad.l + ((t - minT) / (maxT - minT || 1)) * (w - pad.l - pad.r),
    y = (v) => pad.t + ((high - v) / (high - low)) * (h - pad.t - pad.b);
  const graph = svg("svg", {
    viewBox: `0 0 ${w} ${h}`,
    role: "img",
    "aria-label": `${key === "sg" ? "Gravity" : "Temperature"} chart with ${valid.length} readings`,
  });
  for (let i = 0; i < 5; i++) {
    const v = low + ((high - low) * i) / 4,
      yy = y(v);
    graph.append(
      svg("line", {
        x1: pad.l,
        x2: w - pad.r,
        y1: yy,
        y2: yy,
        stroke: "#34443d",
        "stroke-width": 1,
      }),
      svg(
        "text",
        { x: pad.l - 8, y: yy + 4, "text-anchor": "end" },
        v.toFixed(key === "sg" ? 3 : 1),
      ),
    );
  }
  const labels = w < 430 ? 2 : 3;
  for (let i = 0; i < labels; i++) {
    const t = minT + ((maxT - minT) * i) / (labels - 1);
    const label = new Date(t).toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    graph.append(
      svg(
        "text",
        {
          x: pad.l + ((w - pad.l - pad.r) * i) / (labels - 1),
          y: h - 10,
          "text-anchor":
            i === 0 ? "start" : i === labels - 1 ? "end" : "middle",
        },
        label,
      ),
    );
  }
  const groups = new Map();
  for (const r of rows.filter((r) => r.type !== "manual")) {
    const id = r.type + "|" + r.source;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }
  for (const points of groups.values()) {
    let segment = [];
    const draw = () => {
      if (segment.length) {
        const s = slim(segment, key);
        if (s.length > 1)
          graph.append(
            svg("polyline", {
              points: s.map((p) => `${x(p.time)},${y(p[key])}`).join(" "),
              fill: "none",
              stroke: "#8fc9ed",
              "stroke-width": 2,
              "stroke-linejoin": "round",
            }),
          );
        else
          graph.append(
            svg("circle", {
              cx: x(s[0].time),
              cy: y(s[0][key]),
              r: 3,
              fill: "#8fc9ed",
            }),
          );
      }
      segment = [];
    };
    for (const p of points) {
      if (p[key] === null) {
        draw();
        continue;
      }
      segment.push(p);
    }
    draw();
  }
  for (const r of valid.filter((r) => r.type === "manual")) {
    const c = svg("circle", {
      cx: x(r.time),
      cy: y(r[key]),
      r: 5,
      fill: "#b8cf9d",
      stroke: "#192724",
      "stroke-width": 2,
    });
    c.append(
      svg(
        "title",
        {},
        `${date(r.time)} · ${number(r[key], key === "sg" ? 3 : 1)} · Manual`,
      ),
    );
    graph.append(c);
  }
  target.append(graph);
}
function renderCharts() {
  if (!current) return;
  const mode = $("source").value,
    rows = current.readings.filter(
      (r) =>
        mode === "all" ||
        (mode === "manual" ? r.type === "manual" : r.type !== "manual"),
    );
  $("history-note").textContent =
    `${rows.length.toLocaleString("en-GB")} returned readings in this selection. Device lines are simplified for display; manual points are shown individually.`;
  chart("gravity-chart", "sg", rows);
  chart("temperature-chart", "temp", rows);
}
$("batch").addEventListener("change", () => {
  selected = $("batch").value;
  loadBatch();
});
$("search").addEventListener("input", options);
$("more").addEventListener("click", () => loadList(true));
$("retry").addEventListener("click", () => loadList());
$("refresh").addEventListener("click", refresh);
$("source").addEventListener("change", renderCharts);
let resize;
window.addEventListener("resize", () => {
  clearTimeout(resize);
  resize = setTimeout(() => {
    renderCharts();
    renderCandidate();
  }, 150);
});
loadList();
function durationHours(hours) {
  const total = Math.round(hours * 60),
    days = Math.floor(total / 1440),
    h = Math.floor((total % 1440) / 60),
    m = total % 60;
  return (
    [days ? `${days}d` : "", h ? `${h}h` : "", m ? `${m}m` : ""]
      .filter(Boolean)
      .join(" ") || "0h"
  );
}
function renderCandidate() {
  if (!current) return;
  const c = current.candidate;
  $("yc-warnings").replaceChildren();
  $("yc-adjustments").hidden = true;
  $("yc-steps").replaceChildren();
  $("yc-chart").replaceChildren();
  const ready = c?.status === "ready";
  $("yc-plan").hidden = !ready;
  $("yc-blocked").hidden = ready;
  $("yc-duration").hidden = !ready;
  if (!ready) {
    $("yc-blocked").textContent =
      c?.reason || "No translated profile is available.";
    return;
  }
  const p = c.profile;
  p.end_behavior = $("end-behavior").value;
  $("yc-duration").textContent = durationHours(c.total_hours) + " total";
  for (const message of c.warnings)
    $("yc-warnings").append(node("li", message));
  $("yc-adjustments").hidden = !c.warnings.length;
  let elapsed = 0,
    previous = null;
  for (const [i, s] of p.steps.entries()) {
    const li = node("li"),
      text = node("div");
    li.append(node("span", String(i + 1).padStart(2, "0"), "step-index"));
    text.append(
      node("h4", s.name),
      node(
        "p",
        `${durationHours(elapsed)} → ${durationHours(elapsed + s.hours)} from start · ${durationHours(s.hours)}`,
      ),
    );
    li.append(
      text,
      node(
        "strong",
        s.transition === "ramp"
          ? `${number(previous, 1)} → ${number(s.temperature, 1)} °C`
          : `Hold ${number(s.temperature, 1)} °C`,
      ),
    );
    $("yc-steps").append(li);
    elapsed += s.hours;
    previous = s.temperature;
  }
  $("yc-ending").textContent =
    p.end_behavior === "off"
      ? `After ${durationHours(elapsed)}, YC would turn temperature control off.`
      : `After ${durationHours(elapsed)}, YC would keep holding ${number(previous, 1)} °C until you change or stop control.`;
  const target = $("yc-chart"),
    w = Math.max(280, target.clientWidth),
    h = 220,
    left = 45,
    right = w - 12,
    top = 18,
    bottom = 180;
  const temps = p.steps.map((s) => s.temperature),
    lo = Math.min(...temps) - 2,
    hi = Math.max(...temps) + 2;
  const x = (t) => left + (t / c.total_hours) * (right - left),
    y = (t) => bottom - ((t - lo) / (hi - lo)) * (bottom - top);
  const graph = svg("svg", {
    viewBox: `0 0 ${w} ${h}`,
    role: "img",
    "aria-label": `YC target temperature over ${durationHours(c.total_hours)}`,
  });
  for (let i = 0; i < 4; i++) {
    const t = lo + ((hi - lo) * i) / 3,
      yy = y(t);
    graph.append(
      svg("line", { x1: left, x2: right, y1: yy, y2: yy, stroke: "#3c5044" }),
      svg(
        "text",
        { x: left - 7, y: yy + 4, "text-anchor": "end" },
        t.toFixed(1),
      ),
    );
  }
  let time = 0,
    prev = p.steps[0].temperature;
  const points = [[x(0), y(prev)]];
  for (const s of p.steps) {
    points.push([x(time), y(s.transition === "ramp" ? prev : s.temperature)]);
    time += s.hours;
    points.push([x(time), y(s.temperature)]);
    prev = s.temperature;
  }
  graph.append(
    svg("polyline", {
      points: points.map((v) => v.join(",")).join(" "),
      fill: "none",
      stroke: "#b8cf9d",
      "stroke-width": 2.5,
      "stroke-linejoin": "round",
    }),
  );
  const n = w < 430 ? 2 : 3;
  for (let i = 0; i < n; i++) {
    const t = (c.total_hours * i) / (n - 1);
    graph.append(
      svg(
        "text",
        {
          x: x(t),
          y: 208,
          "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle",
        },
        i === 0 ? "Start" : durationHours(t),
      ),
    );
  }
  graph.append(svg("text", { x: left, y: 12 }, "°C · Target"));
  target.append(graph);
}
$("end-behavior").addEventListener("change", renderCandidate);
