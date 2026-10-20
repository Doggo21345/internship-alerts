import test from "node:test";
import assert from "node:assert/strict";
import { loadAlerts } from "./gas-fakes.mjs";

const { gas } = loadAlerts();
const alert = (over = {}) => gas.iaParseAlert(
  [true, "A", "", "", "", "", "", "", "", "", true, true].map((v, i) => (i in over ? over[i] : v)), 2);
const job = (over = {}) => ({ id: "j", title: "Software Engineer Intern (Summer 2027)", company: "Stripe", location: "Seattle, WA",
  countries: ["US"], roleTypes: ["Software"], terms: ["Summer 2027"], tags: ["Big Tech"], url: "u", firstSeen: 1, ...over });

test("blank and paused rows aren't alerts; unknown labels are reported", () => {
  assert.equal(gas.iaParseAlert([false, "x", "swe", "", "", "", "", "", "", "", true, true], 2), null);
  assert.equal(gas.iaParseAlert([true, "", "", "", "", "", "", "", "", "", true, true], 2), null);
  const a = alert({ 3: "Software, Robots", 7: "big tech" });
  assert.deepEqual([...a.roleTypes], ["Software"]);
  assert.deepEqual([...a.companyTypes], ["Big Tech"]);
  assert.deepEqual([...a.problems], ['unknown role type "Robots"']);
});

test("keywords match whole words", () => {
  assert.ok(gas.iaMatches(job(), alert({ 2: "software, data" })));
  assert.ok(!gas.iaMatches(job({ title: "HTML Intern" }), alert({ 2: "ml" })));
  assert.ok(gas.iaMatches(job({ title: "ML Intern" }), alert({ 2: "ml" })));
  assert.ok(gas.iaMatches(job({ title: "Full Stack Intern" }), alert({ 2: "full stack" })));
});

test("role types: untyped titles are kept; with keywords, either one is enough", () => {
  const a = alert({ 3: "Hardware" });
  assert.ok(!gas.iaMatches(job(), a));
  assert.ok(gas.iaMatches(job({ roleTypes: [] }), a));
  assert.ok(gas.iaMatches(job(), alert({ 2: "software", 3: "Hardware" })));
  assert.ok(!gas.iaMatches(job({ title: "Intern", roleTypes: [] }), alert({ 2: "software", 3: "Hardware" })));
});

test("terms", () => {
  assert.ok(gas.iaMatches(job(), alert({ 4: "Summer 2027" })));
  assert.ok(!gas.iaMatches(job(), alert({ 4: "Fall 2026" })));
  assert.ok(gas.iaMatches(job(), alert({ 4: "Fall 2026, Summer 2027" })));
  assert.ok(gas.iaMatches(job({ terms: ["2027"] }), alert({ 4: "Summer 2027" })));
  assert.ok(gas.iaMatches(job({ terms: [] }), alert({ 4: "Fall 2026" })), "no term named: kept");
});

test("country and city", () => {
  assert.ok(gas.iaMatches(job(), alert({ 5: "US" })));
  assert.ok(gas.iaMatches(job(), alert({ 5: "united states" })));
  assert.ok(!gas.iaMatches(job(), alert({ 5: "CA" })));
  assert.ok(gas.iaMatches(job({ countries: [] }), alert({ 5: "CA" })), "unknown country kept");
  assert.ok(gas.iaMatches(job({ location: "Austin, TX" }), alert({ 6: "TX" })));
  assert.ok(!gas.iaMatches(job({ location: "Textron Park, MA" }), alert({ 6: "TX" })));
  assert.ok(gas.iaMatches(job({ location: "Remote - US" }), alert({ 6: "Austin, Remote" })));
  assert.ok(!gas.iaMatches(job(), alert({ 6: "Austin" })));
});

test("companies: by name or by type", () => {
  assert.ok(gas.iaMatches(job(), alert({ 8: "stripe" })));
  assert.ok(gas.iaMatches(job({ company: "Jane Street Capital" }), alert({ 8: "Jane Street" })));
  assert.ok(!gas.iaMatches(job({ company: "Janes" }), alert({ 8: "Jane" })));
  assert.ok(gas.iaMatches(job(), alert({ 7: "Big Tech" })));
  assert.ok(!gas.iaMatches(job({ tags: [] }), alert({ 7: "Big Tech" })));
  assert.ok(gas.iaMatches(job({ tags: [], company: "Ramp" }), alert({ 7: "Big Tech", 8: "Ramp" })));
});

test("exclude words", () => {
  assert.ok(!gas.iaMatches(job({ title: "PhD Software Intern" }), alert({ 9: "PhD" })));
});

test("email and push wording", () => {
  const m = [{ job: job(), alerts: [{ name: "SWE" }] }, { job: job({ id: "k", company: "Figma" }), alerts: [{ name: "SWE" }] }];
  const e = gas.iaEmail(m, 10, "sheet");
  assert.equal(e.subject, "2 new internships: Stripe, Figma");
  assert.match(e.htmlBody, /Software Engineer Intern/);
  assert.equal(gas.iaPushes(m, "t", "sheet").length, 2);
  const many = Array.from({ length: 5 }, (_, i) => ({ job: job({ id: String(i) }), alerts: [{ name: "SWE" }] }));
  const p = gas.iaPushes(many, "t", "sheet");
  assert.equal(p.length, 1);
  assert.equal(p[0].title, "5 new internships");
  assert.match(gas.iaEmail([{ job: job({ company: "<i>" }), alerts: [{ name: "x" }] }], 0, "s").htmlBody, /<b>&lt;i&gt;<\/b>/);
});

test("iaBoardFromLink", () => {
  assert.equal(gas.iaBoardFromLink("https://jobs.ashbyhq.com/Ramp"), "ashby:ramp");
  assert.equal(gas.iaBoardFromLink("boards.greenhouse.io/stripe/jobs/1"), "greenhouse:stripe");
  assert.equal(gas.iaBoardFromLink("https://google.com"), "");
});
