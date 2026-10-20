// Runs apps-script/Alerts.gs in a VM against fake Apps Script services: a
// spreadsheet held in arrays, recorded emails and pushes, canned URL fetches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const CODE = readFileSync(new URL("../apps-script/Alerts.gs", import.meta.url), "utf8");
const NOW = Date.parse("2026-10-20T12:00:00Z");

function fakeSheet(name) {
  const cells = [];
  const sheet = {
    name, cells,
    getLastRow: () => cells.length,
    insertRowsBefore: (row, n) => { cells.splice(row - 1, 0, ...Array.from({ length: n }, () => [])); },
    setFrozenRows() {}, setColumnWidth() { return sheet; }, setColumnWidths() { return sheet; },
    getRange(row, col, nr = 1, nc = 1) {
      const range = {
        getValues: () => Array.from({ length: nr }, (_, r) => Array.from({ length: nc }, (_, c) => cells[row - 1 + r]?.[col - 1 + c] ?? "")),
        getValue: () => range.getValues()[0][0],
        setValues(v) {
          v.forEach((line, r) => line.forEach((x, c) => { (cells[row - 1 + r] ||= [])[col - 1 + c] = x; }));
          return range;
        },
        setValue: (x) => range.setValues([[x]]),
        clearContent() { for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) if (cells[row - 1 + r]) cells[row - 1 + r][col - 1 + c] = ""; return range; },
        setNotes: () => range, setFontWeight: () => range, setDataValidation: () => range,
        setNumberFormat: () => range, setFontColor: () => range
      };
      return range;
    }
  };
  return sheet;
}

/** A fresh script environment. `urls` maps URL -> JSON body (or a number for an HTTP error). */
function load({ urls = {}, now = NOW } = {}) {
  const sheets = new Map();
  const ss = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = fakeSheet(n); sheets.set(n, s); return s; },
    getUrl: () => "https://docs.google.com/spreadsheets/d/x",
    setActiveSheet() {}
  };
  const props = new Map();
  const sent = { emails: [], pushes: [], fetched: [], triggers: [] };
  const response = (url) => {
    const body = typeof urls === "function" ? urls(url) : urls[url];
    const code = typeof body === "number" ? body : body === undefined ? 404 : 200;
    return { getResponseCode: () => code, getContentText: () => JSON.stringify(body ?? {}) };
  };
  const trigger = (handler) => {
    const b = { timeBased: () => b, everyMinutes: () => b, forSpreadsheet: () => b, onOpen: () => b,
      create: () => { sent.triggers.push(handler); } };
    return b;
  };
  const ctx = {
    console,
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [ctx.__now])); } static now() { return ctx.__now; } },
    __now: now,
    SpreadsheetApp: {
      getActive: () => ss,
      newDataValidation: () => ({ requireCheckbox() { return this; }, build: () => ({}) }),
      getUi: () => ({ createMenu: () => { const m = { addItem: () => m, addSeparator: () => m, addToUi() {} }; return m; }, alert: (t) => { sent.uiAlert = t; } })
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => "me@example.com" }) },
    Utilities: { getUuid: () => "12345678-1234-1234-1234-123456789abc" },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: trigger },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
    MailApp: { getRemainingDailyQuota: () => 100, sendEmail: (m) => sent.emails.push(m) },
    UrlFetchApp: {
      fetch: (url, opts) => {
        if (opts?.method === "post") { sent.pushes.push(JSON.parse(opts.payload)); return response(""); }
        sent.fetched.push(url);
        return response(url);
      },
      fetchAll: (reqs) => reqs.map((r) => { sent.fetched.push(r.url); return response(r.url); })
    }
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return { ctx, sheets, props, sent };
}

const job = (over) => ({ id: "greenhouse:acme:1", company: "Acme", title: "Software Engineer Intern", location: "Austin, TX",
  url: "https://x/1", postedAt: NOW - 3600e3, firstSeen: NOW - 3600e3, countries: ["US"], roleTypes: ["Software"],
  terms: ["Summer 2027"], tags: [], ...over });

const alert = (ctx, cells) => {
  const row = [true, "Test", "", "", "", "", "", "", "", "", true, true];
  Object.entries(cells).forEach(([i, v]) => { row[i] = v; });
  return ctx.iaParseAlert(row, 2);
};
const COL = { keywords: 2, roleTypes: 3, term: 4, country: 5, cities: 6, companyTypes: 7, companies: 8, exclude: 9 };

test("reading an alert row", () => {
  const { ctx } = load();
  const a = alert(ctx, { [COL.keywords]: "Software, ML", [COL.roleTypes]: "software, Robots", [COL.country]: "us, Canada", [COL.companies]: "Jane Street, https://jobs.lever.co/acme" });
  assert.deepEqual([...a.keywords], ["software", "ml"]);
  assert.deepEqual([...a.roleTypes], ["Software"]);
  assert.deepEqual([...a.problems], ['unknown role type "Robots"']);
  assert.deepEqual([...a.countries], ["US", "CA"]);
  assert.deepEqual([...a.companies], ["jane street"]);
  assert.deepEqual([...a.companyLinks], ["https://jobs.lever.co/acme"]);
  assert.equal(ctx.iaParseAlert([false, "Paused", "x", "", "", "", "", "", "", "", true, true], 3), null);
  assert.equal(ctx.iaParseAlert([true, "", "", "", "", "", "", "", "", "", true, true], 3), null);
});

