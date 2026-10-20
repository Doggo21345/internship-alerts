// One scan: read every board, keep the internships, and work out which are new
// since the last scan. Pure apart from the injected fetchJson, so tests can run
// it against fixtures.

import { boardRequest, normalizeJobs, WORKDAY_PAGE } from "./ats.js";
import { isInternship, describe, companyKey } from "./classify.js";

const DAY = 864e5;
// A posting first seen now but dated older than this isn't news: it's a board
// we just added, or one that was down. It goes in the open list, not the feed.
export const FRESH_DAYS = 14;
// How far back the feed reaches. Sheets check every 15 minutes; this covers a
// sheet whose trigger was off for a couple of days.
export const FEED_DAYS = 3;
// Ids of closed postings are remembered this long, so a repost isn't news.
const FORGET_DAYS = 120;
// Workday lists newest first. Read a second page only when the whole first
// page is from the last two days, i.e. there may be more new ones below.
const WORKDAY_MAX_PAGES = 3;

/** Runs `fn` over `items`, at most `limit` at a time. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetchJson, waiting and retrying when told we're going too fast (HTTP 429). */
async function politeFetch(fetchJson, req, waits) {
  for (let i = 0; ; i++) {
    try {
      return await fetchJson(req);
    } catch (e) {
      if (e?.status !== 429 || i >= waits.length) throw e;
      await sleep(waits[i]);
    }
  }
}

