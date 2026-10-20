import test from "node:test";
import assert from "node:assert/strict";
import { scan, mergeCopies } from "../lib/scan.js";
import { parseBoardKey } from "../lib/ats.js";
import { HttpError } from "../lib/http.js";

const DAY = 864e5;
const T0 = Date.parse("2026-10-20T12:00:00Z");
const stripe = { ...parseBoardKey("greenhouse:stripe"), company: "Stripe", tags: ["Big Tech"] };
const gh = (...jobs) => ({ jobs: jobs.map(([id, title, daysAgo, now = T0]) => ({
  id, title, location: { name: "Seattle, WA" }, absolute_url: `https://x/${id}`,
  first_published: new Date(now - daysAgo * DAY).toISOString() })) });
const fetchFrom = (byUrl) => async (req) => {
  const r = byUrl[req.url];
  if (r instanceof Error) throw r;
  return r;
};
const url = "https://boards-api.greenhouse.io/v1/boards/stripe/jobs";

test("first read of a board is a baseline; later postings are news", async () => {
  const first = await scan([stripe], null, { now: T0, fetchJson: fetchFrom({ [url]: gh([1, "SWE Intern", 1], [2, "Account Executive", 1]) }) });
  assert.equal(first.open.jobs.length, 1, "non-internships dropped");
  assert.equal(first.feed.jobs.length, 0, "nothing from a board's first read is news");

  const t1 = T0 + 20 * 60e3;
  const second = await scan([stripe], first.state, { now: t1,
    fetchJson: fetchFrom({ [url]: gh([1, "SWE Intern", 1], [3, "Data Intern (Summer 2027)", 0, t1]) }) });
  assert.deepEqual(second.feed.jobs.map((j) => j.title), ["Data Intern (Summer 2027)"]);
  const j = second.feed.jobs[0];
  assert.equal(j.firstSeen, t1);
  assert.deepEqual(j.tags, ["Big Tech"]);
  assert.deepEqual(j.terms, ["Summer 2027"]);
  assert.deepEqual(j.countries, ["US"]);
  assert.equal(second.status.newThisScan, 1);

  const third = await scan([stripe], second.state, { now: t1 + 20 * 60e3,
    fetchJson: fetchFrom({ [url]: gh([1, "SWE Intern", 1], [3, "Data Intern (Summer 2027)", 0, t1]) }) });
  assert.equal(third.status.newThisScan, 0);
  assert.equal(third.feed.jobs.length, 1, "stays in the feed for a few days so late sheets catch it");
  assert.equal(third.feed.jobs[0].firstSeen, t1);
});

test("an old posting seen for the first time isn't news", async () => {
  const first = await scan([stripe], null, { now: T0, fetchJson: fetchFrom({ [url]: gh() }) });
  const second = await scan([stripe], first.state, { now: T0 + 60e3, fetchJson: fetchFrom({ [url]: gh([7, "Old Intern", 40]) }) });
  assert.equal(second.feed.jobs.length, 0);
  assert.equal(second.open.jobs.length, 1);
});

test("a board that's down keeps its postings, and they aren't news when it's back", async () => {
  const first = await scan([stripe], null, { now: T0, fetchJson: fetchFrom({ [url]: gh([1, "SWE Intern", 1]) }) });
  const down = await scan([stripe], first.state, { now: T0 + 60e3, fetchJson: fetchFrom({ [url]: new HttpError(500, url) }) });
  assert.equal(down.open.jobs.length, 1);
  assert.equal(down.state.boards[stripe.key].fails, 1);
  const back = await scan([stripe], down.state, { now: T0 + 120e3, fetchJson: fetchFrom({ [url]: gh([1, "SWE Intern", 1]) }) });
  assert.equal(back.feed.jobs.length, 0);
  assert.equal(back.state.boards[stripe.key].fails, 0);
});

test("429s are retried", async () => {
  let calls = 0;
  const res = await scan([stripe], null, { now: T0, waits: [1, 1], fetchJson: async () => {
    if (++calls < 3) throw new HttpError(429, url);
    return gh([1, "SWE Intern", 1]);
  } });
  assert.equal(res.status.boardsOk, 1);
  assert.equal(calls, 3);
});

test("a closed posting that's reposted isn't news", async () => {
  const s1 = await scan([stripe], null, { now: T0, fetchJson: fetchFrom({ [url]: gh([1, "SWE Intern", 1]) }) });
  const s2 = await scan([stripe], s1.state, { now: T0 + DAY, fetchJson: fetchFrom({ [url]: gh() }) });
  const s3 = await scan([stripe], s2.state, { now: T0 + 2 * DAY, fetchJson: fetchFrom({ [url]: gh([1, "SWE Intern", 1, T0 + 2 * DAY]) }) });
  assert.equal(s3.feed.jobs.length, 0);
});

