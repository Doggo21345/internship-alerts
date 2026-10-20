import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBoardUrl, parseBoardKey, boardRequest, normalizeJobs, workdayPostedAt } from "../lib/ats.js";
import { roleTypes, termsIn, companyKey, companyTags, isInternship } from "../lib/classify.js";
import { simplifyJobs, boardsFromListings } from "../lib/simplify.js";
import { scan, mergeCopies, FRESH_DAYS } from "../lib/scan.js";

const DAY = 864e5;
const NOW = Date.parse("2026-10-20T12:00:00Z");

test("board links", () => {
  assert.deepEqual(parseBoardUrl("https://job-boards.greenhouse.io/stripe/jobs/123"), { ats: "greenhouse", slug: "stripe", key: "greenhouse:stripe" });
  assert.equal(parseBoardUrl("https://boards.greenhouse.io/embed/job_app?for=Figma&token=1").key, "greenhouse:figma");
  assert.equal(parseBoardUrl("https://jobs.lever.co/palantir/abc").key, "lever:palantir");
  assert.equal(parseBoardUrl("https://jobs.ashbyhq.com/Ramp%20Inc/xyz").key, "ashby:ramp inc");
  assert.equal(parseBoardUrl("https://jobs.smartrecruiters.com/WesternDigital/744").key, "smartrecruiters:WesternDigital");
  const wd = parseBoardUrl("https://globalhr.wd5.myworkdayjobs.com/en-US/rec_rtx_ext_gateway/job/US-CT/Intern_018");
  assert.equal(wd.key, "workday:globalhr.wd5.myworkdayjobs.com/rec_rtx_ext_gateway");
  assert.equal(parseBoardUrl("https://bmo.wd3.myworkdayjobs.com/Privileged/job/x").site, "Privileged");
  assert.equal(parseBoardUrl("https://careers.google.com/jobs/1"), null);
  assert.deepEqual(parseBoardKey(wd.key), wd);
  assert.equal(parseBoardKey("greenhouse:stripe").slug, "stripe");
  assert.equal(parseBoardKey("monster:x"), null);
});

test("workday request asks for internships, newest first, by page", () => {
  const r = boardRequest(parseBoardUrl("https://caci.wd1.myworkdayjobs.com/external/job/x"), 1);
  assert.equal(r.url, "https://caci.wd1.myworkdayjobs.com/wday/cxs/caci/external/jobs");
  assert.equal(r.method, "POST");
  assert.deepEqual(JSON.parse(r.body), { appliedFacets: {}, limit: 20, offset: 20, searchText: "internship" });
});

test("workday dates", () => {
  assert.equal(workdayPostedAt("Posted Today", NOW), NOW);
  assert.equal(workdayPostedAt("Posted Yesterday", NOW), NOW - DAY);
  assert.equal(workdayPostedAt("Posted 3 Days Ago", NOW), NOW - 3 * DAY);
  assert.equal(workdayPostedAt("Posted 30+ Days Ago", NOW), NOW - 30 * DAY);
  assert.equal(workdayPostedAt("", NOW), 0);
});

