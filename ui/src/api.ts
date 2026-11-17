// SPDX-License-Identifier: GPL-3.0-only
export type Entity = {
  id: string;
  kind: string;
  name: string;
  data: Record<string, any>;
};
export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const r = await fetch("/api/v1" + path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: r.statusText }));
    if (r.status === 401 && !path.startsWith("/auth/"))
      window.dispatchEvent(new Event("session-expired"));
    throw new Error(e.error || r.statusText);
  }
  return r.json();
}
export const list = (kind: string) => api<Entity[]>("/resources/" + kind);
export const save = (
  kind: string,
  name: string,
  data: Record<string, unknown>,
  id?: string,
) =>
  api<Entity>(
    "/resources/" + kind + (id ? "/" + encodeURIComponent(id) : ""),
    id ? "PUT" : "POST",
    { name, data },
  );