test("extra sources: unchanged keeps jobs; boards removed from the list drop theirs", async () => {
  const job = { id: "simplify:1", title: "Intern", company: "Google", location: "Mountain View, CA", url: "g", postedAt: T0 };
  const tagsFor = () => ["Big Tech"];
  const s1 = await scan([stripe], null, { now: T0, fetchJson: fetchFrom({ [url]: gh([1, "SWE Intern", 1]) }),
    extra: [{ key: "simplify", result: { ok: true, jobs: [job] }, tagsFor }] });
  assert.equal(s1.open.jobs.length, 2);
  const s2 = await scan([], s1.state, { now: T0 + 60e3, fetchJson: fetchFrom({}),
    extra: [{ key: "simplify", result: { unchanged: true }, tagsFor }] });
  assert.deepEqual(s2.open.jobs.map((j) => j.id), ["simplify:1"]);
  assert.deepEqual(s2.open.jobs[0].tags, ["Big Tech"]);
});

test("mergeCopies shows a multi-city posting once, dated by its first sighting", () => {
  const base = { company: "Stripe", title: "SWE Intern", postedAt: 0, alert: true };
  const merged = mergeCopies([
    { ...base, id: "b", location: "NYC", countries: ["US"], firstSeen: 2, alert: true },
    { ...base, id: "a", location: "Toronto", countries: ["CA"], firstSeen: 1, alert: false }
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "a");
  assert.equal(merged[0].alert, false, "a new city for an old posting isn't news");
  assert.equal(merged[0].location, "Toronto · NYC");
  assert.deepEqual(merged[0].countries, ["CA", "US"]);
});

test("Workday: every page is read, so a new posting on page 3 of an unsorted site is caught", async () => {
  const wd = { ...parseBoardKey("workday:acme.wd1.myworkdayjobs.com/External"), company: "Acme", tags: [] };
  const posting = (n, postedOn = "Posted 30+ Days Ago") => ({ title: `Intern ${n}`, externalPath: `/job/x/${n}`, locationsText: "Austin, TX", postedOn, bulletFields: [String(n)] });
  const site = (extra = []) => async (req) => {
    const all = [...Array.from({ length: 45 }, (_, i) => posting(i)), ...extra];
    const { offset, limit } = JSON.parse(req.body);
    // Like real Workday: the total comes only with the first page.
    return { total: offset === 0 ? all.length : 0, jobPostings: all.slice(offset, offset + limit) };
  };
  const s1 = await scan([wd], null, { now: T0, fetchJson: site() });
  assert.equal(s1.open.jobs.length, 45);
  const s2 = await scan([wd], s1.state, { now: T0 + 60e3, fetchJson: site([posting(99, "Posted Today")]) });
  assert.deepEqual(s2.feed.jobs.map((j) => j.title), ["Intern 99"]);
});

test("SmartRecruiters: pages past the first 100 are read; a failed page fails the board", async () => {
  const sr = { ...parseBoardKey("smartrecruiters:Acme"), company: "Acme", tags: [] };
  const all = Array.from({ length: 230 }, (_, i) => ({ id: String(i), name: `Intern ${i}`, location: { fullLocation: "NYC" }, releasedDate: "2026-10-19" }));
  const seen = [];
  const ok = await scan([sr], null, { now: T0, fetchJson: async (req) => {
    const offset = Number(new URL(req.url).searchParams.get("offset"));
    seen.push(offset);
    return { totalFound: all.length, content: all.slice(offset, offset + 100) };
  } });
  assert.deepEqual(seen, [0, 100, 200]);
  assert.equal(ok.open.jobs.length, 230);
  const bad = await scan([sr], ok.state, { now: T0 + 60e3, waits: [], fetchJson: async (req) => {
    if (req.url.includes("offset=100")) throw new HttpError(500, req.url);
    return { totalFound: all.length, content: all.slice(0, 100) };
  } });
  assert.equal(bad.status.boardsOk, 0);
  assert.equal(bad.open.jobs.length, 230, "kept the last full read");
});

test("changing how boards are read re-baselines them instead of flooding the feed", async () => {
  const s1 = await scan([stripe], null, { now: T0, fetchJson: fetchFrom({ [url]: gh([1, "SWE Intern", 1]) }) });
  const old = structuredClone(s1.state);
  delete old.boards[stripe.key].mode; // a state written before READ_MODE existed
  old.open[`${stripe.key}:1`].alert = true;
  const s2 = await scan([stripe], old, { now: T0 + 60e3, fetchJson: fetchFrom({ [url]: gh([1, "SWE Intern", 1], [2, "Data Intern", 2]) }) });
  assert.equal(s2.feed.jobs.length, 0);
  const s3 = await scan([stripe], s2.state, { now: T0 + 120e3, fetchJson: fetchFrom({ [url]: gh([1, "SWE Intern", 1], [2, "Data Intern", 2], [3, "ML Intern", 0, T0 + 120e3]) }) });
  assert.deepEqual(s3.feed.jobs.map((j) => j.title), ["ML Intern"]);
});
