#!/usr/bin/env node
// One scan. Reads data/boards.json and the previous scan's out/state.json,
// writes the next out/state.json plus what sheets read:
//   out/new.json     postings first seen in the last few days (the alert feed)
//   out/open.json    every open internship we know of
//   out/companies.json  companies we cover, so sheets know which to look up themselves
//   out/status.json  how the scan went
//
// node scripts/scan.mjs [--limit N]

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { scan } from "../lib/scan.js";
import { companyTags, companyKey } from "../lib/classify.js";
import { SIMPLIFY_URL, simplifyJobs } from "../lib/simplify.js";
import { fetchJson } from "../lib/http.js";

const args = process.argv.slice(2);
const limit = Number(args[args.indexOf("--limit") + 1]) || Infinity;
const readJson = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
};

const boards = (await readJson("data/boards.json", [])).slice(0, limit);
const yc = new Set((await readJson("data/companies.json", { yc: [] })).yc);
const prev = await readJson("out/state.json", null);
const started = Date.now();

// Simplify's file is 13 MB; skip it when it hasn't changed since last scan.
let simplify;
try {
  const r = await fetchJson({ url: SIMPLIFY_URL, etag: prev?.simplifyEtag || "" }, { timeoutMs: 60000 });
  simplify = r.notModified
    ? { unchanged: true }
    : { ok: true, jobs: simplifyJobs(r.data, new Set(boards.map((b) => b.key))), etag: r.etag };
} catch (e) {
  simplify = { ok: false, error: String(e.message || e) };
}

const result = await scan(boards, prev, {
  fetchJson: (req) => fetchJson(req),
  now: started,
  extra: [{ key: "simplify", result: simplify, tagsFor: (company) => companyTags(company, { yc }) }]
});
result.state.simplifyEtag = simplify.etag ?? prev?.simplifyEtag ?? "";
result.status.seconds = Math.round((Date.now() - started) / 1000);

await mkdir("out", { recursive: true });
await writeFile("out/state.json", JSON.stringify(result.state));
await writeFile("out/new.json", JSON.stringify(result.feed));
await writeFile("out/open.json", JSON.stringify(result.open));
const companies = new Set([...boards.map((b) => b.company), ...result.open.jobs.map((j) => j.company)].map(companyKey).filter(Boolean));
await writeFile("out/companies.json", JSON.stringify({ generatedAt: started, companies: [...companies].sort() }));
await writeFile("out/status.json", JSON.stringify(result.status, null, 1));
console.log(JSON.stringify(result.status, null, 1));