test("normalizes each board's response", () => {
  const gh = normalizeJobs(parseBoardKey("greenhouse:stripe"), { jobs: [{ id: 1, title: "SWE Intern", company_name: "Stripe", location: { name: "Seattle, WA" }, absolute_url: "u", first_published: "2026-10-19T00:00:00Z" }] });
  assert.deepEqual(gh, [{ jobId: "1", title: "SWE Intern", company: "Stripe", location: "Seattle, WA", url: "u", postedAt: Date.parse("2026-10-19T00:00:00Z") }]);
  const lever = normalizeJobs(parseBoardKey("lever:palantir"), [{ id: "a", text: "Intern", categories: { location: "NYC" }, hostedUrl: "h", createdAt: 5 }], { company: "Palantir" });
  assert.equal(lever[0].company, "Palantir");
  assert.equal(lever[0].postedAt, 5);
  const ashby = normalizeJobs(parseBoardKey("ashby:ramp"), { jobs: [{ id: "x", title: "Intern", location: "NYC", secondaryLocations: [{ location: "SF" }], jobUrl: "j", isListed: true }, { id: "y", isListed: false }] });
  assert.equal(ashby.length, 1);
  assert.equal(ashby[0].location, "NYC; SF");
  const sr = normalizeJobs(parseBoardKey("smartrecruiters:WesternDigital"), { content: [{ id: "7", name: "Intern", location: { fullLocation: "San Jose, CA" }, releasedDate: "2026-10-19T17:01:22Z" }] });
  assert.equal(sr[0].url, "https://jobs.smartrecruiters.com/WesternDigital/7");
  const wd = normalizeJobs(parseBoardUrl("https://caci.wd1.myworkdayjobs.com/external/job/x"), { jobPostings: [{ title: "Network Engineer Intern", externalPath: "/job/NC/Net_332843", locationsText: "High Point, NC, US", postedOn: "Posted Today", bulletFields: ["332843"] }] }, { company: "CACI", now: NOW });
  assert.deepEqual(wd[0], { jobId: "332843", title: "Network Engineer Intern", company: "CACI", location: "High Point, NC, US", url: "https://caci.wd1.myworkdayjobs.com/external/job/NC/Net_332843", postedAt: NOW });
  assert.equal(normalizeJobs(parseBoardKey("greenhouse:x"), { error: "nope" }), null);
});

test("classifying titles and companies", () => {
  assert.ok(isInternship("Software Engineer Intern"));
  assert.ok(isInternship("Co-op, Data"));
  assert.ok(!isInternship("International Sales Manager"));
  assert.ok(!isInternship("Internal Tools Engineer"));
  assert.deepEqual(roleTypes("Machine Learning Engineer Intern"), ["Data/AI"]);
  assert.deepEqual(roleTypes("Software Engineer Intern, Backend"), ["Software"]);
  assert.deepEqual(roleTypes("Quantitative Trader Intern"), ["Quant"]);
  assert.deepEqual(roleTypes("Mechanical Engineering Intern"), ["Hardware"]);
  assert.deepEqual(roleTypes("Engineering Intern"), []);
  assert.deepEqual(roleTypes("HTML Email Intern").includes("Data/AI"), false);
  assert.deepEqual(termsIn("SWE Intern (Summer 2027)"), ["Summer 2027"]);
  assert.deepEqual(termsIn("Fall/Winter 2026 Co-op"), ["Fall 2026", "Winter 2026"]);
  assert.deepEqual(termsIn("Summer Intern"), ["Summer"]);
  assert.deepEqual(termsIn("Intern"), []);
  assert.equal(companyKey("Jane Street Capital, LLC"), "jane street capital");
  assert.equal(companyKey("AT&T"), "at and t");
  assert.deepEqual(companyTags("Google"), ["Big Tech"]);
  assert.deepEqual(companyTags("Jane Street"), ["Quant"]);
  assert.deepEqual(companyTags("Ramp", { yc: new Set(["ramp"]) }), ["YC Startup"]);
});

const listing = (over) => ({ id: "s1", title: "Software Engineer Intern", company_name: "Google", active: true, is_visible: true,
  url: "https://careers.google.com/jobs/1", locations: ["Mountain View, CA"], date_posted: NOW / 1000, terms: ["Summer 2027"], category: "Software", ...over });

test("simplify listings", () => {
  const jobs = simplifyJobs([
    listing(),
    listing({ id: "s2", active: false }),
    listing({ id: "s3", url: "https://job-boards.greenhouse.io/stripe/jobs/1" }),
    listing({ id: "s4", url: "https://job-boards.greenhouse.io/figma/jobs/1" })
  ], new Set(["greenhouse:stripe"]));
  assert.deepEqual(jobs.map((j) => j.id), ["simplify:s1", "simplify:s4"]);
  assert.deepEqual(jobs[0].roleTypes, ["Software"]);
  assert.equal(jobs[0].postedAt, NOW);

  const boards = boardsFromListings([
    listing({ url: "https://jobs.lever.co/acme/1", company_name: "Acme" }),
    listing({ url: "https://jobs.lever.co/acme/2", company_name: "Acme Corp" }),
    listing({ url: "https://jobs.lever.co/acme/3", company_name: "Acme" }),
    listing()
  ]);
  assert.equal(boards.length, 1);
  assert.equal(boards[0].company, "Acme");
  assert.equal(boards[0].listings, 3);
});

