#!/usr/bin/env node
// One scan. Reads data/boards.json and the previous scan's out/state.json,
// writes the next out/state.json plus what sheets read:
//   out/new.json     internships first seen in the last few days (the alert feed)
//   out/open.json    every open internship we know of
//   out/digest.json  the daily roundup: internships and new grad jobs from the
//                    last 24 hours, as newsletter HTML and a LinkedIn post
//   out/companies.json  companies we cover, so sheets know which to look up themselves
//   out/status.json  how the scan went
//
// node scripts/scan.mjs [--limit N]

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { scan } from "../lib/scan.js";
import { companyTags, companyKey } from "../lib/classify.js";
import { SIMPLIFY_URL, SIMPLIFY_NEW_GRAD_URL, simplifyJobs } from "../lib/simplify.js";
import { buildDigest } from "../lib/digest.js";
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

// Simplify's files are over 10 MB; skip one when it hasn't changed since last scan.
const etags = { simplify: prev?.simplifyEtag || "", ...prev?.etags };
async function readList(key, url, toJobs) {
  try {
    const r = await fetchJson({ url, etag: etags[key] || "" }, { timeoutMs: 60000 });
    return r.notModified ? { unchanged: true } : { ok: true, jobs: toJobs(r.data), etag: r.etag };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
const scanned = new Set(boards.map((b) => b.key));
const lists = {
  simplify: await readList("simplify", SIMPLIFY_URL, (data) => simplifyJobs(data, scanned)),
  // Not deduped against scanned boards: Workday and SmartRecruiters boards are
  // only searched for internships, and copies of the rest are merged anyway.
  "simplify-newgrad": await readList("simplify-newgrad", SIMPLIFY_NEW_GRAD_URL,
    (data) => simplifyJobs(data, new Set(), { level: "New Grad", idPrefix: "simplify-newgrad" }))
};

const tagsFor = (company) => companyTags(company, { yc });
const result = await scan(boards, prev, {
  fetchJson: (req) => fetchJson(req),
  now: started,
  extra: Object.entries(lists).map(([key, r]) => ({ key, result: r, tagsFor }))
});
result.state.etags = Object.fromEntries(Object.entries(lists).map(([k, r]) => [k, r.etag ?? etags[k] ?? ""]));
delete result.state.simplifyEtag;
result.status.seconds = Math.round((Date.now() - started) / 1000);

await mkdir("out", { recursive: true });
await writeFile("out/state.json", JSON.stringify(result.state));
// Sheets' alerts are for internships; new grad jobs only go in the digest.
const internshipsOnly = (f) => ({ ...f, jobs: f.jobs.filter((j) => j.level !== "New Grad") });
await writeFile("out/new.json", JSON.stringify(internshipsOnly(result.feed)));
await writeFile("out/open.json", JSON.stringify(internshipsOnly(result.open)));
const { internships, newGrad, ...digest } = buildDigest(result.feed.jobs, { now: started });
await writeFile("out/digest.json", JSON.stringify(digest));
const companies = new Set([...boards.map((b) => b.company), ...result.open.jobs.map((j) => j.company)].map(companyKey).filter(Boolean));
await writeFile("out/companies.json", JSON.stringify({ generatedAt: started, companies: [...companies].sort() }));
await writeFile("out/status.json", JSON.stringify(result.status, null, 1));
console.log(JSON.stringify(result.status, null, 1));
