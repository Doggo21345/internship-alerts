import test from "node:test";
import assert from "node:assert/strict";
import { loadAlerts } from "./gas-fakes.mjs";

const DATA = "https://raw.githubusercontent.com/Doggo21345/internship-alerts/data/";
const T0 = Date.parse("2026-10-20T12:00:00Z");
const job = (id, over = {}) => ({ id, title: "Software Engineer Intern", company: "Stripe", location: "Seattle, WA",
  countries: ["US"], roleTypes: ["Software"], terms: ["Summer 2027"], tags: ["Big Tech"], url: `https://x/${id}`,
  postedAt: T0, firstSeen: T0 - 3600e3, ...over });

test("setup, first check, no repeats, then only what's new", () => {
  let feed = { generatedAt: T0, jobs: [job("a"), job("old", { firstSeen: T0 - 3 * 864e5 }), job("hw", { title: "Mechanical Intern", roleTypes: ["Hardware"] })] };
  const { gas, sheets, sent, setNow } = loadAlerts({ now: T0, responses: (url) => url === DATA + "new.json" ? feed : undefined });
  gas.setupAlerts();

  assert.deepEqual([...sheets.keys()].sort(), ["Alert settings", "Alerts", "Matches"]);
  const settings = sheets.get("Alert settings");
  assert.equal(settings.cell(2, 2), "me@example.com");
  assert.equal(settings.cell(3, 2), "intern-0123456789abcdef");

  // The example SWE alert is on: it looks back a day, so "a" but not "old" or the hardware one.
  assert.equal(sent.emails.length, 1);
  assert.equal(sent.emails[0].subject, "1 new internship: Stripe");
  assert.equal(sent.pushes.length, 1);
  assert.equal(sent.pushes[0].topic, "intern-0123456789abcdef");
  assert.equal(sent.pushes[0].click, "https://x/a");
  assert.equal(sheets.get("Matches").cell(2, 6), "https://x/a");
  assert.match(String(settings.cell(5, 2)), /1 alert\(s\) on; 1 new match\(es\); emailed, pushed/);

  setNow(T0 + 15 * 60e3);
  gas.checkAlerts();
  assert.equal(sent.emails.length, 1, "same feed: nothing new");

  const t1 = T0 + 20 * 60e3;
  feed = { generatedAt: t1, jobs: [job("b", { firstSeen: t1, company: "Figma" }), ...feed.jobs] };
  setNow(t1 + 60e3);
  gas.checkAlerts();
  assert.equal(sent.emails.length, 2);
  assert.equal(sent.emails[1].subject, "1 new internship: Figma");
  assert.equal(sheets.get("Matches").cell(2, 2), "Figma", "newest on top");
  assert.equal(sheets.get("Matches").cell(3, 2), "Stripe");
});

test("a company the scanner doesn't cover is found on Greenhouse and checked from the sheet", () => {
  let board = { jobs: [{ id: 1, title: "SWE Intern", location: { name: "NYC" }, absolute_url: "https://gh/1" }] };
  const { gas, sheets, sent, setNow } = loadAlerts({ now: T0, responses: (url) => {
    if (url === DATA + "new.json") return { generatedAt: T0, jobs: [] };
    if (url === DATA + "companies.json") return { companies: ["stripe"] };
    if (url === "https://boards-api.greenhouse.io/v1/boards/tinyco/jobs") return board;
    return undefined;
  } });
  gas.setupAlerts();
  const alerts = sheets.get("Alerts");
  alerts.set(2, 9, "TinyCo, Nowhere Labs");
  alerts.set(2, 3, ""); alerts.set(2, 4, ""); alerts.set(2, 5, ""); alerts.set(2, 10, "");
  sent.emails.length = 0;

  gas.checkAlerts();
  assert.equal(sent.emails.length, 0, "first read only remembers what's there");
  assert.equal(sheets.get("Alert settings").cell(6, 2), "Nowhere Labs");

  board = { jobs: [...board.jobs, { id: 2, title: "Data Intern", location: { name: "NYC" }, absolute_url: "https://gh/2" }] };
  setNow(T0 + 15 * 60e3);
  gas.checkAlerts();
  assert.equal(sent.emails.length, 1);
  assert.equal(sent.emails[0].subject, "1 new internship: TinyCo");
  assert.equal(sheets.get("Matches").cell(2, 6), "https://gh/2");
});
