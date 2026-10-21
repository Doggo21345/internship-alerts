// Just enough of Apps Script to run Alerts.gs in Node: an in-memory spreadsheet,
// fake fetch/mail/properties, and a log of what got sent.
import { readFileSync } from "node:fs";
import vm from "node:vm";

class FakeRange {
  constructor(sheet, r, c, nr = 1, nc = 1) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() {
    return Array.from({ length: this.nr }, (_, i) => Array.from({ length: this.nc }, (_, j) => this.sheet.cell(this.r + i, this.c + j)));
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(v) { v.forEach((row, i) => row.forEach((x, j) => this.sheet.set(this.r + i, this.c + j, x))); return this; }
  setValue(x) { this.sheet.set(this.r, this.c, x); return this; }
  clearContent() { this.setValues(this.getValues().map((row) => row.map(() => ""))); return this; }
  setNotes() { return this; } setFontWeight() { return this; } setDataValidation() { return this; }
  setNumberFormat() { return this; } setFontColor() { return this; }
}

class FakeSheet {
  constructor(name) { this.name = name; this.rows = []; }
  cell(r, c) { return this.rows[r - 1]?.[c - 1] ?? ""; }
  set(r, c, x) { while (this.rows.length < r) this.rows.push([]); this.rows[r - 1][c - 1] = x; }
  getRange(r, c, nr, nc) { return new FakeRange(this, r, c, nr, nc); }
  getLastRow() {
    for (let i = this.rows.length; i > 0; i--) if ((this.rows[i - 1] || []).some((x) => x !== "" && x !== undefined)) return i;
    return 0;
  }
  insertRowsBefore(r, n) { this.rows.splice(r - 1, 0, ...Array.from({ length: n }, () => [])); }
  setFrozenRows() {} setColumnWidth() { return this; } setColumnWidths() { return this; }
  getName() { return this.name; }
}

export function loadAlerts({ responses = {}, now = Date.now(), files = ["Alerts.gs"], extra = {} } = {}) {
  const sheets = new Map();
  const props = new Map();
  const sent = { emails: [], pushes: [], fetched: [] };
  const response = (url, opts = {}) => {
    sent.fetched.push(url);
    if (url === "https://ntfy.sh/") { sent.pushes.push(JSON.parse(opts.payload)); return resp(200, "{}"); }
    const r = typeof responses === "function" ? responses(url, opts) : responses[url];
    if (r && r.__status) return resp(r.__status, typeof r.body === "string" ? r.body : JSON.stringify(r.body));
    if (typeof r === "string") return resp(200, r);
    return r === undefined ? resp(404, "") : resp(200, JSON.stringify(r));
  };
  const resp = (code, text) => ({ getResponseCode: () => code, getContentText: () => text });
  const ss = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = new FakeSheet(n); sheets.set(n, s); return s; },
    getUrl: () => "https://docs.google.com/spreadsheets/d/test",
    setActiveSheet: () => {}
  };
  const context = {
    console,
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } },
    SpreadsheetApp: {
      getActive: () => ss,
      newDataValidation: () => ({ requireCheckbox() { return this; }, build() { return {}; } }),
      getUi: () => ({ alert: (m) => { sent.uiAlert = m; }, createMenu() { const m = { addItem: () => m, addSeparator: () => m, addToUi: () => {} }; return m; } })
    },
    UrlFetchApp: { fetch: response, fetchAll: (reqs) => reqs.map((r) => response(r.url, r)) },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }),
      getUserProperties: () => ({ getProperty: (k) => props.get("user:" + k) ?? null, setProperty: (k, v) => props.set("user:" + k, v) })
    },
    MailApp: { getRemainingDailyQuota: () => 100, sendEmail: (m) => sent.emails.push(m) },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
      getDocumentLock: () => ({ tryLock: () => true, releaseLock: () => {} })
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => "me@example.com" }), getScriptTimeZone: () => "UTC" },
    Utilities: {
      getUuid: () => "0123456789abcdef0123456789abcdef",
      formatDate: (d) => new Date(d).toISOString().slice(0, 10)
    },
    ScriptApp: {
      triggers: [],
      getProjectTriggers() { return this.triggers; },
      deleteTrigger() {},
      newTrigger(fn) {
        const t = { fn, timeBased: () => t, everyMinutes: () => t, everyDays: () => t, atHour: (h) => { t.hour = h; return t; }, forSpreadsheet: () => t, onOpen: () => t,
          create: () => { context.ScriptApp.triggers.push({ getHandlerFunction: () => fn }); } };
        return t;
      }
    }
  };
  Object.assign(context, extra);
  vm.createContext(context);
  for (const f of files) vm.runInContext(readFileSync(new URL("../apps-script/" + f, import.meta.url), "utf8"), context);
  return { gas: context, sheets, props, sent, setNow: (t) => { now = t; } };
}
