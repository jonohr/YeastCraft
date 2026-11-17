import ProtocolLog from "./protocol-log";
import BatchStart from "./batch-start";
import { batchStatus, newestFirst, profileSteps } from "./workflow";
import { duration } from "./duration";
import {
  Tabs,
  Metrics,
  EquipmentCards,
  ToolPanel,
  WorkspaceLinks,
  ActivityList,
  ProfileSummary,
  MeasurementHistory,
} from "./workspace-ui";
import { Modal } from "./dialogs";
import { ConfirmationHost } from "./dialogs";
import { confirmAction } from "./dialogs";
// SPDX-License-Identifier: GPL-3.0-only
import ProfileBuilder from "./profile-builder";
import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  lazy,
  Suspense,
} from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  Link,
  useParams,
  useNavigate,
} from "react-router-dom";
import {
  Activity,
  Beer,
  Refrigerator,
  ChartNoAxesCombined,
  ClipboardList,
  Download,
  FlaskConical,
  Gauge,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Upload,
  X,
  ArrowLeft,
  Radio,
  Search,
  ChevronRight,
} from "lucide-react";
import { api, list, save, type Entity } from "./api";
import { activeTarget, operatingState, controllerEvent } from "./controller";
import PinConfiguration from "./pin-config";
import SensorTools from "./sensor-tools";
import { isTilt, TiltFields, TiltNotice } from "./tilt";
import EquipmentSetup from "./equipment-setup";
import IntegrationSetup from "./integration-setup";
import Troubleshooting from "./troubleshooting";
import "./style.css";
import {
  PreferencesProvider,
  currentPreferences,
  defaults,
  formatDate,
  usePreferences,
  temperature,
  density,
} from "./preferences";
const Chart = lazy(() => import("./chart"));
const names: Record<string, string> = {
  devices: "Equipment",
  sensors: "Gravity sensors",
  batches: "Batches",
  profiles: "Fermentation profiles",
  notes: "Notes",
  integrations: "Integrations",
  calibrations: "Calibration",
  gravity_logs: "Gravity logs",
};
const description: Record<string, string> = {
  devices: "Controllers and sensors in your workspace.",
  sensors: "Temperature, gravity and sensor health.",
  batches: "Your fermentation history, from first pitch to final gravity.",
  profiles: "Build a temperature schedule, step by step.",
  integrations: "Choose where your fermentation data goes.",
  gravity_logs: "Measurement history from your gravity sensors.",
  calibrations: "Calibration values and sensor associations.",
};
function useLoad<T>(load: () => Promise<T>, deps: unknown[] = [], pollMs = 0) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [checkedAt, setCheckedAt] = useState(0);
  const generation = useRef(0),
    pending = useRef(false);
  const run = useCallback((background: boolean) => {
    if (background && pending.current) return;
    const request = ++generation.current;
    pending.current = true;
    if (!background) {
      setLoading(true);
      setError("");
    }
    load()
      .then((value) => {
        if (request !== generation.current) return;
        setData(value);
        setError("");
      })
      .catch((e) => {
        if (request === generation.current) setError(e.message);
      })
      .finally(() => {
        if (request !== generation.current) return;
        pending.current = false;
        setLoading(false);
        // Re-evaluate measurement age even if repeated failures have the same text.
        setCheckedAt(Date.now());
      });
  }, deps);
  const refresh = useCallback(() => run(false), [run]);
  useEffect(() => {
    refresh();
    return () => {
      generation.current++;
      pending.current = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (!pollMs) return;
    const timer = window.setInterval(() => run(true), pollMs);
    return () => window.clearInterval(timer);
  }, [run, pollMs]);
  const reload = useCallback(() => run(true), [run]);
  return { data, error, loading, refresh, reload, checkedAt };
}
function ErrorBox({ message }: { message: string }) {
  return message ? (
    <div className="alert error" role="alert">
      {message}
    </div>
  ) : null;
}
function Empty({
  title = "Nothing here yet",
  children,
}: {
  title?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <FlaskConical size={36} />
      <h3>{title}</h3>
      <p>{children || "Create a record or import your existing history."}</p>
    </div>
  );
}
function Button({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props}>{children}</button>;
}
function Auth({
  configured,
  onDone,
}: {
  configured: boolean;
  onDone: () => void;
}) {
  const [user, setUser] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="auth">
      <section className="auth-story">
        <div className="brand">
          <FlaskConical /> FERMENTRACK
        </div>
        <div>
          <span className="eyebrow">FROM FIRST PITCH TO FINAL GRAVITY</span>
          <h1>
            Give fermentation
            <br />
            room to grow.
          </h1>
          <p>
            Temperature, gravity and every detail.
            <br />
            Everything together in your fermentation workspace.
          </p>
        </div>
        <small>Your server. Your equipment. Your history.</small>
      </section>
      <section className="auth-form">
        <div className="auth-inner">
          <span className="eyebrow">WORKSPACE</span>
          <h2>{configured ? "Welcome back" : "Create your workspace"}</h2>
          <p>
            {configured
              ? "Sign in to your fermentation workspace."
              : "Create your local owner account."}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              if (!configured && password !== confirm) {
                setError("Passwords do not match.");
                return;
              }
              setBusy(true);
              try {
                const credentials = { username: user, password };
                if (!configured) await api("/auth/setup", "POST", credentials);
                await api("/auth/login", "POST", credentials);
                onDone();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Username
              <input
                autoComplete="username"
                required
                value={user}
                onChange={(e) => setUser(e.target.value)}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                required
                minLength={configured ? 1 : 12}
                maxLength={256}
                autoComplete={configured ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {!configured && (
              <label>
                Confirm password
                <input
                  required
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </label>
            )}
            <ErrorBox message={error} />
            <Button disabled={busy}>
              {busy
                ? "Please wait…"
                : configured
                  ? "Sign in"
                  : "Create workspace"}
              <ChevronRight size={16} />
            </Button>
          </form>
        </div>
      </section>
    </main>
  );
}
const navigation = [
  ["/", "Overview", LayoutDashboard],
  ["/batches", "Batches", Beer],
  ["/devices", "Equipment", Refrigerator],
  ["/sensors", "Gravity sensors", Gauge],
  ["/profiles", "Profiles", ChartNoAxesCombined],
  ["/integrations", "Integrations", Radio],
  ["/import", "Import", Upload],
  ["/backup", "Backup", ShieldCheck],
  ["/settings", "Settings", Settings],
  ["/diagnostics", "Diagnostics", Activity],
] as const;
function Shell({
  onLogout,
  internalAuth,
}: {
  onLogout: () => void;
  internalAuth: boolean;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <>
      <aside className={menu ? "sidebar open" : "sidebar"}>
        <Link className="brand" to="/">
          <FlaskConical /> FERMENTRACK
        </Link>
        <p className="nav-caption">WORKSPACE</p>
        <nav>
          {navigation
            .filter(([path]) =>
              ["/", "/batches", "/devices", "/profiles", "/settings"].includes(
                path,
              ),
            )
            .map(([path, label, Icon]) => (
              <NavLink
                key={path}
                to={path}
                end={path === "/"}
                onClick={() => setMenu(false)}
              >
                <Icon size={18} />
                {label}
              </NavLink>
            ))}
        </nav>
        <div className="sidebar-foot">
          <span className="dot" /> Local workspace
          <Button
            className="quiet"
            onClick={async () => {
              const result = await api("/auth/logout", "POST", {});
              if (result.logout_url) {
                window.location.assign(result.logout_url);
                return;
              }
              onLogout();
            }}
          >
            <LogOut size={16} />
            Sign out
          </Button>
        </div>
      </aside>
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}
      <div className="workspace">
        <header className="topbar">
          <Button
            className="icon mobile"
            aria-label="Open navigation"
            onClick={() => setMenu(!menu)}
          >
            <Menu />
          </Button>
          <span>
            Fermentrack <span className="muted">/ Workspace</span>
          </span>
          <span className="badge">WORKSPACE</span>
        </header>
        <main className="content">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route
              path="/devices/:id/pins"
              element={<Detail kind="devices" view="pins" />}
            />
            <Route
              path="/devices/:id/connect"
              element={<Detail kind="devices" view="connect" />}
            />
            <Route
              path="/sensors/:id/connect"
              element={<Detail kind="sensors" view="connect" />}
            />
            <Route
              path="/sensors/:id/connection"
              element={<Detail kind="sensors" view="connection" />}
            />
            <Route
              path="/sensors/:id/calibration"
              element={<Detail kind="sensors" view="calibration" />}
            />

            {Object.keys(names).map((kind) => (
              <React.Fragment key={kind}>
                <Route
                  path={"/" + kind}
                  element={<Collection key={kind} kind={kind} />}
                />
                <Route
                  path={"/" + kind + "/:id"}
                  element={<Detail key={kind} kind={kind} />}
                />
              </React.Fragment>
            ))}
            <Route path="/import" element={<Import />} />
            <Route path="/backup" element={<Backup />} />
            <Route
              path="/settings"
              element={<SettingsPage internalAuth={internalAuth} />}
            />
            <Route path="/diagnostics" element={<Diagnostics />} />
            <Route
              path="/firmware"
              element={
                <>
                  <Heading
                    title="Firmware"
                    subtitle="Verktygen kommer i projektets sista etapp."
                  />
                  <Empty title="Coming in the final phase">
                    Firmware tools are planned for the final project phase.
                  </Empty>
                </>
              }
            />
            <Route
              path="*"
              element={
                <Empty title="Sidan hittades inte">
                  <Link to="/">Back to overview</Link>
                </Empty>
              }
            />
          </Routes>
        </main>
      </div>
      <nav className="bottom-nav">
        {navigation.slice(0, 3).map(([path, label, Icon]) => (
          <NavLink key={path} to={path} end={path === "/"}>
            <Icon size={19} />
            <span>{label}</span>
          </NavLink>
        ))}
        <button onClick={() => setMenu(!menu)}>
          <Menu size={19} />
          More
        </button>
      </nav>
    </>
  );
}
function Heading({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="heading">
      <div>
        <span className="eyebrow">FERMENTRACK</span>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className="actions">{children}</div>
    </div>
  );
}
function Overview() {
  const preferences = usePreferences(),
    navigate = useNavigate();
  const [note, setNote] = useState(false),
    [newBatch, setNewBatch] = useState(false);
  const q = useLoad(
    async () => {
      const [overview, devices, batches, sensors, notes] = await Promise.all([
        api("/overview"),
        list("devices"),
        list("batches"),
        list("sensors"),
        list("notes"),
      ]);
      const active = batches.find((b) => b.data.status === "active");
      const device =
        devices.find((d) => d.id === active?.data.device) || devices[0];
      const points = device
        ? await api<any[]>(
            "/measurements/" + encodeURIComponent(device.id) + "?limit=400",
          )
        : [];
      return {
        overview,
        devices,
        batches,
        sensors,
        notes,
        active,
        device,
        points,
      };
    },
    [],
    30000,
  );
  if (q.loading) return <Loading />;
  if (q.error && !q.data) return <ErrorBox message={q.error} />;
  const { overview, devices, batches, sensors, notes, active, device, points } =
    q.data!;
  const sensor =
    sensors.find((s) => s.id === active?.data.sensor) ||
    sensors.find((s) => s.data.device === device?.id);
  const temp = (v: unknown) =>
    temperature(
      v,
      device?.data.last_values?.temp_format || device?.data.unit || "C",
      preferences.unit,
    )?.toFixed(1) ?? "—";
  return (
    <>
      <Heading title="Overview" subtitle="Your fermentation, at a glance.">
        <button onClick={() => setNewBatch(true)}>New batch</button>
        <Link className="button secondary" to="/batches">
          View batches
        </Link>
      </Heading>
      <ErrorBox message={q.error} />
      {device && (
        <section className="active-batch-hero">
          <div>
            <small>{active ? "ACTIVE BATCH" : "TEMPERATURE CONTROLLER"}</small>
            <h2>{active?.name || device.name}</h2>
            <p>
              {device.name}
              {active?.data.created
                ? " · Started " + date(active.data.created)
                : " · No active batch"}
            </p>
            <div className="hero-values">
              <span>
                <strong>
                  {temp(device.data.last_values?.beer_temp)} °{preferences.unit}
                </strong>
                <small>Beer temperature</small>
              </span>
              <span>
                <strong>
                  {temperature(
                    activeTarget(device).value,
                    activeTarget(device).unit,
                    preferences.unit,
                  )?.toFixed(1) ?? "—"}{" "}
                  °{preferences.unit}
                </strong>
                <small>Confirmed target</small>
              </span>
              {sensor ? (
                <span>
                  <strong>
                    {density(
                      sensor.data.last_values?.gravity,
                      preferences.gravity_unit,
                    )?.toFixed(preferences.gravity_unit === "SG" ? 3 : 1) ??
                      "—"}
                  </strong>
                  <small>
                    {preferences.gravity_unit} ·{" "}
                    {typeof sensor.data.last_values?.gravity === "number"
                      ? "selected source"
                      : "waiting for a valid reading"}
                  </small>
                </span>
              ) : (
                <span>
                  <strong>—</strong>
                  <small>
                    {preferences.gravity_unit} · No gravity sensor linked
                  </small>
                </span>
              )}
            </div>
            <OperatingStatus device={device} />
          </div>
          <Link
            className="button"
            to={
              active
                ? "/batches/" + encodeURIComponent(active.id)
                : "/devices/" + encodeURIComponent(device.id)
            }
          >
            {active ? "Open batch" : "Open controller"}
            <ChevronRight size={16} />
          </Link>
        </section>
      )}
      <div className="section-title">
        <h2>Equipment</h2>
        <Link to="/devices">
          View all equipment <ChevronRight size={16} />
        </Link>
      </div>
      {devices.length || sensors.length ? (
        <div className="overview-equipment">
          {devices.map((d) => (
            <Link
              className="card device-card"
              key={d.id}
              to={"/devices/" + encodeURIComponent(d.id)}
            >
              <div className="equipment-card-title">
                <Refrigerator size={24} />
                <h2>{d.name}</h2>
                <Status device={d} />
              </div>
              <div className="readings">
                <div>
                  <small>BEER TEMPERATURE</small>
                  <strong>
                    {temperature(
                      d.data.last_values?.beer_temp,
                      d.data.last_values?.temp_format || d.data.unit || "C",
                      preferences.unit,
                    )?.toFixed(1) ?? "—"}
                    <em> °{preferences.unit}</em>
                  </strong>
                </div>
                <TargetReading device={d} />
              </div>
              <OperatingStatus device={d} />
            </Link>
          ))}
          {sensors.map((s) => (
            <Link
              className="card"
              key={s.id}
              to={"/sensors/" + encodeURIComponent(s.id)}
            >
              <div className="equipment-card-title">
                <Gauge size={24} />
                <h2>{s.name}</h2>
              </div>
              <div className="readings">
                <div>
                  <small>SPECIFIC GRAVITY</small>
                  <strong>
                    {density(
                      s.data.last_values?.gravity,
                      preferences.gravity_unit,
                    )?.toFixed(preferences.gravity_unit === "SG" ? 3 : 1) ??
                      "—"}
                  </strong>
                </div>
                <div>
                  <small>LAST READING</small>
                  <p>{date(s.data.last_seen)}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <Empty title="Connect your first controller">
          <Link to="/devices">Add equipment</Link> or{" "}
          <Link to="/import">import existing history</Link>.
        </Empty>
      )}
      <div className="overview-bottom">
        <section className="card chart-card">
          <div className="section-title">
            <h2>Temperature history</h2>
            <span className="muted">Updates every 30 seconds</span>
          </div>
          {points.length ? (
            <Suspense fallback={<Loading />}>
              <Chart points={points} />
            </Suspense>
          ) : (
            <Empty title="Waiting for measurements" />
          )}
        </section>
        <ActivityList notes={notes} onAdd={() => setNote(true)} />
      </div>
      <div className="section-title">
        <h2>Recent batches</h2>
        <Link to="/batches">View history</Link>
      </div>
      {batches.length ? (
        <EntityRows
          entities={newestFirst(batches).slice(0, 5)}
          kind="batches"
        />
      ) : (
        <Empty title="Your history starts here" />
      )}
      <p className="workspace-counts">
        {overview.measurements.toLocaleString("en-GB")} measurements ·{" "}
        {batches.length} batches · {sensors.length} sensors
      </p>
      {newBatch && <BatchStart close={() => setNewBatch(false)} />}
      {note && (
        <Editor
          kind="notes"
          entity={{
            id: "",
            kind: "notes",
            name: "",
            data: {
              ...(active ? { batch: active.id } : {}),
              created: new Date().toISOString(),
            },
          }}
          close={() => setNote(false)}
          saved={() => {
            setNote(false);
            q.refresh();
          }}
        />
      )}
    </>
  );
}
function TargetReading({ device }: { device: Entity }) {
  const preferences = usePreferences();
  const target = activeTarget(device);
  return (
    <div aria-label="Current target temperature">
      <small>
        TARGET TEMPERATURE
        {target.mode === "f"
          ? " · CHAMBER"
          : target.mode === "b"
            ? "· BEER"
            : ""}
      </small>
      <strong>
        {temperature(target.value, target.unit, preferences.unit)?.toFixed(1) ??
          "—"}
        <em> °{preferences.unit}</em>
      </strong>
    </div>
  );
}
function OperatingStatus({ device }: { device: Entity }) {
  const state = operatingState(device);
  return (
    <span
      role="status"
      aria-label="Operating state"
      className={"status operating " + state.tone}
    >
      {state.label}
    </span>
  );
}
function Status({ device }: { device: Entity }) {
  const age = Date.now() - Number(device.data.last_seen || 0),
    online =
      device.data.collection_enabled && age < 120000 && !device.data.last_error;
  return (
    <span className={"status " + (online ? "online" : "")}>
      <span className="dot" />
      {online
        ? "Connected"
        : device.data.last_seen
          ? "Stale reading"
          : "Disconnected"}
    </span>
  );
}
function date(v: any) {
  return formatDate(v);
}

function Loading() {
  return (
    <div className="loading" role="status">
      <RefreshCw className="spin" size={22} />
      <span>Loading your workspace…</span>
      <div className="skeleton-layout" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
function EntityRows({ entities, kind }: { entities: Entity[]; kind: string }) {
  usePreferences();
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>{kind === "devices" ? "Connection" : "Status / type"}</th>
            <th>Updated / created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {entities.map((e) => (
            <tr key={e.id}>
              <td>
                <Link to={"/" + kind + "/" + encodeURIComponent(e.id)}>
                  {kind === "notes" ? controllerEvent(e.name) : e.name}
                </Link>
              </td>
              <td>
                {kind === "devices" ? (
                  <Status device={e} />
                ) : kind === "batches" ? (
                  batchStatus(e)
                ) : (
                  e.data.status || e.data.sensor_type || e.data.type || "—"
                )}
              </td>
              <td>{date(e.data.last_seen || e.data.created)}</td>
              <td>
                <Link
                  aria-label={"Open " + e.name}
                  to={"/" + kind + "/" + encodeURIComponent(e.id)}
                >
                  <ChevronRight size={18} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Collection({ kind }: { kind: string }) {
  const q = useLoad(() => list(kind), [kind]);
  const sensorQuery = useLoad(
    () => (kind === "devices" ? list("sensors") : Promise.resolve([])),
    [kind],
  );
  const [group, setGroup] = useState("All"),
    [choose, setChoose] = useState(false),
    [createKind, setCreateKind] = useState(kind);
  const [search, setSearch] = useState(""),
    [edit, setEdit] = useState(false);
  if (kind === "profiles" && edit)
    return (
      <Editor
        kind={kind}
        close={() => setEdit(false)}
        saved={() => {
          setEdit(false);
          q.refresh();
        }}
      />
    );
  const rows = newestFirst(q.data || []).filter(
    (e) =>
      e.name.toLowerCase().includes(search.toLowerCase()) &&
      ((group === "All" &&
        (kind !== "batches" || e.data.status !== "archived")) ||
        (group === "Archived" && e.data.status === "archived") ||
        (group === "Active" && e.data.status === "active") ||
        (group === "Imported history" && !e.data.status) ||
        (group === "Finished" &&
          ["completed", "archived"].includes(e.data.status))),
  );
  return (
    <>
      <Heading
        title={names[kind]}
        subtitle={description[kind] || "Your saved records."}
      >
        <Button
          onClick={() => (kind === "devices" ? setChoose(true) : setEdit(true))}
        >
          <Plus size={16} />
          Add
        </Button>
      </Heading>
      {kind === "integrations" && (
        <div className="alert">
          Enable both the destination and server exports before sending data.
          Preview the payload before enabling delivery.
        </div>
      )}
      {kind === "batches" && (
        <Tabs
          items={["All", "Active", "Finished", "Imported history", "Archived"]}
          value={group}
          onChange={setGroup}
        />
      )}
      <div className="toolbar">
        <div className="search">
          <Search size={16} />
          <input
            aria-label="Search"
            placeholder="Search by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button className="secondary" onClick={q.refresh}>
          <RefreshCw size={15} />
          Refresh
        </Button>
      </div>
      <ErrorBox message={q.error} />
      {q.loading ? (
        <Loading />
      ) : kind === "devices" ? (
        <EquipmentCards
          devices={rows}
          sensors={(sensorQuery.data || []).filter((e) =>
            e.name.toLowerCase().includes(search.toLowerCase()),
          )}
        />
      ) : rows.length ? (
        kind === "profiles" || kind === "integrations" ? (
          <div className="library-cards">
            {rows.map((e) => (
              <section className="card library-card" key={e.id}>
                <div>
                  <span className="eyebrow">
                    {kind === "profiles"
                      ? "TEMPERATURE SCHEDULE"
                      : e.data.enabled
                        ? "ENABLED"
                        : "DISABLED"}
                  </span>
                  <Link to={"/" + kind + "/" + encodeURIComponent(e.id)}>
                    <h2>{e.name}</h2>
                  </Link>
                  <p className="muted">
                    {kind === "profiles"
                      ? e.data.steps?.length
                        ? `${e.data.steps.length} steps · ${e.data.steps.some((s: any) => s.until) ? "Gravity-controlled timing" : duration(e.data.steps.reduce((a: number, v: any) => a + v.hours, 0))} · ${e.data.unit || "C"}`
                        : "Imported schedule · review original steps"
                      : e.data.type || "External service"}
                  </p>
                  <p>{e.data.description}</p>
                </div>
                <Link
                  className="button secondary"
                  to={"/" + kind + "/" + encodeURIComponent(e.id)}
                >
                  {kind === "profiles" ? "Open profile" : "Configure"}
                  <ChevronRight size={16} />
                </Link>
              </section>
            ))}
          </div>
        ) : (
          <EntityRows entities={rows} kind={kind} />
        )
      ) : (
        <Empty title={search ? "No results" : "Nothing here yet"} />
      )}
      <div className="related">
        {kind === "sensors" && (
          <>
            <Link to="/gravity_logs">Gravity logs</Link>
            <Link to="/calibrations">Calibrations</Link>
          </>
        )}
        {kind === "batches" && <Link to="/notes">All notes</Link>}
      </div>
      {choose && (
        <Modal title="Add equipment" onClose={() => setChoose(false)}>
          <p>Choose what you want to connect.</p>
          <div className="equipment-choices">
            {[
              [
                "devices",
                "BrewPi controller",
                "TCP or serial temperature control",
              ],
              ["sensors", "Gravity sensor", "iSpindel or manual measurements"],
            ].map(([value, title, sub]) => (
              <button
                className="secondary"
                key={value}
                onClick={() => {
                  setCreateKind(value);
                  setChoose(false);
                  setEdit(true);
                }}
              >
                <strong>{title}</strong>
                <small>{sub}</small>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {edit && kind === "batches" ? (
        <BatchStart
          close={() => {
            setEdit(false);
            q.refresh();
          }}
        />
      ) : (
        edit &&
        (createKind === "integrations" ? (
          <IntegrationSetup close={() => setEdit(false)} saved={q.refresh} />
        ) : ["devices", "sensors"].includes(createKind) ? (
          <EquipmentSetup
            kind={createKind}
            close={() => setEdit(false)}
            saved={() => {
              q.refresh();
              sensorQuery.refresh();
            }}
          />
        ) : (
          <Editor
            kind={createKind}
            close={() => setEdit(false)}
            saved={() => {
              setEdit(false);
              q.refresh();
              sensorQuery.refresh();
            }}
          />
        ))
      )}
    </>
  );
}
type Field = { key: string; label: string; type?: string; options?: string[] };
const fields: Record<string, Field[]> = {
  devices: [
    { key: "host", label: "Host / IP address" },
    { key: "port", label: "TCP port", type: "number" },
    { key: "unit", label: "Temperature unit", options: ["C", "F"] },
    {
      key: "connection_type",
      label: "Connection",
      options: ["wifi", "serial"],
    },
    { key: "serial_port", label: "Serial port" },
    {
      key: "collection_enabled",
      label: "Enable collection for this controller",
      type: "checkbox",
    },
  ],
  sensors: [
    {
      key: "sensor_type",
      label: "Sensor type",
      options: ["manual", "tilt", "ispindel", "tiltbridge"],
    },
    { key: "device", label: "Temperature controller", type: "device" },
    { key: "unit", label: "Temperature unit", options: ["C", "F"] },
    {
      key: "collection_enabled",
      label: "Enable readings for this sensor",
      type: "checkbox",
    },
    { key: "constant_term", label: "iSpindel constant term", type: "number" },
    {
      key: "first_degree_coefficient",
      label: "iSpindel first-degree coefficient",
      type: "number",
    },
    {
      key: "second_degree_coefficient",
      label: "iSpindel second-degree coefficient",
      type: "number",
    },
    {
      key: "third_degree_coefficient",
      label: "iSpindel third-degree coefficient",
      type: "number",
    },
  ],
  batches: [
    { key: "device", label: "Temperature controller", type: "device" },
    { key: "sensor", label: "Gravity sensor", type: "sensor" },
    {
      key: "original_gravity",
      label: "Original gravity SG · optional",
      type: "number",
    },
    {
      key: "status",
      label: "Status",
      options: ["planned", "active", "completed", "archived"],
    },
    { key: "unit", label: "Temperature unit", options: ["C", "F"] },
    { key: "description", label: "Description", type: "textarea" },
  ],
  notes: [
    { key: "batch", label: "Batch", type: "batch" },
    { key: "text", label: "Note", type: "textarea" },
  ],
  profiles: [{ key: "description", label: "Description", type: "textarea" }],
  integrations: [
    {
      key: "type",
      label: "Service",
      options: [
        "brewfather",
        "brewersfriend",
        "grainfather",
        "thingspeak",
        "generic",
      ],
    },
    { key: "source", label: "Data source", type: "source" },
    { key: "url", label: "HTTPS endpoint" },
    { key: "api_key", label: "API key", type: "password" },
    {
      key: "enabled",
      label: "Enable delivery to this destination",
      type: "checkbox",
    },
    { key: "interval", label: "Interval (minutes)", type: "number" },
  ],
  calibrations: [
    { key: "sensor", label: "Sensors", type: "sensor" },
    { key: "kind", label: "Measurement", options: ["gravity", "temperature"] },
    { key: "slope", label: "Linear coefficient", type: "number" },
    { key: "offset", label: "Constant offset", type: "number" },
    {
      key: "enabled",
      label: "Use for new manual readings",
      type: "checkbox",
    },
  ],
  gravity_logs: [
    { key: "device", label: "Sensors", type: "sensor" },
    { key: "unit", label: "Temperature unit", options: ["C", "F"] },
  ],
};
function Editor({
  kind,
  entity,
  close,
  saved,
}: {
  kind: string;
  entity?: Entity;
  close: () => void;
  saved: () => void;
}) {
  const [name, setName] = useState(entity?.name || ""),
    [data, setData] = useState<Record<string, any>>({
      ...{
        created: new Date().toISOString(),
        unit: "C",
        port: 23,
        status: "planned",
        interval: 15,
        collection_enabled: false,
      },
      ...(kind === "sensors" ? { sensor_type: "manual" } : {}),
      ...(kind === "batches" ? { status: "active" } : {}),
      ...(kind === "devices" ? { connection_type: "wifi" } : {}),
      ...(kind === "calibrations"
        ? { kind: "gravity", slope: 1, offset: 0, enabled: false }
        : {}),
      ...(kind === "integrations"
        ? { type: "brewfather", enabled: false }
        : {}),
      ...entity?.data,
    }),
    [steps, setSteps] = useState<any[]>(
      (entity && profileSteps(entity.data).length
        ? profileSteps(entity.data)
        : undefined) ||
        (kind === "profiles"
          ? [
              {
                name: "Primary fermentation",
                hours: 168,
                temperature: 18.5,
                transition: "hold",
              },
            ]
          : []),
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const refs = useLoad(() =>
    Promise.all([list("devices"), list("batches"), list("sensors")]),
  );
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (kind !== "profiles" && e.key === "Tab") {
        const root = document.querySelector('[data-editor-dialog="true"]');
        const ds = document.querySelectorAll(
          '[role="dialog"],[role="alertdialog"]',
        );
        if (ds[ds.length - 1] !== root) return;
        const els = [
          ...(root?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
          ) || []),
        ].filter((n) => n.getClientRects().length);
        const first = els[0],
          last = els.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
      if (e.key === "Escape" && !document.querySelector('[role="alertdialog"]'))
        close();
    }
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  const set = (k: string, v: any) => setData((d) => ({ ...d, [k]: v }));
  if (
    kind === "profiles" &&
    entity?.data.legacy_steps?.length &&
    !profileSteps(entity.data).length
  )
    return (
      <section className="card">
        <h2>{entity.name}</h2>
        <p>
          This imported profile uses time anchors that cannot be converted
          without changing its behavior. Its original schedule is preserved and
          can still run. Create a new profile to use the step editor.
        </p>
        <button onClick={close}>Back to profile</button>
      </section>
    );
  if (kind === "profiles")
    return (
      <section className="profile-page-editor" aria-label="Profile editor">
        <div className="profile-editor-heading">
          <div>
            <Link
              className="back-link"
              to="/profiles"
              onClick={(e) => {
                e.preventDefault();
                close();
              }}
            >
              <ArrowLeft size={16} />
              Profiles
            </Link>
            <h1>{entity?.id ? entity.name : "New profile"}</h1>
          </div>
          <div className="actions">
            <button type="button" className="secondary" onClick={close}>
              Cancel
            </button>
            <button form="profile-editor-form" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save profile"}
            </button>
          </div>
        </div>
        <form
          id="profile-editor-form"
          onSubmit={async (ev) => {
            ev.preventDefault();
            setBusy(true);
            setError("");
            try {
              if (
                entity?.data.legacy_steps?.length &&
                !entity.data.steps?.length &&
                !profileSteps(entity.data).length
              )
                throw new Error(
                  "This imported schedule uses time anchors that cannot be converted automatically. Its original schedule is preserved; create a new profile to replace it explicitly.",
                );
              if (
                !steps.length ||
                steps.some(
                  (s) =>
                    !Number.isFinite(s.hours) ||
                    s.hours <= 0 ||
                    !Number.isFinite(s.temperature),
                )
              )
                throw new Error(
                  "Every step needs a valid temperature and positive duration.",
                );
              await save("profiles", name, { ...data, steps }, entity?.id);
              saved();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <ErrorBox message={error} />
          {!!entity?.data.legacy_steps?.length && (
            <p className="alert">
              {profileSteps(entity.data).length
                ? "Imported timing and temperatures are shown as editable holds and ramps. Saving updates this profile."
                : "Original time anchors are preserved. Automatic conversion is unavailable for this schedule; use a new profile for changes."}
            </p>
          )}
          <ProfileBuilder
            steps={steps}
            onChange={(next) =>
              setSteps(
                next.map((s, i) =>
                  i === 0 ? { ...s, transition: "hold" } : s,
                ),
              )
            }
            unit={data.unit || "C"}
            endBehavior={data.end_behavior || "hold"}
            gravityFields={
              <div className="profile-gravity-source">
                <h4>Gravity readings</h4>
                <p className="muted">
                  Shared by all gravity steps in this profile.
                </p>{" "}
                <label>
                  Use readings from
                  <select
                    aria-label="Profile reading source"
                    value={data.gravity_readings || ""}
                    required
                    onChange={(e) =>
                      setData({
                        ...data,
                        gravity_readings: e.target.value,
                        gravity_sensor:
                          e.target.value !== "ispindel" ||
                          refs.data?.[2]?.find(
                            (s: Entity) => s.id === data.gravity_sensor,
                          )?.data.sensor_type === "ispindel"
                            ? data.gravity_sensor
                            : "",
                      })
                    }
                  >
                    <option value="">Choose a reading source</option>
                    <option value="manual">Manual measurements</option>
                    <option value="ispindel">iSpindel</option>
                  </select>
                </label>
                <label>
                  Gravity sensor
                  <select
                    aria-label="Profile gravity sensor"
                    required
                    value={data.gravity_sensor || ""}
                    onChange={(e) => set("gravity_sensor", e.target.value)}
                  >
                    <option value="">Choose a sensor</option>
                    {refs.data?.[2]
                      ?.filter(
                        (s: Entity) =>
                          data.gravity_readings !== "ispindel" ||
                          s.data.sensor_type === "ispindel",
                      )
                      .map((s: Entity) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
            }
            gravityRules={
              <>
                {" "}
                <p className="muted">
                  {data.gravity_readings === "manual"
                    ? "A new manual measurement can confirm an SG threshold immediately. Stable SG needs at least two measurements covering the chosen period. The latest must be less than 24 hours old."
                    : "Uses the sensor’s selected SG calculation. At least 3 readings over 10 minutes must confirm the condition. Gaps over 30 minutes reset confirmation; stale readings never trigger a change."}
                </p>
              </>
            }
            header={
              <section className="card profile-identity">
                <h2>Profile details</h2>
                <label>
                  Profile name
                  <input
                    aria-label="Name"
                    required
                    maxLength={255}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label>
                  Control temperature
                  <select
                    value={data.control_sensor || "beer"}
                    onChange={(e) => set("control_sensor", e.target.value)}
                  >
                    <option value="beer">Beer temperature</option>
                    <option value="chamber">Chamber temperature</option>
                  </select>
                </label>
                <details>
                  <summary>Description</summary>
                  <textarea
                    aria-label="Description"
                    value={data.description || ""}
                    onChange={(e) => set("description", e.target.value)}
                  />
                </details>
              </section>
            }
            footer={
              <section className="card profile-completion">
                <h2>When the profile ends</h2>
                <label className="radio-choice">
                  <input
                    type="radio"
                    name="completion"
                    checked={data.end_behavior !== "off"}
                    onChange={() => set("end_behavior", "hold")}
                  />
                  <span>
                    Keep the last target
                    <small>Continue holding the final temperature.</small>
                  </span>
                </label>
                <label className="radio-choice">
                  <input
                    type="radio"
                    name="completion"
                    checked={data.end_behavior === "off"}
                    onChange={() => set("end_behavior", "off")}
                  />
                  <span>
                    Turn temperature control off
                    <small>
                      Switch the controller to Off after the last step.
                    </small>
                  </span>
                </label>
                <p className="muted">
                  Saving creates a reusable template. Start it separately when
                  your equipment is ready.
                </p>
              </section>
            }
          />
        </form>
      </section>
    );
  return (
    <div
      className={kind === "profiles" ? "profile-page-editor" : "modal-backdrop"}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className={kind === "profiles" ? "modal profile-modal" : "modal"}
        role={kind === "profiles" ? "region" : "dialog"}
        data-editor-dialog="true"
        aria-modal={kind === "profiles" ? undefined : true}
        aria-label={(entity?.id ? "Edit " : "Add") + names[kind]}
      >
        <div className="modal-heading">
          <h2>
            {entity?.id ? "Edit" : "Add"} · {names[kind]}
          </h2>
          <Button className="icon secondary" aria-label="Close" onClick={close}>
            <X size={19} />
          </Button>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              if (
                kind === "profiles" &&
                (!steps.length ||
                  steps.some((s) => !Number.isFinite(s.hours) || s.hours <= 0))
              )
                throw new Error(
                  "Every profile step needs a positive duration.",
                );
              await save(
                kind,
                name,
                {
                  ...data,
                  ...(kind === "profiles" ? { steps } : {}),
                  ...(kind === "integrations" && !entity
                    ? { enabled: !!data.enabled }
                    : {}),
                },
                entity?.id,
              );
              saved();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Name
            <input
              required
              maxLength={255}
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {kind === "sensors" && isTilt(data.sensor_type) && (
            <TiltFields type={data.sensor_type} data={data} set={set} />
          )}
          {(fields[kind] || [])
            .filter((f) => kind !== "batches" || f.key !== "status")
            .filter(
              (f) =>
                kind !== "sensors" ||
                (!f.key.includes("coefficient") && f.key !== "constant_term"),
            )
            .filter(
              (f) =>
                kind !== "devices" ||
                (data.connection_type === "serial"
                  ? !["host", "port"].includes(f.key)
                  : f.key !== "serial_port"),
            )
            .map((f) => (
              <label
                key={f.key}
                className={f.type === "checkbox" ? "checkbox" : ""}
              >
                {f.type === "checkbox" ? (
                  <>
                    <input
                      type="checkbox"
                      checked={!!data[f.key]}
                      onChange={(e) => set(f.key, e.target.checked)}
                    />
                    {f.label}
                  </>
                ) : (
                  <>
                    {f.label}
                    {f.type === "textarea" ? (
                      <textarea
                        value={data[f.key] || ""}
                        onChange={(e) => set(f.key, e.target.value)}
                      />
                    ) : ["device", "sensor", "batch", "source"].includes(
                        f.type || "",
                      ) ? (
                      <select
                        value={data[f.key] || ""}
                        onChange={(e) => set(f.key, e.target.value)}
                      >
                        <option value="">None</option>
                        {(f.type === "source"
                          ? [
                              ...(refs.data?.[0] || []),
                              ...(refs.data?.[2] || []),
                            ]
                          : refs.data?.[
                              { device: 0, batch: 1, sensor: 2 }[
                                f.type as "device"
                              ] ?? 0
                            ] || []
                        ).map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                          </option>
                        ))}
                      </select>
                    ) : f.options ? (
                      <select
                        value={data[f.key] || f.options[0]}
                        onChange={(e) => set(f.key, e.target.value)}
                      >
                        {f.options.map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={f.type || "text"}
                        step="any"
                        value={data[f.key] ?? ""}
                        onChange={(e) =>
                          set(
                            f.key,
                            f.type === "number"
                              ? e.target.value === ""
                                ? null
                                : Number(e.target.value)
                              : e.target.value,
                          )
                        }
                      />
                    )}
                  </>
                )}
              </label>
            ))}
          {kind === "devices" && (
            <div className="alert">
              Enable collection on the server to connect this controller.
              Control is enabled separately.
            </div>
          )}
          {kind === "calibrations" && (
            <div className="alert">
              Enabled linear calibrations apply to new manual readings. Imported
              iSpindel coefficients are used for incoming sensor packets.
            </div>
          )}
          {kind === "profiles" && (
            <>
              <div className="profile-options">
                <label>
                  Control temperature
                  <select
                    value={data.control_sensor || "beer"}
                    onChange={(e) => set("control_sensor", e.target.value)}
                  >
                    <option value="beer">Beer temperature</option>
                    <option value="chamber">Chamber temperature</option>
                  </select>
                </label>
                <label>
                  When the profile ends
                  <select
                    value={data.end_behavior || "hold"}
                    onChange={(e) => set("end_behavior", e.target.value)}
                  >
                    <option value="hold">Keep the last target</option>
                    <option value="off">Turn temperature control off</option>
                  </select>
                </label>
              </div>
              <ProfileBuilder
                steps={steps}
                onChange={(next) =>
                  setSteps(
                    next.map((s, i) =>
                      i === 0 ? { ...s, transition: "hold" } : s,
                    ),
                  )
                }
                unit={data.unit || "C"}
                endBehavior={data.end_behavior || "hold"}
              />
            </>
          )}
          <ErrorBox message={error} />
          <div className="form-actions">
            <Button type="button" className="secondary" onClick={close}>
              Cancel
            </Button>
            <Button disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
          </div>
        </form>
      </section>
    </div>
  );
}
function Detail({ kind, view }: { kind: string; view?: string }) {
  usePreferences();
  const { id } = useParams(),
    navigate = useNavigate();
  const q = useLoad(
    () =>
      Promise.all([
        api<Entity>("/resources/" + kind + "/" + encodeURIComponent(id!)),
        api<any[]>("/measurements/" + encodeURIComponent(id!)),
        list("notes"),
        list("devices"),
        list("sensors"),
      ]),
    [kind, id],
    ["batches", "devices", "gravity_logs", "sensors"].includes(kind)
      ? 30000
      : 0,
  );
  const [edit, setEdit] = useState(false),
    [note, setNote] = useState(false),
    [error, setError] = useState(""),
    [period, setPeriod] = useState(
      ["devices", "sensors"].includes(kind) ? 1 : 0,
    ),
    [tab, setTab] = useState("Fermentation"),
    [manual, setManual] = useState(false),
    [finishing, setFinishing] = useState(false),
    [starting, setStarting] = useState(false),
    [assign, setAssign] = useState(false),
    [linkingSensor, setLinkingSensor] = useState(false),
    [sensorChoice, setSensorChoice] = useState("");
  const pendingManualSensor = useRef<Entity | null>(null);
  if (q.loading) return <Loading />;
  if (q.error && !q.data) return <ErrorBox message={q.error} />;
  const [e, points, notes, devices, sensors] = q.data!;
  if (kind === "profiles" && edit)
    return (
      <Editor
        kind={kind}
        entity={e}
        close={() => setEdit(false)}
        saved={() => {
          setEdit(false);
          q.refresh();
        }}
      />
    );
  const controller =
    kind === "devices"
      ? e
      : kind === "batches"
        ? devices.find((d) => d.id === e.data.device)
        : undefined;
  const canControl =
    kind === "devices" || (kind === "batches" && e.data.status === "active");
  const batchNotes = notes.filter((n) => n.data.batch === id);
  const batchSensor = sensors.find((s) => s.id === e.data.sensor);
  const detailBody =
    kind === "batches" || kind === "devices" || kind === "sensors";
  const referenced = [...devices, ...sensors];
  const ps = period
    ? points.filter((p) => p.time > Date.now() - period * 86400000)
    : points;
  return (
    <>
      <Link className="back-link" to={"/" + kind}>
        <ArrowLeft size={15} />
        {names[kind]}
      </Link>
      <Heading
        title={
          view === "pins"
            ? "Temperature probes & outputs"
            : view === "calibration"
              ? "iSpindel calibration"
              : kind === "notes"
                ? controllerEvent(e.name)
                : e.name
        }
        subtitle={
          view === "calibration"
            ? e.name
            : kind === "devices"
              ? "Connection, control and current readings."
              : kind === "batches"
                ? batchStatus(e) +
                  " · Measurements, notes and temperature history."
                : "Your saved records."
        }
      >
        {kind === "profiles" && (
          <button onClick={() => setAssign(true)}>Use this profile</button>
        )}
        {kind === "sensors" && e.data.sensor_type === "ispindel" && !view && (
          <Link
            className="button"
            to={"/sensors/" + encodeURIComponent(e.id) + "/calibration"}
          >
            Calibrate sensor
          </Link>
        )}
        {kind === "devices" && !view && (
          <Link
            className="button secondary"
            to={"/devices/" + encodeURIComponent(e.id) + "/pins"}
          >
            Temperature probes & outputs
          </Link>
        )}
        <Button className="secondary" onClick={() => setEdit(true)}>
          Edit
        </Button>
        <Button className="secondary" onClick={q.refresh}>
          <RefreshCw size={15} />
        </Button>
      </Heading>
      <ErrorBox message={error} />
      <ErrorBox message={q.error} />
      {kind === "sensors" && isTilt(e.data.sensor_type) && <TiltNotice />}
      {view === "connect" && (
        <EquipmentSetup
          kind={kind}
          initial={e}
          saved={q.reload}
          close={() => navigate("/" + kind + "/" + encodeURIComponent(e.id))}
        />
      )}
      {kind === "batches" && (
        <>
          <Tabs
            items={["Fermentation", "Readings", "Notes"]}
            value={tab}
            onChange={setTab}
          />
          <div className="batch-quick-actions">
            {e.data.status === "planned" && (
              <button onClick={() => setStarting(true)}>Start batch</button>
            )}
            {e.data.status === "active" && (
              <button
                onClick={() =>
                  batchSensor ? setManual(true) : setLinkingSensor(true)
                }
              >
                Add reading
              </button>
            )}
            <button className="secondary" onClick={() => setNote(true)}>
              Add note
            </button>
            {e.data.status === "active" && (
              <button className="secondary" onClick={() => setFinishing(true)}>
                Finish batch
              </button>
            )}
          </div>
        </>
      )}
      {kind === "sensors" && !e.data.last_seen && (
        <div className="alert">
          Waiting for the first reading.{" "}
          <a href="#sensor-tools">Open sensor tools</a> and choose Connection to
          configure delivery, or Manual reading to record a measurement.
        </div>
      )}
      {starting && (
        <BatchStart
          initial={e}
          close={() => {
            setStarting(false);
            q.refresh();
          }}
        />
      )}
      {detailBody && !view && (
        <Metrics
          entity={e}
          points={points}
          device={canControl ? controller : undefined}
        />
      )}
      {kind === "notes" && (
        <section className="card">
          <small>{date(e.data.created)}</small>
          <p className="note-body">{controllerEvent(e.data.text || "")}</p>
          {e.data.batch && (
            <Link to={"/batches/" + encodeURIComponent(e.data.batch)}>
              Open batch
            </Link>
          )}
        </section>
      )}
      <div
        className={detailBody && !view ? "detail-workspace" : "detail-standard"}
      >
        {controller && canControl && !view && tab === "Fermentation" && (
          <aside className="detail-rail">
            <ToolPanel
              title="Temperature control"
              action="Change target"
              summary={
                <>
                  <OperatingStatus device={controller} />
                  <div className="rail-target">
                    <TargetReading device={controller} />
                  </div>
                </>
              }
            >
              <Control device={controller} />
            </ToolPanel>
            <ProfileAssignment device={controller} refresh={q.refresh} />
            <Link
              className="connection-link"
              to={"/devices/" + encodeURIComponent(controller.id)}
            >
              Open controller · {controller.name}
            </Link>
          </aside>
        )}
        {["batches", "devices", "gravity_logs", "sensors"].includes(kind) &&
          !view &&
          tab !== "Notes" && (
            <section className="card chart-card">
              <div className="section-title">
                <h2>Measurements</h2>
                <select
                  aria-label="Time period"
                  value={period}
                  onChange={(e) => setPeriod(Number(e.target.value))}
                >
                  <option value={0}>All history</option>
                  <option value={7}>Last 7 days</option>
                  <option value={1}>Last 24 hours</option>
                </select>
              </div>
              {kind === "devices" && (
                <div className="chart-live-status">
                  <span>Controller status</span>
                  <OperatingStatus device={e} />
                </div>
              )}
              {ps.length ? (
                <Suspense fallback={<Loading />}>
                  <Chart
                    points={ps}
                    gravityOnly={
                      kind === "sensors" && isTilt(e.data.sensor_type)
                    }
                  />
                </Suspense>
              ) : (
                <Empty title="No readings in this period">
                  {kind === "sensors"
                    ? "Connect your sensor to receive measurements, or add a manual reading below."
                    : "Choose another time range to explore recorded measurements."}
                </Empty>
              )}
              <p className="muted">
                {points.length.toLocaleString("en-GB")} displayed points. Large
                series are sampled on retrieval. Refreshes every 30 seconds.
              </p>
            </section>
          )}
        {kind === "devices" && view === "pins" && (
          <PinConfiguration device={e} />
        )}
        {kind === "sensors" && (
          <div id="sensor-tools" className="sensor-tools-workspace">
            <SensorTools
              sensor={e}
              refresh={q.reload}
              focus={
                view === "calibration"
                  ? "calibration"
                  : view === "connection"
                    ? "connection"
                    : undefined
              }
            />
          </div>
        )}{" "}
        {kind === "integrations" && <ExportPreview entity={e} />}{" "}
        {kind === "profiles" && (
          <section className="card">
            <h2>Temperature schedule</h2>
            {profileSteps(e.data).length ? (
              <div className="profile-detail-layout">
                <ProfileSummary
                  steps={profileSteps(e.data)}
                  unit={e.data.unit || "C"}
                />
                <ProfileBuilder
                  steps={profileSteps(e.data)}
                  onChange={() => {}}
                  unit={e.data.unit || "C"}
                  endBehavior={e.data.end_behavior || "hold"}
                  readOnly
                />
              </div>
            ) : (
              <Empty title="No steps yet" />
            )}
            {!!e.data.legacy_steps?.length && (
              <>
                <h3>Preserved original steps</h3>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Elapsed hours</th>
                        <th>Temperature</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.data.legacy_steps.map((step: any, i: number) => (
                        <tr key={i}>
                          <td>{(Number(step.ttl) / 3600000000).toFixed(2)}</td>
                          <td>
                            {step.temperature_setting} °
                            {step.temp_format || e.data.unit || "C"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <div className="alert">
              Start a saved profile from its controller when collection and
              control are enabled. Imported schedules are preserved.
            </div>
          </section>
        )}
        {kind === "batches" && (
          <ActivityList
            notes={tab === "Notes" ? batchNotes : batchNotes.slice(-3)}
            all={tab === "Notes"}
            onAdd={() => setNote(true)}
          />
        )}
        {kind === "batches" && tab === "Readings" && (
          <MeasurementHistory points={ps} />
        )}
      </div>
      {linkingSensor && (
        <Modal
          title="Link a gravity sensor"
          onClose={() => setLinkingSensor(false)}
        >
          <p>
            Choose which sensor should log gravity readings with this batch.
          </p>
          <label>
            Gravity sensor
            <select
              value={sensorChoice}
              onChange={(ev) => setSensorChoice(ev.target.value)}
            >
              <option value="">Choose a sensor</option>
              {sensors.map((sensor) => (
                <option value={sensor.id} key={sensor.id}>
                  {sensor.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="secondary"
            onClick={async () => {
              try {
                const sensor =
                  pendingManualSensor.current ||
                  (await save("sensors", e.name + " · manual readings", {
                    sensor_type: "manual",
                    unit: e.data.unit || "C",
                    collection_enabled: false,
                  }));
                pendingManualSensor.current = sensor;
                await save(
                  "batches",
                  e.name,
                  { ...e.data, sensor: sensor.id },
                  e.id,
                );
                await q.reload();
                pendingManualSensor.current = null;
                setLinkingSensor(false);
                setManual(true);
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            Use manual measurements for this batch
          </button>
          <ErrorBox message={error} />
          <div className="form-actions">
            <button
              className="secondary"
              onClick={() => setLinkingSensor(false)}
            >
              Cancel
            </button>
            <button
              disabled={!sensorChoice}
              onClick={async () => {
                try {
                  await save(
                    "batches",
                    e.name,
                    { ...e.data, sensor: sensorChoice },
                    e.id,
                  );
                  q.reload();
                  setLinkingSensor(false);
                  setManual(true);
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              Link sensor
            </button>
          </div>
        </Modal>
      )}
      {manual && batchSensor && (
        <Modal title="Add gravity reading" onClose={() => setManual(false)}>
          <SensorTools
            sensor={batchSensor}
            refresh={q.reload}
            focus="reading"
          />
        </Modal>
      )}
      {assign && (
        <ChooseProfileController
          profile={e}
          devices={devices}
          onClose={() => setAssign(false)}
          refresh={q.refresh}
        />
      )}
      {finishing && (
        <FinishBatch
          batch={e}
          device={controller}
          onClose={() => setFinishing(false)}
          saved={() => {
            setFinishing(false);
            q.refresh();
          }}
        />
      )}
      <details className="card resource-information">
        <summary>Details & settings</summary>
        <dl>
          {Object.entries(e.data)
            .filter(
              ([k, v]) =>
                [
                  "created",
                  "device",
                  "unit",
                  "status",
                  "description",
                  "host",
                  "port",
                  "collection_enabled",
                  "sensor_type",
                  "last_seen",
                  "interval",
                  "type",
                  "source",
                  "board_type",
                  "serial_port",
                  "logging_status",
                  "temp_format",
                ].includes(k) && typeof v !== "object",
            )
            .map(([k, v]) => (
              <React.Fragment key={k}>
                <dt>{labels[k] || k.replaceAll("_", " ")}</dt>
                <dd>
                  {typeof v === "boolean"
                    ? v
                      ? "Yes"
                      : "No"
                    : k === "created" || k === "last_seen"
                      ? date(v)
                      : referenced.find((r) => r.id === v)?.name ||
                        String(v ?? "—")}
                </dd>
              </React.Fragment>
            ))}
        </dl>
      </details>
      {kind === "devices" && <ProtocolLog device={e.id} />}
      <div className="danger-zone">
        {kind === "batches" && e.data.status === "completed" && (
          <Button
            className="secondary"
            onClick={async () => {
              if (
                !(await confirmAction(
                  "Archive" + e.name + "? History is preserved.",
                ))
              )
                return;
              try {
                await save(
                  kind,
                  e.name,
                  { ...e.data, status: "archived" },
                  e.id,
                );
                q.refresh();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Archive
          </Button>
        )}
        {kind === "batches" && e.data.status === "archived" && (
          <Button
            className="secondary"
            onClick={async () => {
              try {
                await save(
                  kind,
                  e.name,
                  { ...e.data, status: "completed" },
                  e.id,
                );
                q.reload();
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            Unarchive batch
          </Button>
        )}
        {kind === "batches" && e.data.status === "active" && (
          <p className="muted">
            Finish this batch before deleting it. Deleting a record does not
            stop temperature control.
          </p>
        )}
        <Button
          className="danger"
          disabled={kind === "batches" && e.data.status === "active"}
          onClick={async () => {
            if (
              !(await confirmAction(
                "Delete" +
                  e.name +
                  "? This cannot be undone. Records with history or references cannot be deleted.",
              ))
            )
              return;
            try {
              await api(
                "/resources/" + kind + "/" + encodeURIComponent(e.id),
                "DELETE",
              );
              navigate("/" + kind);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Delete
        </Button>
      </div>
      {edit &&
        (kind === "integrations" ? (
          <IntegrationSetup
            initial={e}
            close={() => setEdit(false)}
            saved={q.reload}
          />
        ) : ["devices", "sensors"].includes(kind) ? (
          <EquipmentSetup
            kind={kind}
            initial={e}
            close={() => setEdit(false)}
            saved={q.reload}
          />
        ) : (
          <Editor
            kind={kind}
            entity={e}
            close={() => setEdit(false)}
            saved={() => {
              setEdit(false);
              q.refresh();
            }}
          />
        ))}
      {note && (
        <Editor
          kind="notes"
          entity={{
            id: "",
            kind: "notes",
            name: "",
            data: { batch: id, created: new Date().toISOString() },
          }}
          close={() => setNote(false)}
          saved={() => {
            setNote(false);
            q.refresh();
          }}
        />
      )}
    </>
  );
}
function FinishBatch({
  batch,
  device,
  onClose,
  saved,
}: {
  batch: Entity;
  device?: Entity;
  onClose: () => void;
  saved: () => void;
}) {
  const [gravity, setGravity] = useState(batch.data.final_gravity ?? ""),
    [note, setNote] = useState(batch.data.tasting_notes ?? ""),
    [error, setError] = useState("");
  const q = useLoad(() => api("/diagnostics"));
  const [after, setAfter] = useState("keep"),
    [target, setTarget] = useState("18"),
    [busy, setBusy] = useState(false),
    [applied, setApplied] = useState(false);
  const canChange =
    !!device &&
    device.data.control_claimed &&
    device.data.collection_enabled &&
    q.data?.control_enabled;
  return (
    <Modal
      title="Finish batch"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (ev) => {
          ev.preventDefault();
          setBusy(true);
          setError("");
          try {
            if (after !== "keep" && !applied) {
              if (!canChange)
                throw Error("The temperature controller is not ready.");
              await api(
                "/devices/" + encodeURIComponent(device!.id) + "/command",
                "POST",
                {
                  mode: after,
                  temperature: after === "o" ? null : Number(target),
                  confirm_ownership: true,
                },
              );
              setApplied(true);
            }
            await save(
              "batches",
              batch.name,
              {
                ...batch.data,
                status: "completed",
                finished_at: new Date().toISOString(),
                final_gravity: gravity === "" ? null : Number(gravity),
                tasting_notes: note,
              },
              batch.id,
            );
            saved();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>Finish {batch.name} and retain its measurements and notes.</p>
        <label>
          Final gravity SG · optional
          <input
            type="number"
            min="0.5"
            max="2"
            step="0.001"
            value={gravity}
            onChange={(e) => setGravity(e.target.value)}
          />
        </label>
        <label>
          Tasting notes · optional
          <textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <label>
          Temperature control after this batch
          <select
            value={after}
            disabled={busy || applied}
            onChange={(e) => setAfter(e.target.value)}
          >
            <option value="keep">
              Keep current temperature control and profile
            </option>
            <option value="o" disabled={!canChange}>
              Stop temperature control
            </option>
            <option value="f" disabled={!canChange}>
              Hold a fixed chamber temperature
            </option>
            <option value="b" disabled={!canChange}>
              Hold a fixed beer temperature
            </option>
          </select>
        </label>
        {after !== "keep" && after !== "o" && (
          <label>
            Target temperature °{device?.data.unit || "C"}
            <input
              type="number"
              step="0.1"
              required
              value={target}
              disabled={busy || applied}
              onChange={(e) => setTarget(e.target.value)}
            />
          </label>
        )}

        <div className="alert">
          {after === "keep"
            ? "Only the batch log ends. Temperature control and any running profile continue."
            : "The current profile will be cancelled and the selected temperature change must be confirmed by the controller before this batch is finished."}
        </div>
        {applied && (
          <p role="status">
            Temperature change confirmed. If saving fails, retry finishes the
            batch without repeating the command.
          </p>
        )}
        {!canChange && device && (
          <a
            href={"/devices/" + encodeURIComponent(device.id)}
            target="_blank"
            rel="noreferrer"
          >
            Review controller readiness in a new tab
          </a>
        )}
        <ErrorBox message={error} />
        <div className="form-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Keep fermenting
          </button>
          <button disabled={busy || (after !== "keep" && !canChange)}>
            {busy ? "Finishing…" : "Finish batch"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
const labels: Record<string, string> = {
  device: "Linked controller",
  unit: "Temperature unit",
  status: "Status",
  created: "Created",
  description: "Description",
  host: "Host",
  port: "Port",
  collection_enabled: "Collection enabled",
  control_claimed: "Controller ownership",
  sensor_type: "Sensor type",
  last_seen: "Last seen",
  source: "Data source",
  type: "Type",
  interval: "Interval (minutes)",
  board_type: "Board model",
  serial_port: "Serial port",
  logging_status: "Logging",
  temp_format: "Original unit",
};
function Control({ device }: { device: Entity }) {
  const q = useLoad(() => api("/diagnostics"));
  const target = activeTarget(device);
  const [mode, setMode] = useState(target.mode || "b"),
    [temp, setTemp] = useState(
      temperature(target.value, target.unit, device.data.unit || "C") ?? 18.5,
    ),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <section className="card control-form">
      <h2>Temperature control</h2>
      <div className="readings">
        <TargetReading device={device} />
      </div>
      {!q.data?.control_enabled ? (
        <p className="muted">Temperature control is disabled on this server.</p>
      ) : (
        <form
          onSubmit={async (ev) => {
            ev.preventDefault();
            if (
              !(await confirmAction(
                (mode === "o"
                  ? "Stop temperature control"
                  : `Hold ${mode === "b" ? "beer" : "chamber"} at ${temp} °${device.data.unit || "C"}`) +
                  " on " +
                  device.name +
                  "?" +
                  (device.data.profile
                    ? " This cancels the assigned profile."
                    : ""),
              ))
            )
              return;
            setBusy(true);
            setMessage("");
            try {
              await save(
                "devices",
                device.name,
                {
                  ...(
                    await api<Entity>(
                      "/resources/devices/" + encodeURIComponent(device.id),
                    )
                  ).data,
                  control_claimed: true,
                  ...(!device.data.control_claimed && device.data.profile
                    ? { profile: null, profile_started: null }
                    : {}),
                },
                device.id,
              );
              await api(
                "/devices/" + encodeURIComponent(device.id) + "/command",
                "POST",
                { mode, temperature: temp, confirm_ownership: true },
              );
              setMessage("The controller confirmed the command.");
            } catch (e) {
              setMessage((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Control mode
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="b">Beer temperature</option>
              <option value="f">Chamber temperature</option>
              <option value="o">Off</option>
            </select>
          </label>
          {mode !== "o" && (
            <label>
              Target temperature °{device.data.unit || "C"}
              <input
                type="number"
                step="0.1"
                required
                value={temp}
                onChange={(e) => setTemp(Number(e.target.value))}
              />
            </label>
          )}
          {device.data.profile && (
            <p className="alert">
              Applying manual settings cancels the assigned fermentation
              profile.
            </p>
          )}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setMode("o")}
          >
            Stop temperature control
          </button>

          <Button disabled={busy}>
            {busy ? "Waiting for confirmation…" : "Apply temperature settings"}
          </Button>
          <p role="status">{message}</p>
        </form>
      )}
    </section>
  );
}
function Import() {
  const [database, setDatabase] = useState("source.sqlite"),
    [data, setData] = useState("data"),
    [report, setReport] = useState<any>(null),
    [accepted, setAccepted] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function run(apply: boolean) {
    setBusy(true);
    setError("");
    try {
      setReport(
        await api("/import", "POST", {
          database,
          data,
          apply,
          digest: report?.digest,
          accept_warnings: accepted,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Heading
        title="Import Fermentrack data"
        subtitle="Import a consistent copy of your existing data. The source files remain unchanged."
      />
      <section className="card">
        <h2>Administrator preparation</h2>
        <p>
          This import reads server-local files; it does not upload files from
          your browser.
        </p>
        <ol>
          <li>
            Create a consistent copy of the old database and its history files.
          </li>
          <li>
            Ask the server administrator to place that copy in the configured
            import directory.
          </li>
          <li>
            Enter the relative paths below, preview, and review any warnings
            before importing.
          </li>
        </ol>
        <p>
          The original files stay available. After import, connect equipment
          deliberately; importing does not activate collection or temperature
          control.
        </p>
      </section>
      <div className="two-column">
        <section className="card">
          <h2>1. Choose source</h2>
          <p className="muted">
            Place a consistent database snapshot and history directory in the
            configured import folder, then enter their relative paths.
          </p>
          <label>
            Database snapshot
            <input
              value={database}
              onChange={(e) => {
                setDatabase(e.target.value);
                setReport(null);
              }}
            />
          </label>
          <label>
            History directory
            <input
              value={data}
              onChange={(e) => {
                setData(e.target.value);
                setReport(null);
              }}
            />
          </label>
          <ErrorBox message={error} />
          <Button disabled={busy} onClick={() => run(false)}>
            <Search size={16} />
            {busy ? "Analyzing…" : "Preview"}
          </Button>
        </section>
        <section className="card">
          <h2>2. Review and import</h2>
          {!report ? (
            <Empty title="Preview first">
              No data is written until you confirm the import.
            </Empty>
          ) : (
            <>
              <dl>
                {report.by_kind && (
                  <>
                    <dt>Record types</dt>
                    <dd>
                      {Object.entries(report.by_kind).map(([kind, count]) => (
                        <span className="report-count" key={kind}>
                          {names[kind] || kind}: {String(count)}
                        </span>
                      ))}
                    </dd>
                  </>
                )}
                <dt>Records</dt>
                <dd>{report.entities}</dd>
                <dt>Measurements</dt>
                <dd>{report.points}</dd>
                <dt>History files</dt>
                <dd>{report.files}</dd>
              </dl>
              {report.warnings?.map((w: string, i: number) => (
                <div className="alert" key={i}>
                  {w}
                </div>
              ))}
              {!!report.warnings?.length && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(e) => setAccepted(e.target.checked)}
                  />
                  I have reviewed the warnings and retained the source files.
                </label>
              )}
              {report.written_points !== undefined ||
              report.already_imported ? (
                <div className="alert success">
                  {report.already_imported
                    ? "Source already imported."
                    : "Import complete."}{" "}
                  No controllers or exports were enabled.
                </div>
              ) : (
                <Button
                  disabled={busy || (!!report.warnings?.length && !accepted)}
                  onClick={async () => {
                    if (await confirmAction("Import the reviewed data?"))
                      run(true);
                  }}
                >
                  <Upload size={16} />
                  Import reviewed data
                </Button>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
function Backup() {
  const [file, setFile] = useState<File | null>(null),
    [report, setReport] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function upload(confirmRestore: boolean) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(
        "/api/v1/restore.sqlite?confirm=" +
          confirmRestore +
          (confirmRestore ? "&digest=" + report.digest : ""),
        {
          method: "POST",
          headers: { "Content-Type": "application/vnd.sqlite3" },
          body: file,
        },
      );
      const out = await r.json();
      if (!r.ok) throw new Error(out.error);
      setReport(out);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Heading
        title="Keep your history."
        subtitle="Keep a recoverable copy of your workspace."
      />
      <div className="two-column">
        <section className="card">
          <ShieldCheck size={30} />
          <h2>Create a backup</h2>
          <p>
            Includes all records and measurements. Accounts, sessions and
            command logs are excluded. Store the file privately because it may
            contain integration settings.
          </p>
          <a href="/api/v1/backup.sqlite" className="button" download>
            <Download size={16} />
            Download backup
          </a>
        </section>
        <section className="card">
          <h2>Restore backup</h2>
          <p>
            Analyze the backup first. Confirming replaces current history and
            settings while retaining your signed-in account.
          </p>
          <label>
            Backup file
            <input
              type="file"
              accept=".sqlite,application/vnd.sqlite3"
              onChange={(e) => {
                setFile(e.target.files?.[0] || null);
                setReport(null);
                setError("");
              }}
            />
          </label>
          <ErrorBox message={error} />
          {file && (
            <Button
              className="secondary"
              disabled={busy}
              onClick={() => upload(false)}
            >
              {busy ? "Analyzing backup…" : "Analyze backup"}
            </Button>
          )}
          {report && (
            <>
              <p>
                Selected backup: {file?.name}. This replaces current records and
                measurements; the signed-in account is retained.
              </p>
              {report.sample_names && (
                <p>
                  Recognizable records:{" "}
                  {report.sample_names.join(", ") || "No named records"}
                </p>
              )}
              {report.first_measurement && (
                <p>
                  Measurement range: {date(report.first_measurement)} –{" "}
                  {date(report.last_measurement)}
                </p>
              )}
              <p>
                {report.entities} records ·{" "}
                {Number(report.points).toLocaleString("en-GB")} measurements
              </p>
              {report.restored ? (
                <div className="alert success">
                  Restore complete. Collection, exports and controller ownership
                  are disabled.
                  <ol>
                    <li>
                      <Link to="/devices">
                        Review temperature controllers and gravity sensors
                      </Link>
                      , then reconnect them one at a time.
                    </li>
                    <li>Confirm fresh readings before setting a target.</li>
                    <li>
                      <Link to="/integrations">
                        Review and reactivate destinations
                      </Link>{" "}
                      only when their sources are ready.
                    </li>
                  </ol>
                </div>
              ) : (
                <Button
                  className="danger"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await confirmAction(
                        "Replace current data with the reviewed backup?",
                        "RESTORE",
                      )
                    )
                      upload(true);
                  }}
                >
                  {busy ? "Restoring…" : "Confirm restore"}
                </Button>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
function SettingsPage({ internalAuth }: { internalAuth: boolean }) {
  const q = useLoad(() => list("settings"));
  const [data, setData] = useState<any>({
      unit: "C",
      gravity_unit: "SG",
      timezone: "Europe/Stockholm",
      date_format: "YYYY-MM-DD",
      theme: "light",
    }),
    [message, setMessage] = useState("");
  useEffect(() => {
    if (q.data?.[0]) setData({ ...defaults, ...q.data[0].data });
  }, [q.data]);
  return (
    <>
      <Heading
        title="Your fermentation workspace."
        subtitle="Preferences and access for this workspace."
      />
      <div className="settings-workspace">
        <section className="card preferences-panel">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setMessage("");
              try {
                await save("settings", "Settings", data, q.data?.[0]?.id);
                q.refresh();
                window.dispatchEvent(
                  new CustomEvent("preferences-changed", { detail: data }),
                );
                setMessage("Preferences saved.");
              } catch (e) {
                setMessage((e as Error).message);
              }
            }}
          >
            {[
              ["unit", "Temperature unit", ["C", "F"]],
              ["gravity_unit", "Gravity display", ["SG", "Plato"]],
              [
                "timezone",
                "Time zone",
                Array.from(
                  new Set([
                    "Europe/Stockholm",
                    "UTC",
                    data.timezone,
                    ...((Intl as any).supportedValuesOf?.("timeZone") || []),
                  ]),
                ),
              ],
              [
                "date_format",
                "Date format",
                ["YYYY-MM-DD", "DD/MM/YYYY", "DD.MM.YYYY", "MM/DD/YYYY"],
              ],
              ["theme", "Appearance", ["light", "dark", "system"]],
            ].map(([key, label, options]: any) => (
              <label key={key}>
                {label}
                <select
                  aria-label={label}
                  value={data[key]}
                  onChange={(e) => setData({ ...data, [key]: e.target.value })}
                >
                  {options.map((o: string) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </label>
            ))}
            <p className="muted">
              Date preview:{" "}
              {formatDate("2026-11-12T18:04:05Z", { ...defaults, ...data })}
            </p>
            <div className="alert">
              Display units do not change stored measurements. Control targets
              and profiles use their configured temperature units.
            </div>
            <Button>Save preferences</Button>
            <p role="status">{message}</p>
          </form>
          {internalAuth ? (
            <PasswordChange />
          ) : (
            <p className="muted">
              Sign-in is managed by your identity provider.
            </p>
          )}
        </section>
        <WorkspaceLinks />
      </div>
    </>
  );
}
function Diagnostics() {
  const q = useLoad(() => api("/diagnostics"));
  return (
    <>
      <Heading title="Diagnostics" subtitle="Service and connection health.">
        <Button className="secondary" onClick={q.refresh}>
          <RefreshCw size={16} />
          Refresh
        </Button>
      </Heading>
      <ErrorBox message={q.error} />
      <Troubleshooting />
      {q.loading ? (
        <Loading />
      ) : (
        <details className="card">
          <summary>Technical server details</summary>
          <dl>
            {Object.entries(q.data || {}).map(([k, v]) => (
              <React.Fragment key={k}>
                <dt>{k.replaceAll("_", " ")}</dt>
                <dd>
                  {typeof v === "boolean" ? (v ? "Enabled" : "Off") : String(v)}
                </dd>
              </React.Fragment>
            ))}
          </dl>
        </details>
      )}
    </>
  );
}
function App() {
  return (
    <>
      <ConfirmationHost />
      <AppContent />
    </>
  );
}
function AppContent() {
  const q = useLoad(() => api("/auth/status"));
  useEffect(() => {
    window.addEventListener("session-expired", q.refresh);
    return () => window.removeEventListener("session-expired", q.refresh);
  }, [q.refresh]);
  if (q.loading) return <Loading />;
  if (q.error)
    return (
      <main className="content">
        <ErrorBox message={q.error} />
        <Button onClick={q.refresh}>Try again</Button>
      </main>
    );
  return q.data.authenticated ? (
    <PreferencesProvider>
      <BrowserRouter>
        <Shell
          onLogout={q.refresh}
          internalAuth={q.data.internal_auth !== false}
        />
      </BrowserRouter>
    </PreferencesProvider>
  ) : (
    <Auth configured={q.data.configured} onDone={q.refresh} />
  );
}
createRoot(document.getElementById("root")!).render(<App />);
function ExportPreview({ entity }: { entity: Entity }) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState("");
  return (
    <section className="card">
      <h2>Preview export</h2>
      <p>
        Preview does not contact the destination. The selected reading must be
        less than one hour old.
      </p>
      <ErrorBox message={error} />
      <Button
        className="secondary"
        onClick={async () => {
          setError("");
          try {
            setData(
              await api(
                "/integrations/" + encodeURIComponent(entity.id) + "/preview",
              ),
            );
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Show message
      </Button>
      {data && (
        <details open>
          <summary>Local payload preview · no delivery</summary>
          <pre>
            {JSON.stringify(
              data,
              (key, value) =>
                ["api_key", "token"].includes(key) ? "[hidden]" : value,
              2,
            )}
          </pre>
        </details>
      )}
      {entity.data.last_error && <ErrorBox message={entity.data.last_error} />}
      <p className="muted">
        Last attempt: {date(entity.data.last_attempt)} · Last successful:{" "}
        {date(entity.data.last_success)}
      </p>
    </section>
  );
}

function ChooseProfileController({
  profile,
  devices,
  onClose,
  refresh,
}: {
  profile: Entity;
  devices: Entity[];
  onClose: () => void;
  refresh: () => void;
}) {
  const [id, setId] = useState(""),
    [review, setReview] = useState(false);
  const d = devices.find((d) => d.id === id);
  if (review && d)
    return (
      <ProfileAssignment
        device={d}
        refresh={refresh}
        initialProfile={profile.id}
        initialOpen
        onClose={onClose}
      />
    );
  return (
    <Modal title="Choose a controller" onClose={onClose}>
      <p>Start {profile.name} on your selected controller.</p>
      <label>
        Controller
        <select
          aria-label="Controller"
          value={id}
          onChange={(e) => setId(e.target.value)}
        >
          <option value="">Choose equipment</option>
          {devices.map((d) => (
            <option value={d.id} key={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      {!devices.length && <p>Add a controller before starting a profile.</p>}
      <div className="form-actions">
        <button className="secondary" onClick={onClose}>
          Cancel
        </button>
        <button disabled={!d} onClick={() => setReview(true)}>
          Review &amp; start
        </button>
      </div>
    </Modal>
  );
}
function ProfileAssignment({
  device,
  refresh,
  initialProfile,
  initialOpen = false,
  onClose,
}: {
  device: Entity;
  refresh: () => void;
  initialProfile?: string;
  initialOpen?: boolean;
  onClose?: () => void;
}) {
  const q = useLoad(() => Promise.all([list("profiles"), api("/diagnostics")]));
  const [id, setId] = useState(initialProfile || device.data.profile || ""),
    [open, setOpen] = useState(initialOpen),
    [startAt, setStartAt] = useState(""),
    [error, setError] = useState("");
  if (!q.data?.[1].control_enabled) return null;
  const template = q.data?.[0]?.find(
    (p: Entity) => p.id === device.data.profile,
  );
  const current =
    template && device.data.profile_run?.profile
      ? { ...template, data: device.data.profile_run.profile }
      : template;
  if (!open)
    return (
      <section className="card profile-panel">
        <h2>{current?.name || "Fermentation profile"}</h2>
        {current ? (
          <>
            <p className="muted">
              {device.data.profile_started > Date.now()
                ? "Scheduled for " + date(device.data.profile_started)
                : device.data.profile_run
                  ? device.data.profile_run.status
                  : profileSteps(current.data).length > 0 &&
                      Date.now() >=
                        device.data.profile_started +
                          profileSteps(current.data).reduce(
                            (a: number, s: any) => a + s.hours,
                            0,
                          ) *
                            3600000
                    ? "Schedule complete · " +
                      (current.data.end_behavior === "off"
                        ? "Control off"
                        : "Holding final target")
                    : "Started " + date(device.data.profile_started)}
            </p>
            {device.data.profile_run?.last_transition?.evidence && (
              <p className="muted">
                Last step confirmed by{" "}
                {device.data.profile_run.last_transition.evidence
                  .reading_source === "manual"
                  ? "manual measurement"
                  : "iSpindel readings"}
                : SG {device.data.profile_run.last_transition.evidence.sg} ·{" "}
                {date(
                  device.data.profile_run.last_transition.evidence.latest_at,
                )}
              </p>
            )}
            <ProfileSummary
              steps={profileSteps(current.data)}
              started={device.data.profile_started}
              run={device.data.profile_run}
              unit={current.data.unit || "C"}
            />
          </>
        ) : (
          <p className="muted">
            Fixed temperature. Choose a saved schedule when you are ready.
          </p>
        )}
        <button className="secondary" onClick={() => setOpen(true)}>
          Choose a profile
        </button>
        {current && (
          <button
            className="secondary"
            onClick={async () => {
              if (
                !(await confirmAction(
                  "Stop this profile and keep the last confirmed temperature target? Temperature control continues.",
                ))
              )
                return;
              try {
                await api(
                  "/devices/" + encodeURIComponent(device.id) + "/profile",
                  "POST",
                  { profile: null, confirm_ownership: true },
                );
                refresh();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Stop profile · keep target
          </button>
        )}
        <ErrorBox message={error} />

        <Link className="profile-library-link" to="/profiles">
          Profile library
        </Link>
      </section>
    );
  return (
    <Modal
      title="Start a profile"
      onClose={() => {
        setOpen(false);
        onClose?.();
      }}
    >
      <section className="profile-review-content">
        <h2>Fermentation profile</h2>
        <p>
          The schedule resumes after a restart. Setting a manual target cancels
          the running profile.
        </p>
        <ErrorBox message={error} />
        <label>
          Profile
          <select value={id} onChange={(e) => setId(e.target.value)}>
            <option value="" disabled>
              Choose a profile
            </option>
            {q.data[0].map((p: Entity) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {id &&
          (() => {
            const profile = q.data[0].find((p: Entity) => p.id === id);
            return (
              profile && (
                <div className="alert">
                  <strong>Review before starting</strong>
                  <p>
                    {profile.name} ·{" "}
                    {profile.data.control_sensor === "chamber"
                      ? "Chamber temperature"
                      : "Beer temperature"}{" "}
                    · First target{" "}
                    {profile.data.steps?.[0]?.temperature ??
                      "From imported schedule"}{" "}
                    °{profile.data.unit || "C"}
                  </p>
                  <p>
                    {profile.data.steps?.some((s: any) => s.until) && (
                      <>
                        Gravity conditions use{" "}
                        {profile.data.gravity_readings === "manual"
                          ? "manual measurements"
                          : "confirmed iSpindel readings"}
                        . The next target waits for the condition.
                        <br />
                      </>
                    )}
                    After completion:{" "}
                    {profile.data.end_behavior === "off"
                      ? "Turn temperature control off"
                      : "Keep the last target"}
                    . Starting replaces the current target or running schedule.
                  </p>
                </div>
              )
            );
          })()}
        {id && (
          <>
            <label>
              Start time
              <select
                aria-label="Start time"
                value={startAt ? "later" : "now"}
                onChange={(e) =>
                  setStartAt(
                    e.target.value === "now"
                      ? ""
                      : new Date(Date.now() + 3600000)
                          .toLocaleString("sv-SE")
                          .replace(" ", "T")
                          .slice(0, 16),
                  )
                }
              >
                <option value="now">Immediately</option>
                <option value="later">Schedule for later</option>
              </select>
            </label>
            {startAt && (
              <label>
                Local start time
                <input
                  type="datetime-local"
                  required
                  value={startAt}
                  onChange={(e) => setStartAt(e.target.value)}
                />
                <small>
                  Time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone}
                </small>
              </label>
            )}
          </>
        )}
        {id && (
          <p className="alert">
            {device.data.profile
              ? "This replaces or restarts the assigned profile. "
              : ""}
            Starts {startAt ? date(new Date(startAt).getTime()) : "immediately"}{" "}
            on {device.name}.{" "}
            {q.data[0].find((p: Entity) => p.id === id)?.data.end_behavior ===
            "off"
              ? "Temperature control turns off at the end."
              : "The last target is held after the schedule ends."}
          </p>
        )}

        <Button
          disabled={!id}
          onClick={async () => {
            if (
              !(await confirmAction(
                id
                  ? "Start this profile from the beginning?"
                  : "Cancel the running profile?",
              ))
            )
              return;
            try {
              await api(
                "/devices/" + encodeURIComponent(device.id) + "/profile",
                "POST",
                {
                  profile: id || null,
                  confirm_ownership: true,
                  ...(id && startAt
                    ? { start_at: new Date(startAt).getTime() }
                    : {}),
                },
              );
              setOpen(false);
              onClose?.();
              refresh();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Start profile
        </Button>
        {device.data.profile_error && (
          <ErrorBox message={device.data.profile_error} />
        )}
      </section>
    </Modal>
  );
}

function PasswordChange() {
  const [oldPassword, setOld] = useState(""),
    [newPassword, setNew] = useState(""),
    [confirmPassword, setConfirm] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        if (newPassword !== confirmPassword) {
          setError("Passwords do not match.");
          return;
        }
        setBusy(true);
        try {
          await api("/auth/password", "POST", {
            old_password: oldPassword,
            new_password: newPassword,
          });
          window.dispatchEvent(new Event("session-expired"));
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>Change password</h2>
      <p>All your sessions will end after the change.</p>
      <label>
        Current password
        <input
          type="password"
          required
          autoComplete="current-password"
          value={oldPassword}
          onChange={(e) => setOld(e.target.value)}
        />
      </label>
      <label>
        New password
        <input
          type="password"
          required
          minLength={12}
          maxLength={256}
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNew(e.target.value)}
        />
      </label>
      <label>
        Confirm new password
        <input
          type="password"
          required
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </label>
      <ErrorBox message={error} />
      <Button disabled={busy}>
        {busy ? "Changing password…" : "Change password and sign out"}
      </Button>
    </form>
  );
}