test("matching", () => {
  const { ctx } = load();
  const m = (cells, over = {}) => ctx.iaMatches(job(over), alert(ctx, cells));
  assert.ok(m({}), "an alert with no filters but a name matches everything");
  assert.ok(m({ [COL.keywords]: "software" }));
  assert.ok(!m({ [COL.keywords]: "ml" }), "whole words: 'ml' isn't in the title");
  assert.ok(!m({ [COL.keywords]: "ai" }, { title: "Maintenance Intern" }));
  assert.ok(m({ [COL.roleTypes]: "Data/AI" }, { roleTypes: [] }), "untyped titles are kept");
  assert.ok(!m({ [COL.roleTypes]: "Data/AI" }));
  assert.ok(m({ [COL.roleTypes]: "Data/AI", [COL.keywords]: "software" }), "keyword or type");
  assert.ok(m({ [COL.term]: "Summer 2027" }));
  assert.ok(m({ [COL.term]: "Summer" }));
  assert.ok(!m({ [COL.term]: "Fall 2027" }));
  assert.ok(!m({ [COL.term]: "Summer 2026" }));
  assert.ok(m({ [COL.term]: "Fall 2026, Summer 2027" }));
  assert.ok(m({ [COL.term]: "Fall 2027" }, { terms: [] }), "no term named: kept");
  assert.ok(m({ [COL.country]: "US" }));
  assert.ok(!m({ [COL.country]: "CA" }));
  assert.ok(m({ [COL.country]: "CA" }, { countries: [] }), "Remote/unknown: kept");
  assert.ok(m({ [COL.cities]: "Austin" }));
  assert.ok(m({ [COL.cities]: "Dallas, TX" }));
  assert.ok(!m({ [COL.cities]: "Dallas" }));
  assert.ok(!m({ [COL.cities]: "TX" }, { location: "Textron Park" }), "state codes match as codes");
  assert.ok(m({ [COL.cities]: "Remote" }, { location: "Remote - US" }));
  assert.ok(!m({ [COL.companyTypes]: "Big Tech" }));
  assert.ok(m({ [COL.companyTypes]: "Big Tech" }, { tags: ["Big Tech"] }));
  assert.ok(m({ [COL.companies]: "acme" }, { company: "Acme, Inc." }));
  assert.ok(m({ [COL.companies]: "Jane Street" }, { company: "Jane Street Capital" }));
  assert.ok(!m({ [COL.companies]: "Jane" }, { company: "Janet Labs" }));
  assert.ok(m({ [COL.companies]: "Stripe", [COL.companyTypes]: "Big Tech" }, { tags: ["Big Tech"] }), "company or type");
  assert.ok(!m({ [COL.exclude]: "PhD" }, { title: "PhD Software Engineer Intern" }));
});

test("email and pushes", () => {
  const { ctx } = load();
  const a = { name: "SWE" };
  const ms = (n) => Array.from({ length: n }, (_, i) => ({ job: job({ id: String(i), company: `Co${i}`, title: `Intern <${i}>` }), alerts: [a] }));
  const e = ctx.iaEmail(ms(5), NOW, "https://sheet");
  assert.equal(e.subject, "5 new internships: Co0, Co1, Co2 +2 more");
  assert.match(e.htmlBody, /Intern &lt;0&gt;/);
  assert.match(e.htmlBody, /1h ago/);
  assert.equal(ctx.iaEmail(ms(1), NOW, "s").subject, "1 new internship: Co0");
  const few = ctx.iaPushes(ms(2), "topic", "s");
  assert.equal(few.length, 2);
  assert.equal(few[0].click, "https://x/1");
  assert.equal(few[0].title, "Co0: Intern <0>");
  const many = ctx.iaPushes(ms(12), "topic", "https://sheet");
  assert.equal(many.length, 1);
  assert.equal(many[0].title, "12 new internships");
  assert.match(many[0].message, /\+4 more$/);
  assert.equal(many[0].click, "https://sheet");
});

test("board links and responses for companies checked from the sheet", () => {
  const { ctx } = load();
  assert.equal(ctx.iaBoardFromLink("https://job-boards.greenhouse.io/acme/jobs/1"), "greenhouse:acme");
  assert.equal(ctx.iaBoardFromLink("jobs.ashbyhq.com/Ramp"), "ashby:ramp");
  assert.equal(ctx.iaBoardFromLink("https://acme.com/careers"), "");
  const jobs = ctx.iaNormalize("lever:acme", [{ id: "a", text: "Intern", categories: { location: "NYC" }, hostedUrl: "h", createdAt: 5 }], "Acme");
  assert.equal(jobs[0].id, "lever:acme:a");
  assert.equal(ctx.iaNormalize("greenhouse:acme", { status: 404 }, "Acme"), null);
});