// ---- scan ----------------------------------------------------------------------

const B = parseBoardKey("greenhouse:acme");
const board = { ...B, company: "Acme", tags: ["YC Startup"] };
const gh = (...jobs) => ({ jobs: jobs.map(([id, title, daysAgo = 0]) => ({ id, title, location: { name: "Austin, TX" }, absolute_url: `https://x/${id}`, first_published: new Date(NOW - daysAgo * DAY).toISOString() })) });

/** fetchJson that answers each board from `responses` (a value, or an Error to throw). */
const fake = (responses) => async (req) => {
  const r = responses[req.url];
  if (r instanceof Error) throw r;
  if (r === undefined) throw new Error(`no fixture for ${req.url}`);
  return r;
};
const URL_ = boardRequest(B).url;

test("first sight of a board is a baseline, not news", async () => {
  const r = await scan([board], null, { fetchJson: fake({ [URL_]: gh([1, "SWE Intern"], [2, "Senior Engineer"]) }), now: NOW });
  assert.equal(r.open.jobs.length, 1, "only internships are kept");
  assert.equal(r.feed.jobs.length, 0);
  assert.equal(r.status.newThisScan, 0);
  assert.deepEqual(r.open.jobs[0].tags, ["YC Startup"]);
  assert.deepEqual(r.open.jobs[0].countries, ["US"]);
});

test("a new posting on a known board goes in the feed once", async () => {
  const first = await scan([board], null, { fetchJson: fake({ [URL_]: gh([1, "SWE Intern"]) }), now: NOW });
  const later = NOW + 20 * 60e3;
  const second = await scan([board], first.state, { fetchJson: fake({ [URL_]: gh([1, "SWE Intern"], [3, "Data Science Intern (Summer 2027)"]) }), now: later });
  assert.equal(second.status.newThisScan, 1);
  assert.deepEqual(second.feed.jobs.map((j) => j.id), ["greenhouse:acme:3"]);
  const j = second.feed.jobs[0];
  assert.equal(j.firstSeen, later);
  assert.deepEqual(j.roleTypes, ["Data/AI"]);
  assert.deepEqual(j.terms, ["Summer 2027"]);
  assert.equal(j.alert, undefined, "internal flags are stripped");
  // Seen again next scan: still in the feed (sheets read by firstSeen), not counted as new.
  const third = await scan([board], second.state, { fetchJson: fake({ [URL_]: gh([1, "SWE Intern"], [3, "Data Science Intern (Summer 2027)"]) }), now: later + 20 * 60e3 });
  assert.equal(third.status.newThisScan, 0);
  assert.equal(third.feed.jobs[0].firstSeen, later);
  // Gone from the feed once it's older than the feed window.
  const old = await scan([board], third.state, { fetchJson: fake({ [URL_]: gh([1, "SWE Intern"], [3, "Data Science Intern (Summer 2027)"]) }), now: later + 4 * DAY });
  assert.equal(old.feed.jobs.length, 0);
  assert.equal(old.open.jobs.length, 2);
});

test("a posting dated long ago isn't news even if we only just saw it", async () => {
  const first = await scan([board], null, { fetchJson: fake({ [URL_]: gh([1, "SWE Intern"]) }), now: NOW });
  const second = await scan([board], first.state, { fetchJson: fake({ [URL_]: gh([1, "SWE Intern"], [4, "Old Intern", FRESH_DAYS + 5]) }), now: NOW + 60e3 });
  assert.equal(second.feed.jobs.length, 0);
  assert.equal(second.open.jobs.length, 2);
});

