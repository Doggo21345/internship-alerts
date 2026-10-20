// fetch with a timeout, a User-Agent that says who we are, and JSON parsing.

const UA = "internship-alerts (+https://github.com/Doggo21345/internship-alerts)";

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} ${url}`);
    this.status = status;
  }
}

/** {url, method?, body?, etag?} -> parsed JSON, or {notModified: true, etag} on a 304. */
export async function fetchJson({ url, method = "GET", body, etag }, { timeoutMs = 20000 } = {}) {
  const headers = { "User-Agent": UA, Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (etag) headers["If-None-Match"] = etag;
  const res = await fetch(url, { method, body, headers, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 304) return { notModified: true, etag };
  if (!res.ok) throw new HttpError(res.status, url);
  const data = await res.json();
  if (etag !== undefined) return { data, etag: res.headers.get("etag") || "" };
  return data;
}
