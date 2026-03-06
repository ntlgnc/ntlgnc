/** Client-side helper: fetch with admin Bearer token from sessionStorage. */
export function adminFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = typeof window !== "undefined" ? sessionStorage.getItem("fracmap_admin_token") || "" : "";
  return fetch(url, {
    ...opts,
    headers: {
      ...Object.fromEntries(new Headers(opts.headers || {}).entries()),
      Authorization: `Bearer ${token}`,
    },
  });
}