test("a board that's down keeps its jobs, and they aren't news when it's back", async () => {
  const first = await scan([board], null, { fetchJson: fake({ [URL_]: gh([1, "SWE Intern"]) }), now: NOW });
  const down = await scan([board], first.state, { fetchJson: fake({ [URL_]: new Error("timeout") }), now: NOW + 60e3 });
  assert.equal(down.open.jobs.length, 1);
  assert.equal(down.state.boards[B.key].fails, 1);
  const back = await scan([board], down.state, { fetchJson: fake({ [URL_]: gh([1, "SWE Intern"]) }), now: NOW + 120e3 });
  assert.equal(back.feed.jobs.length, 0);
  assert.equal(back.state.boards[B.key].fails, 0);
});

test("rate-limited reads are retried", async () => {
  let calls = 0;
  const limited = async () => {
    if (++calls === 1) throw Object.assign(new Error("HTTP 429"), { status: 429 });
    return gh([1, "SWE Intern"]);
  };
  const r = await scan([board], null, { fetchJson: limited, now: NOW, waits: [1] });
  assert.equal(calls, 2);
  assert.equal(r.status.boardsOk, 1);
});

test("a closed posting that reappears isn't news", async () => {
  const s1 = await scan([board], null, { fetchJson: fake({ [URL_]: gh([1, "SWE Intern"]) }), now: NOW });
  const s2 = await scan([board], s1.state, { fetchJson: fake({ [URL_]: gh() }), now: NOW + 60e3 });
  assert.equal(s2.open.jobs.length, 0);
  const s3 = await scan([board], s2.state, { fetchJson: fake({ [URL_]: gh([1, "SWE Intern"]) }), now: NOW + 120e3 });
  assert.equal(s3.feed.jobs.length, 0);
});

test("extra sources: Simplify baseline, then new listings; a 304 changes nothing", async () => {
  const src = (jobs) => [{ key: "simplify", result: { ok: true, jobs }, tagsFor: (c) => companyTags(c) }];
  const g1 = simplifyJobs([listing()]);
  const s1 = await scan([], null, { fetchJson: fake({}), now: NOW, extra: src(g1) });
  assert.equal(s1.feed.jobs.length, 0);
  const g2 = simplifyJobs([listing(), listing({ id: "s9", title: "ML Intern", date_posted: (NOW + 60e3) / 1000 })]);
  const s2 = await scan([], s1.state, { fetchJson: fake({}), now: NOW + 60e3, extra: src(g2) });
  assert.deepEqual(s2.feed.jobs.map((j) => j.id), ["simplify:s9"]);
  assert.deepEqual(s2.feed.jobs[0].tags, ["Big Tech"]);
  const s3 = await scan([], s2.state, { fetchJson: fake({}), now: NOW + 120e3, extra: [{ key: "simplify", result: { unchanged: true } }] });
  assert.equal(s3.open.jobs.length, 2);
  assert.equal(s3.feed.jobs.length, 1);
});

test("a board removed from the list takes its jobs with it", async () => {
  const s1 = await scan([board], null, { fetchJson: fake({ [URL_]: gh([1, "SWE Intern"]) }), now: NOW });
  const s2 = await scan([], s1.state, { fetchJson: fake({}), now: NOW + 60e3 });
  assert.equal(s2.open.jobs.length, 0);
  assert.equal(s2.state.boards[B.key], undefined);
});

test("copies of one posting merge, dated by the earliest", () => {
  const j = (id, location, firstSeen, countries) => ({ id, company: "Acme, Inc.", title: "SWE  Intern", location, firstSeen, postedAt: firstSeen, countries });
  const merged = mergeCopies([j("b", "NYC", 2, ["US"]), j("a", "Toronto, ON", 1, ["CA"]), j("c", "NYC", 3, ["US"])]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "a");
  assert.equal(merged[0].firstSeen, 1);
  assert.equal(merged[0].location, "Toronto, ON · NYC");
  assert.deepEqual(merged[0].countries, ["CA", "US"]);
});
