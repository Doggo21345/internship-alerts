import test from "node:test";
import assert from "node:assert/strict";
import { parseBoardUrl, parseBoardKey, normalizeJobs, boardRequest, workdayPostedAt, slugsFor } from "../lib/ats.js";

test("parseBoardUrl reads each board's posting links", () => {
  const cases = {
    "https://boards.greenhouse.io/stripe/jobs/123": "greenhouse:stripe",
    "https://job-boards.greenhouse.io/Figma/jobs/9": "greenhouse:figma",
    "https://boards.greenhouse.io/embed/job_app?for=airbnb&token=1": "greenhouse:airbnb",
    "https://jobs.lever.co/palantir/abc-123": "lever:palantir",
    "https://jobs.ashbyhq.com/Ramp/xyz": "ashby:ramp",
    "https://jobs.ashbyhq.com/Mistral%20AI/xyz": "ashby:mistral ai",
    "https://jobs.smartrecruiters.com/WesternDigital/744000110543825": "smartrecruiters:WesternDigital",
    "https://globalhr.wd5.myworkdayjobs.com/rec_rtx_ext_gateway/job/US-CT/Intern_018": "workday:globalhr.wd5.myworkdayjobs.com/rec_rtx_ext_gateway",
    "https://livenation.wd503.myworkdayjobs.com/en/TMExternalSite/job/x": "workday:livenation.wd503.myworkdayjobs.com/TMExternalSite",
    "https://Disney.wd5.myworkdayjobs.com/en-US/disneycareer/job/x": "workday:disney.wd5.myworkdayjobs.com/disneycareer"
  };
  for (const [url, key] of Object.entries(cases)) assert.equal(parseBoardUrl(url)?.key, key, url);
  assert.equal(parseBoardUrl("https://careers.google.com/jobs/1"), null);
  assert.equal(parseBoardUrl("https://x.wd1.myworkdayjobs.com/job/foo"), null);
});

test("parseBoardKey round-trips keys", () => {
  for (const k of ["greenhouse:stripe", "ashby:mistral ai", "workday:globalhr.wd5.myworkdayjobs.com/rec_rtx_ext_gateway"]) {
    assert.equal(parseBoardKey(k).key, k);
  }
  assert.equal(parseBoardKey("monster:foo"), null);
});

test("Workday requests ask for internships, newest first, a page at a time", () => {
  const b = parseBoardKey("workday:globalhr.wd5.myworkdayjobs.com/rec_rtx_ext_gateway");
  const r = boardRequest(b, 1);
  assert.equal(r.url, "https://globalhr.wd5.myworkdayjobs.com/wday/cxs/globalhr/rec_rtx_ext_gateway/jobs");
  assert.equal(r.method, "POST");
  assert.deepEqual(JSON.parse(r.body), { appliedFacets: {}, limit: 20, offset: 20, searchText: "internship" });
});

test("workdayPostedAt turns Workday's wording into a time", () => {
  const now = 1_000 * 864e5;
  assert.equal(workdayPostedAt("Posted Today", now), now);
  assert.equal(workdayPostedAt("Posted Yesterday", now), now - 864e5);
  assert.equal(workdayPostedAt("Posted 3 Days Ago", now), now - 3 * 864e5);
  assert.equal(workdayPostedAt("Posted 30+ Days Ago", now), now - 30 * 864e5);
  assert.equal(workdayPostedAt("", now), 0);
});

test("normalizeJobs gives every board the same shape", () => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  const gh = normalizeJobs(parseBoardKey("greenhouse:stripe"),
    { jobs: [{ id: 1, title: "SWE Intern", company_name: "Stripe", location: { name: "Seattle, WA" }, absolute_url: "u", first_published: "2026-10-19T00:00:00Z" }] });
  assert.deepEqual(gh, [{ jobId: "1", title: "SWE Intern", company: "Stripe", location: "Seattle, WA", url: "u", postedAt: Date.parse("2026-10-19T00:00:00Z") }]);

  const lever = normalizeJobs(parseBoardKey("lever:palantir"), [{ id: "a", text: "Intern", categories: { location: "NYC" }, hostedUrl: "h", createdAt: 5 }], { company: "Palantir" });
  assert.equal(lever[0].company, "Palantir");
  assert.equal(lever[0].postedAt, 5);

  const ashby = normalizeJobs(parseBoardKey("ashby:ramp"), { jobs: [
    { id: "x", title: "Intern", location: "NYC", secondaryLocations: [{ location: "SF" }], jobUrl: "j", publishedAt: "2026-10-01" },
    { id: "y", title: "Hidden", isListed: false }
  ] }, { company: "Ramp" });
  assert.equal(ashby.length, 1);
  assert.equal(ashby[0].location, "NYC; SF");

  const sr = normalizeJobs(parseBoardKey("smartrecruiters:WesternDigital"), { content: [
    { id: "9", name: "Intern", company: { name: "Western Digital" }, location: { fullLocation: "San Jose, CA, United States" }, releasedDate: "2026-10-19T17:01:22.217Z" }
  ] });
  assert.equal(sr[0].url, "https://jobs.smartrecruiters.com/WesternDigital/9");
  assert.equal(sr[0].company, "Western Digital");

  const wd = normalizeJobs(parseBoardKey("workday:caci.wd1.myworkdayjobs.com/external"), { jobPostings: [
    { title: "Network Engineer Intern", externalPath: "/job/High-Point-NC-US/Network_332843", locationsText: "High Point, NC, US", postedOn: "Posted Today", bulletFields: ["332843"] },
    { title: "no path" }
  ] }, { company: "CACI", now });
  assert.deepEqual(wd, [{ jobId: "332843", title: "Network Engineer Intern", company: "CACI", location: "High Point, NC, US",
    url: "https://caci.wd1.myworkdayjobs.com/external/job/High-Point-NC-US/Network_332843", postedAt: now }]);

  assert.equal(normalizeJobs(parseBoardKey("greenhouse:x"), { error: "nope" }), null);
});

test("slugsFor drops company suffixes", () => {
  assert.deepEqual(slugsFor("Jane Street"), ["janestreet", "jane-street"]);
  assert.deepEqual(slugsFor("Acme, Inc."), ["acme"]);
});