const FEED = "https://raw.githubusercontent.com/Doggo21345/internship-alerts/data/new.json";
const COMPANIES = "https://raw.githubusercontent.com/Doggo21345/internship-alerts/data/companies.json";

test("setup, first check, then only new postings", () => {
  let feed = { generatedAt: NOW, jobs: [job(), job({ id: "2", url: "https://x/2", title: "Mechanical Engineering Intern", roleTypes: ["Hardware"] }),
    job({ id: "3", url: "https://x/3", firstSeen: NOW - 2 * 86400e3 })] };
  const env = load({ urls: (u) => (u === FEED ? feed : u === COMPANIES ? { companies: ["acme"] } : undefined) });
  env.ctx.setupAlerts();
  assert.deepEqual(env.sent.triggers, ["checkAlerts", "alertsMenu"]);
  const settings = env.sheets.get("Alert settings").cells;
  assert.equal(settings[1][1], "me@example.com");
  assert.match(settings[2][1], /^intern-[0-9a-f]{16}$/);

  // The example alert (SWE Summer 2027, US, Software/Data) sees the last 24h: job 1 only.
  assert.equal(env.sent.emails.length, 1);
  assert.equal(env.sent.emails[0].to, "me@example.com");
  assert.equal(env.sent.emails[0].subject, "1 new internship: Acme");
  assert.equal(env.sent.pushes.length, 1);
  assert.equal(env.sent.pushes[0].topic, settings[2][1]);
  const matches = env.sheets.get("Matches").cells;
  assert.equal(matches.length, 2);
  assert.equal(matches[1][5], "https://x/1");
  assert.equal(matches[1][6], "SWE Summer 2027");
  assert.match(settings[4][1], /1 alert\(s\) on; 1 new match/);

  // Same feed again: nothing new.
  env.ctx.__now = NOW + 15 * 60e3;
  env.ctx.checkAlerts();
  assert.equal(env.sent.emails.length, 1);

  // Next scan finds one more.
  const later = NOW + 20 * 60e3;
  feed = { generatedAt: later, jobs: [job({ id: "4", url: "https://x/4", company: "Beta", title: "Backend Software Intern", firstSeen: later }), ...feed.jobs] };
  env.ctx.__now = later + 60e3;
  env.ctx.checkAlerts();
  assert.equal(env.sent.emails.length, 2);
  assert.equal(env.sent.emails[1].subject, "1 new internship: Beta");
  assert.equal(env.sheets.get("Matches").cells[1][1], "Beta", "newest on top");
});

test("a feed that can't be read is reported, and the cursor doesn't move", () => {
  const env = load({ urls: { [FEED]: 503 } });
  env.ctx.setupAlerts();
  assert.match(env.sheets.get("Alert settings").cells[4][1], /HTTP 503/);
  assert.equal(env.props.get("IA_CURSORS"), undefined);
});

test("a company the scanner doesn't cover is found and checked from the sheet", () => {
  const GH = "https://boards-api.greenhouse.io/v1/boards/zeta/jobs";
  let board = { jobs: [{ id: 1, title: "SWE Intern", location: { name: "NYC" }, absolute_url: "https://z/1" }] };
  const env = load({ urls: (u) => (u === FEED ? { generatedAt: NOW, jobs: [] } : u === COMPANIES ? { companies: ["acme"] } : u === GH ? board : undefined) });
  env.ctx.setupAlerts();
  const alerts = env.sheets.get("Alerts").cells;
  alerts[1] = [true, "Zeta + Nowhere", "", "", "", "", "", "", "Zeta, Nowhere Labs", "", true, false];
  alerts[2] = [false];
  env.ctx.checkAlerts();
  assert.equal(env.sent.emails.length, 0, "first read of a board is a baseline");
  assert.equal(env.sheets.get("Alert settings").cells[5][1], "Nowhere Labs");
  assert.equal(JSON.parse(env.props.get("IA_RESOLVED")).zeta.board, "greenhouse:zeta");

  board = { jobs: [...board.jobs, { id: 2, title: "Data Intern", location: { name: "NYC" }, absolute_url: "https://z/2" }, { id: 3, title: "Recruiter", absolute_url: "https://z/3" }] };
  env.ctx.checkAlerts();
  assert.equal(env.sent.emails.length, 1);
  assert.equal(env.sent.emails[0].subject, "1 new internship: Zeta");
  // Nowhere Labs isn't looked up again for a week.
  const lookups = env.sent.fetched.filter((u) => u.includes("nowhere")).length;
  env.ctx.checkAlerts();
  assert.equal(env.sent.fetched.filter((u) => u.includes("nowhere")).length, lookups);
});
