import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function load(lastRun, now = Date.parse("2026-10-20T12:00:00Z")) {
  const posts = [];
  const ctx = {
    Date: class extends Date { static now() { return now; } },
    JSON,
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => "tok" }) },
    UrlFetchApp: {
      fetch(url, opts = {}) {
        if (opts.method === "post") { posts.push({ url, opts }); return { getResponseCode: () => 204, getContentText: () => "" }; }
        return { getContentText: () => JSON.stringify({ workflow_runs: lastRun ? [lastRun] : [] }) };
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("../apps-script/Kicker.gs", import.meta.url), "utf8"), ctx);
  return { ctx, posts, now };
}

test("starts a scan when the last one finished long enough ago", () => {
  const { ctx, posts } = load({ status: "completed", created_at: "2026-10-20T11:30:00Z" });
  ctx.kickScan();
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /actions\/workflows\/scan\.yml\/dispatches$/);
  assert.equal(posts[0].opts.headers.Authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(posts[0].opts.payload), { ref: "main" });
});

test("leaves a running or recent scan alone", () => {
  for (const run of [{ status: "in_progress", created_at: "2026-10-20T11:00:00Z" }, { status: "queued", created_at: "2026-10-20T11:00:00Z" },
    { status: "completed", created_at: "2026-10-20T11:50:00Z" }]) {
    const { ctx, posts } = load(run);
    ctx.kickScan();
    assert.equal(posts.length, 0, run.status);
  }
});
