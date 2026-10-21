import test from "node:test";
import assert from "node:assert/strict";
import { loadAlerts } from "./gas-fakes.mjs";
import { buildDigest } from "../lib/digest.js";

const NOW = Date.parse("2026-10-21T13:00:00Z");
const URL_ = "https://raw.githubusercontent.com/Doggo21345/internship-alerts/data/digest.json";
const digest = (jobs, now = NOW) => {
  const { internships, newGrad, ...d } = buildDigest(jobs, { now });
  return d;
};
const jobs = [{ id: "1", company: "Stripe", title: "SWE Intern", location: "NYC", url: "https://x/1", tags: [], level: "Internship", firstSeen: NOW - 36e5 }];

test("emails the LinkedIn post and the newsletter", () => {
  const { gas, sent } = loadAlerts({ files: ["Digest.gs"], now: NOW, responses: { [URL_]: digest(jobs) } });
  gas.sendDigest();
  assert.equal(sent.emails.length, 1);
  const e = sent.emails[0];
  assert.equal(e.to, "me@example.com");
  assert.equal(e.subject, "Roundup ready: 1 internship + 0 new grad jobs opened in the last 24 hours (Oct 21)");
  assert.match(e.htmlBody, /1 INTERNSHIP and 0 new grad jobs/);
  assert.match(e.htmlBody, /shareActive=true&amp;text=1%20INTERNSHIP/);
  assert.match(e.htmlBody, /<a href="https:\/\/x\/1"[^>]*>SWE Intern<\/a>/);
  assert.doesNotMatch(e.htmlBody, /Heads up/);
});

test("flags a stale roundup, skips an empty one, reports a missing one", () => {
  const stale = loadAlerts({ files: ["Digest.gs"], now: NOW + 5 * 36e5, responses: { [URL_]: digest(jobs) } });
  stale.gas.sendDigest();
  assert.match(stale.sent.emails[0].htmlBody, /from 5 hours ago/);

  const empty = loadAlerts({ files: ["Digest.gs"], now: NOW, responses: { [URL_]: digest([]) } });
  empty.gas.sendDigest();
  assert.equal(empty.sent.emails.length, 0);

  const missing = loadAlerts({ files: ["Digest.gs"], now: NOW, responses: {} });
  missing.gas.sendDigest();
  assert.match(missing.sent.emails[0].subject, /couldn't read/);
});

test("setupDigest installs one daily trigger at DIGEST_HOUR", () => {
  const { gas, props } = loadAlerts({ files: ["Digest.gs"], now: NOW });
  props.set("DIGEST_HOUR", "7");
  gas.setupDigest();
  assert.deepEqual(gas.ScriptApp.triggers.map((t) => t.getHandlerFunction()), ["sendDigest"]);
});