/** One board -> {ok, jobs} (internships only). Never throws. */
export async function readBoard(b, { fetchJson, now, waits = [3000, 10000] }) {
  try {
    const jobs = [];
    for (let page = 0; page < (b.ats === "workday" ? WORKDAY_MAX_PAGES : 1); page++) {
      const data = await politeFetch(fetchJson, boardRequest(b, page), waits);
      const got = normalizeJobs(b, data, { company: b.company, now });
      if (!got) return { ok: false, error: "unexpected response" };
      jobs.push(...got);
      const recent = got.length === WORKDAY_PAGE && got.every((j) => j.postedAt >= now - 2 * DAY);
      if (!recent) break;
    }
    return { ok: true, jobs: jobs.filter((j) => isInternship(j.title)) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

const emptyState = () => ({ version: 1, boards: {}, seen: {}, open: {} });

/**
 * Folds one source's result into the state. A source that failed keeps its
 * previous jobs, so a board that's down for a scan doesn't make its postings
 * look new when it comes back. {unchanged: true} (an HTTP 304) keeps them too.
 */
export function applySource(state, key, result, { now, tags = [], tagsFor = null }) {
  const info = state.boards[key] || (state.boards[key] = { fails: 0 });
  if (result.unchanged) return 0;
  if (!result.ok) {
    info.fails = (info.fails || 0) + 1;
    info.error = result.error;
    return 0;
  }
  const known = Boolean(info.firstOk);
  info.firstOk = info.firstOk || now;
  info.lastOk = now;
  info.fails = 0;
  delete info.error;

  for (const id of Object.keys(state.open)) if (state.open[id].source === key) delete state.open[id];
  let added = 0;
  for (const job of result.jobs) {
    const id = job.id || `${key}:${job.jobId}`;
    const isNew = !state.seen[id];
    if (isNew) state.seen[id] = now;
    const prev = state.alerts?.[id];
    const alert = isNew ? known && (!job.postedAt || job.postedAt >= now - FRESH_DAYS * DAY) : Boolean(prev);
    const { jobId, ...rest } = job;
    state.open[id] = describe({
      ...rest,
      id,
      source: key,
      tags: tagsFor ? tagsFor(job.company) : tags,
      firstSeen: state.seen[id],
      alert
    });
    if (isNew && alert) added++;
  }
  return added;
}

/**
 * Companies often post one copy per city, and the same posting can come from
 * a board and from Simplify. Shows each once, with every location, dated by
 * its earliest sighting so a new city for an old posting isn't news.
 */
export function mergeCopies(jobs) {
  const groups = new Map();
  for (const j of [...jobs].sort((a, b) => a.firstSeen - b.firstSeen || a.id.localeCompare(b.id))) {
    const key = `${companyKey(j.company)}|${j.title.toLowerCase().replace(/\s+/g, " ").trim()}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { ...j, countries: [...j.countries] });
      continue;
    }
    if (j.location && !g.location.split(" · ").includes(j.location)) {
      g.location = [g.location, j.location].filter(Boolean).join(" · ");
    }
    for (const c of j.countries) if (!g.countries.includes(c)) g.countries.push(c);
    g.postedAt = Math.max(g.postedAt || 0, j.postedAt || 0);
  }
  return [...groups.values()];
}

/**
 * Scans all boards plus any extra sources ({key, result, tagsFor}) and returns
 * the next state, the feed of new postings, everything open, and a status
 * summary.
 */
export async function scan(boards, prevState, { fetchJson, now = Date.now(), concurrency = 24, workdayConcurrency = 4, waits, extra = [] }) {
  const state = prevState?.version === 1 ? structuredClone(prevState) : emptyState();
  // Which open jobs were alert-worthy, so re-reading them keeps the flag.
  state.alerts = Object.fromEntries(Object.values(state.open).map((j) => [j.id, j.alert]));

  // Workday limits requests per caller across all its companies' sites (it
  // answered 429 to ~300 of 1,000 at 24 at a time), so it gets its own, smaller pool.
  const results = new Array(boards.length);
  const lane = (pick, n) => {
    const idx = boards.map((b, i) => i).filter((i) => pick(boards[i]));
    return pool(idx, n, async (i) => { results[i] = await readBoard(boards[i], { fetchJson, now, waits }); });
  };
  await Promise.all([lane((b) => b.ats !== "workday", concurrency), lane((b) => b.ats === "workday", workdayConcurrency)]);
  let added = 0;
  boards.forEach((b, i) => { added += applySource(state, b.key, results[i], { now, tags: b.tags || [] }); });
  for (const src of extra) added += applySource(state, src.key, src.result, { now, tagsFor: src.tagsFor });
  delete state.alerts;

  // Boards dropped from the list take their jobs with them.
  const live = new Set([...boards.map((b) => b.key), ...extra.map((s) => s.key)]);
  for (const [id, j] of Object.entries(state.open)) if (!live.has(j.source)) delete state.open[id];
  for (const k of Object.keys(state.boards)) if (!live.has(k)) delete state.boards[k];
  for (const [id, t] of Object.entries(state.seen)) {
    if (!state.open[id] && t < now - FORGET_DAYS * DAY) delete state.seen[id];
  }

  const open = mergeCopies(Object.values(state.open)).sort((a, b) => b.firstSeen - a.firstSeen || b.postedAt - a.postedAt);
  const feed = open.filter((j) => j.alert && j.firstSeen >= now - FEED_DAYS * DAY);
  const strip = ({ alert, source, ...j }) => j;

  const byAts = {};
  for (const [i, b] of boards.entries()) {
    const s = byAts[b.ats] || (byAts[b.ats] = { boards: 0, ok: 0, internships: 0 });
    s.boards++;
    if (results[i].ok) { s.ok++; s.internships += results[i].jobs.length; }
  }
  const status = {
    scannedAt: now,
    boards: boards.length,
    boardsOk: results.filter((r) => r.ok).length,
    byAts,
    extra: Object.fromEntries(extra.map((s) => [s.key, s.result.unchanged ? "unchanged" : s.result.ok ? `${s.result.jobs.length} jobs` : `failed: ${s.result.error}`])),
    open: open.length,
    newThisScan: added,
    inFeed: feed.length
  };
  return {
    state,
    feed: { generatedAt: now, jobs: feed.map(strip) },
    open: { generatedAt: now, jobs: open.map(strip) },
    status
  };
}
