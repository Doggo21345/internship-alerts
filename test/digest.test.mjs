import test from "node:test";
import assert from "node:assert/strict";
import { buildDigest, shortLocation, LINKEDIN_MAX } from "../lib/digest.js";

const H = 36e5;
const NOW = Date.parse("2026-10-21T13:00:00Z");
let n = 0;
const job = (o = {}) => ({ id: String(n++), company: "Acme", title: "SWE Intern", location: "Austin, TX", url: "https://x/1",
  tags: [], level: "Internship", firstSeen: NOW - H, ...o });

test("only the last 24 hours, split by level, Big Tech and Quant first", () => {
  const d = buildDigest([
    job({ company: "Acme" }),
    job({ company: "Google", tags: ["Big Tech"], firstSeen: NOW - 20 * H }),
    job({ company: "Jane Street", tags: ["Quant"] }),
    job({ company: "Old Co", firstSeen: NOW - 30 * H }),
    job({ company: "Ramp", title: "Software Engineer, New Grad", level: "New Grad" })
  ], { now: NOW });
  assert.deepEqual(d.internships.map((j) => j.company), ["Google", "Jane Street", "Acme"]);
  assert.deepEqual(d.newGrad.map((j) => j.company), ["Ramp"]);
  assert.equal(d.subject, "3 internships + 1 new grad job opened in the last 24 hours (Oct 21)");
  assert.match(d.html, /<h2>🎓 Internships \(3\)<\/h2>/);
  assert.match(d.html, /<h3>🏢 Big Tech \(1\)<\/h3>\n<ul><li[^>]*><b>Google<\/b>: <a href="https:\/\/x\/1"[^>]*>SWE Intern<\/a> <span[^>]*>· Austin, TX<\/span>/);
  assert.match(d.html, /<h3>📈 Quant \(1\)<\/h3>/);
  assert.match(d.html, /Hiring today: Google</);
  assert.doesNotMatch(d.html, /Old Co/);
});

test("LinkedIn post: counts, top roles, no links, under the limit", () => {
  const jobs = Array.from({ length: 400 }, (_, i) => job({ company: `Company number ${i}`, title: "Software Engineering Intern, Summer 2027 (Backend, Infrastructure)" }));
  const d = buildDigest(jobs, { now: NOW });
  assert.ok(d.linkedin.length <= LINKEDIN_MAX, String(d.linkedin.length));
  assert.match(d.linkedin, /^400 INTERNSHIPS and 0 new grad jobs opened in the LAST 24 HOURS\./);
  assert.match(d.linkedin, /\+ 390 more/);
  assert.doesNotMatch(d.linkedin, /https?:/);
});

test("LinkedIn post: one line per company", () => {
  const d = buildDigest([job({ company: "Google", tags: ["Big Tech"] }), job({ company: "Google", tags: ["Big Tech"], title: "Data Intern" }), job()], { now: NOW });
  assert.match(d.linkedin, /• Google: SWE Intern \(\+1 more\)\n• Acme: SWE Intern\n/);
  assert.doesNotMatch(d.linkedin, /^\+ \d+ more$/m, "every role is accounted for");
});

test("newsletter escapes and caps rows", () => {
  const d = buildDigest([job({ company: "<b>x</b>" }), ...Array.from({ length: 105 }, () => job())], { now: NOW });
  assert.match(d.html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(d.html, /…and 6 more\./);
  assert.match(d.html, /<h2>💼 New grad<\/h2><p[^>]*>Nothing new/);
});

test("shortLocation", () => {
  assert.equal(shortLocation("Seattle, WA · Austin, TX · NYC · Remote"), "Seattle, WA · Austin, TX +2");
  assert.equal(shortLocation("Austin, TX"), "Austin, TX");
  assert.equal(shortLocation(""), "");
});
