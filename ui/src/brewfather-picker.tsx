// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { formatDate } from "./preferences";
import { BrewfatherConnectionForm } from "./brewfather-connection";
export type BrewfatherPlan = {
  batch: {
    id: string;
    name: string;
    recipe: string;
    number: number | null;
    og: number | null;
    brew_date?: number;
    status: string;
  };
  candidate: {
    status: string;
    reason?: string;
    profile?: Record<string, any>;
    total_hours?: number;
    warnings?: string[];
  };
};
export default function BrewfatherPicker({
  selected,
  choose,
  cancel,
}: {
  selected: BrewfatherPlan | null;
  choose: (p: BrewfatherPlan | null) => void;
  cancel: () => void;
}) {
  const [connected, setConnected] = useState<boolean | null>(null),
    [rows, setRows] = useState<BrewfatherPlan["batch"][]>([]),
    [next, setNext] = useState<string | null>(null),
    [limit, setLimit] = useState(5),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => {
    let active = true;
    api("/brewfather/connection")
      .then((s) => {
        if (active) setConnected(s.connected);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      request.current++;
    };
  }, []);
  async function load(after?: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api(
        "/brewfather/batches" +
          (after ? "?after=" + encodeURIComponent(after) : ""),
      );
      setRows((old) => [
        ...new Map(
          [...(after ? old : []), ...result.batches].map((b) => [b.id, b]),
        ).values(),
      ]);
      setNext(result.next);
      if (after) setLimit((n) => n + 5);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (connected) void load();
  }, [connected]);
  async function select(id: string) {
    const token = ++request.current;
    setBusy(true);
    setError("");
    choose(null);
    try {
      const p = await api<BrewfatherPlan>(
        "/brewfather/batches/" + encodeURIComponent(id) + "/plan",
      );
      if (token === request.current) choose(p);
    } catch (e) {
      if (token === request.current) setError((e as Error).message);
    } finally {
      if (token === request.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Brewfather batches">
      <h3>
        {connected === false
          ? "Connect Brewfather"
          : "Which beer are you fermenting?"}
      </h3>
      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
      {connected === null && !error && (
        <p role="status">Checking connection…</p>
      )}
      {connected === null && error && (
        <button
          className="secondary"
          onClick={() => {
            setError("");
            api("/brewfather/connection")
              .then((s) => setConnected(s.connected))
              .catch((e) => setError(e.message));
          }}
        >
          Retry connection
        </button>
      )}
      {connected === false && (
        <>
          <p className="muted">Connect once. Your batch details stay here.</p>
          <BrewfatherConnectionForm
            onConnected={() => setConnected(true)}
            onCancel={cancel}
          />
        </>
      )}
      {connected && (
        <>
          <p className="muted">Recent batches · Newest brew date first</p>
          <div className="batch-choice-list">
            {rows.slice(0, limit).map((b) => (
              <button
                key={b.id}
                type="button"
                className="batch-choice"
                aria-pressed={selected?.batch.id === b.id}
                disabled={busy}
                onClick={() => void select(b.id)}
              >
                <strong>
                  {b.number != null ? `#${b.number} · ` : ""}
                  {b.name || b.recipe || "Unnamed batch"}
                </strong>
                <span>
                  {b.brew_date
                    ? formatDate(b.brew_date, undefined, false) + " · "
                    : ""}
                  {b.status}
                  {b.og != null
                    ? ` · OG ${b.og.toFixed(3)}`
                    : " · OG not recorded"}
                </span>
                <span>{b.recipe}</span>
              </button>
            ))}
          </div>
          {busy && <p role="status">Loading Brewfather…</p>}
          {!busy && !rows.length && !error && (
            <p>
              No Brewfather batches yet. You can use Manual or a YC profile
              instead.
            </p>
          )}
          {error && !busy && (
            <button className="secondary" onClick={() => void load()}>
              Retry
            </button>
          )}
          {(rows.length > limit || next) && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                rows.length > limit ? setLimit((n) => n + 5) : void load(next!)
              }
            >
              Show more batches
            </button>
          )}
          {selected?.candidate.status === "review_required" && (
            <p role="alert" className="alert">
              {selected.candidate.reason} Choose another batch or create a YC
              profile.
            </p>
          )}
          {selected?.candidate.warnings?.map((w) => (
            <p className="alert" key={w}>
              {w}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
