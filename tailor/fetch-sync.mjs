// Tailor.gs was written for Apps Script, where UrlFetchApp waits for each
// response. Node's fetch doesn't, so these run the requests in a child process
// and wait for it, which gives Tailor.gs the same blocking calls.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("./fetch-worker.mjs", import.meta.url));

/** [{url, method?, headers?, payload?, contentType?}] -> [{code, text}], fetched in parallel. */
export function fetchAllSync(requests) {
  if (!requests.length) return [];
  const res = spawnSync(process.execPath, [WORKER], {
    input: JSON.stringify(requests), maxBuffer: 256 * 1024 * 1024, timeout: 300000, encoding: "utf8"
  });
  if (res.status !== 0) throw new Error("fetch failed: " + (res.stderr || res.error?.message || "unknown").slice(0, 300));
  return JSON.parse(res.stdout);
}

/** Apps Script's UrlFetchApp, backed by `fetchAll` (fetchAllSync unless a test swaps it). */
export function urlFetchApp(fetchAll = fetchAllSync) {
  const response = ({ code, text }) => ({ getResponseCode: () => code, getContentText: () => text });
  const fetchAllFn = (reqs) => fetchAll(reqs).map(response);
  return {
    fetchAll: fetchAllFn,
    fetch: (url, params = {}) => fetchAllFn([{ ...params, url }])[0]
  };
}
