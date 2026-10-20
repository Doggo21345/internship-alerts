#!/usr/bin/env node
// Builds data/boards.json, the list of boards every scan reads:
//   1. every Greenhouse/Lever/Ashby/SmartRecruiters/Workday board that
//      Simplify's internship listings link to,
//   2. data/extra-boards.txt,
//   3. YC companies marked hiring, found by trying their names as board slugs.
// Each board is read once; ones that no longer exist are dropped.
//
// node scripts/build-boards.mjs [--skip-yc] [--limit N]

import { readFile, writeFile } from "node:fs/promises";
import { parseBoardKey, parseBoardUrl, normalizeJobs, boardRequest, slugsFor } from "../lib/ats.js";
import { companyKey, companyTags } from "../lib/classify.js";
import { SIMPLIFY_URL, boardsFromListings } from "../lib/simplify.js";
import { fetchJson, HttpError } from "../lib/http.js";

const YC_URL = "https://yc-oss.github.io/api/companies/all.json";
const args = process.argv.slice(2);
const skipYc = args.includes("--skip-yc");
const limit = Number(args[args.indexOf("--limit") + 1]) || Infinity;

async function pool(items, n, fn) {
  let next = 0, done = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
      if (++done % 250 === 0) console.error(`  ${done}/${items.length}`);
    }
  }));
  return out;
}

/** "ok", "gone" (404/410/not a board), or "error" (try again next week). */
async function check(b) {
  try {
    const data = await fetchJson(boardRequest(b), { timeoutMs: 20000 });
    return normalizeJobs(b, data, { company: b.company }) ? "ok" : "gone";
  } catch (e) {
    return e instanceof HttpError && [400, 404, 410, 422].includes(e.status) ? "gone" : "error";
  }
}

const readJson = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
};

const previous = new Map((await readJson("data/boards.json", [])).map((b) => [b.key, b]));

console.error("Simplify listings...");
const listings = await fetchJson({ url: SIMPLIFY_URL }, { timeoutMs: 60000 });
const found = boardsFromListings(listings).map(({ listings: n, lastPosted, ...b }) => ({ ...b, from: "simplify" }));

const extra = (await readFile("data/extra-boards.txt", "utf8")).split("\n")
  .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  .map((l) => {
    const [where, name = ""] = l.split("|").map((s) => s.trim());
    const b = parseBoardKey(where) || parseBoardUrl(where.includes("//") ? where : `https://${where}`);
    if (!b) console.error(`  extra-boards.txt: can't read "${l}"`);
    return b && { ...b, company: name, from: "extra" };
  }).filter(Boolean);

const candidates = new Map();
for (const b of [...extra, ...found]) if (!candidates.has(b.key)) candidates.set(b.key, b);

let yc = [];
if (!skipYc) {
  console.error("YC directory...");
  yc = (await fetchJson({ url: YC_URL }, { timeoutMs: 60000 })).filter((c) => c.status === "Active");
}
const ycKeys = new Set(yc.map((c) => companyKey(c.name)));

const list = [...candidates.values()].slice(0, limit);
console.error(`Checking ${list.length} boards...`);
const results = await pool(list, 24, check);
const boards = [];
const dropped = [];
list.forEach((b, i) => {
  // A board that errored stays if it worked before: one bad week isn't "gone".
  if (results[i] === "ok" || (results[i] === "error" && previous.has(b.key)) || b.from === "extra") boards.push(b);
  else dropped.push(`${b.key} (${results[i]})`);
});

if (yc.length) {
  const covered = new Set(boards.map((b) => companyKey(b.company)));
  const hiring = yc.filter((c) => c.isHiring && !covered.has(companyKey(c.name))).slice(0, limit);
  console.error(`Looking for boards of ${hiring.length} hiring YC companies...`);
  const hits = await pool(hiring, 24, async (c) => {
    const slugs = [...new Set([c.slug, ...slugsFor(c.name)].filter(Boolean).map((s) => s.toLowerCase()))];
    for (const ats of ["ashby", "greenhouse", "lever"]) {
      for (const slug of slugs) {
        const b = parseBoardKey(`${ats}:${slug}`);
        if (b && (await check(b)) === "ok") return { ...b, company: c.name, from: "yc" };
      }
    }
    return null;
  });
  const keys = new Set(boards.map((b) => b.key));
  for (const h of hits) if (h && !keys.has(h.key)) { boards.push(h); keys.add(h.key); }
  console.error(`  found ${hits.filter(Boolean).length}`);
}

const out = boards
  .map((b) => {
    const tags = companyTags(b.company, { yc: ycKeys });
    if (b.from === "yc" && !tags.includes("YC Startup")) tags.push("YC Startup");
    const { from, ...rest } = b;
    return { ...rest, tags, from };
  })
  .sort((a, b) => a.key.localeCompare(b.key));

await writeFile("data/boards.json", "[\n" + out.map((b) => JSON.stringify(b)).join(",\n") + "\n]\n");
if (yc.length) await writeFile("data/companies.json", JSON.stringify({ yc: [...ycKeys].sort() }) + "\n");

const count = (f) => out.reduce((m, b) => ({ ...m, [f(b)]: (m[f(b)] || 0) + 1 }), {});
console.log(JSON.stringify({ boards: out.length, byAts: count((b) => b.ats), bySource: count((b) => b.from), dropped: dropped.length }, null, 1));
if (dropped.length) console.error(`Dropped:\n  ${dropped.slice(0, 50).join("\n  ")}${dropped.length > 50 ? "\n  ..." : ""}`);
