// Tailors a Word resume to one job, using the same code as the Google Sheets
// version (apps-script/Tailor.gs): same prompts, same checks, same review.
// Tailor.gs is loaded as-is; docx.mjs stands in for Google Docs and
// fetch-sync.mjs for UrlFetchApp.

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { openDocx, ElementType } from "./docx.mjs";
import { urlFetchApp, fetchAllSync } from "./fetch-sync.mjs";
import { parseBoardUrl } from "../lib/ats.js";

export const DEFAULT_MODEL = "claude-opus-5-5";

/** Tailor.gs's functions, with the Apps Script services it needs for tailoring. */
export function loadTailorGs({ fetchAll = fetchAllSync } = {}) {
  const context = { console, DocumentApp: { ElementType }, UrlFetchApp: urlFetchApp(fetchAll) };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL("../apps-script/Tailor.gs", import.meta.url), "utf8"), context);
  return context;
}

// ---- Inputs -------------------------------------------------------------------------

/** CSV text -> rows of strings. Handles quotes, commas and newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  const s = String(text).replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Bullet bank CSV (Experience, Bullet, Skills it shows) -> Tailor.gs's bank. Ids are CSV line numbers, like sheet rows. */
export function readBank(text) {
  return parseCsv(text).slice(1)
    .map((r, i) => ({ id: "k" + (i + 2), experience: (r[0] || "").trim(), text: (r[1] || "").trim(), skills: (r[2] || "").trim() }))
    .filter((b) => b.experience && b.text);
}

/** Skills bank CSV (Category, Items) -> Tailor.gs's skills bank. */
export function readSkills(text) {
  return parseCsv(text).slice(1)
    .map((r) => ({ category: (r[0] || "").trim(), items: (r[1] || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean) }))
    .filter((c) => c.category && c.items.length);
}

/**
 * A posting link -> the job Tailor.gs expects ({id, url}), so its description
 * comes from the job site's API. Other links are read as a web page.
 */
export function jobFromUrl(url) {
  const b = parseBoardUrl(url);
  const tail = (re) => (String(url).match(re) || [])[1];
  let jobId = "";
  if (b?.ats === "greenhouse") jobId = tail(/[?&](?:gh_jid|token)=(\d+)/) || tail(/\/jobs\/(\d+)/);
  else if (b?.ats === "lever" || b?.ats === "ashby") jobId = tail(/\/\/[^/]+\/[^/]+\/([0-9a-f-]{20,})/i);
  else if (b?.ats === "smartrecruiters") jobId = tail(/smartrecruiters\.com\/[^/]+\/(\d+)/);
  else if (b?.ats === "workday") jobId = "x"; // Tailor.gs reads Workday's path from the URL
  return b && jobId ? { id: `${b.key}:${jobId}`, url } : { id: "url:" + url, url };
}

// ---- Page count ----------------------------------------------------------------------

const SOFFICE = ["soffice", "libreoffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice"];

/** A function that counts a .docx's pages with LibreOffice, or null when LibreOffice isn't installed. */
export function libreOfficePages(gas) {
  const bin = SOFFICE.find((b) => (b.startsWith("/") ? existsSync(b) : spawnSync("which", [b]).status === 0));
  if (!bin) return null;
  return (buffer) => {
    const dir = mkdtempSync(join(tmpdir(), "tailor-"));
    try {
      writeFileSync(join(dir, "r.docx"), buffer);
      const r = spawnSync(bin, ["--headless", "--convert-to", "pdf", "--outdir", dir, join(dir, "r.docx")], { timeout: 120000 });
      if (r.status !== 0 || !existsSync(join(dir, "r.pdf"))) return null;
      return gas.tlPdfPages(readFileSync(join(dir, "r.pdf")).toString("latin1"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// ---- Tailoring -----------------------------------------------------------------------

/**
 * Tailors `resume` (a .docx Buffer). Returns {status, output (Buffer, when
 * something changed), changes: [{section, before, after, from, check}], notes}.
 * Pass jdText to skip fetching the posting. `pages` counts a docx's pages
 * (null: skip the page check).
 */
export async function tailorDocx({ resume, job, jdText, bank = [], skills = [], key, model = DEFAULT_MODEL, fetchAll = fetchAllSync, pages }) {
  const gas = loadTailorGs({ fetchAll });
  const countPages = pages === undefined ? libreOfficePages(gas) : pages;
  const doc = await openDocx(resume);
  const outline = gas.tlOutline(doc.body);
  if (!outline.length) {
    return { status: "Failed", notes: ["Found no bullets under an Experience/Projects heading and no Skills lines."], changes: [] };
  }
  const jd = jdText ? { text: String(jdText).slice(0, 15000), generic: false } : gas.tlFetchJd_(job);
  if (jd.text.length < 300) {
    return { status: "Needs job description", notes: ["Couldn't read the posting. Save it to a text file and pass --jd-file."], changes: [] };
  }
  if (!key) return { status: "Failed", notes: ["No Claude API key: set ANTHROPIC_API_KEY."], changes: [] };

  const callClaude = (calls) => gas.tlClaudeAll_(key, model, calls);
  const { edits, notes, jdMissing } = gas.tlPropose(outline, jd, bank, skills, callClaude);
  if (jdMissing && !edits.length) {
    return { status: "Needs job description", notes: ["That page doesn't contain the job description. Pass --jd-file."], changes: [] };
  }
  const rejected = gas.tlVerify(edits, callClaude);
  const kept = edits.filter((e, i) => !(i in rejected));
  for (const i of Object.keys(rejected)) notes.push(`review: "${edits[i].after.slice(0, 50)}…" ${rejected[i]}`);
  for (const e of kept) gas.tlReplaceFrom(e.item.el, e.item.prefix.length, e.after);
  let output = await doc.save();

  // The copy must fit on as many pages as the resume. Undo the edits that grew most until it does.
  if (kept.length && countPages) {
    const before = countPages(resume);
    let after = countPages(output);
    const byGrowth = kept.slice().sort((a, b) => (b.after.length - b.before.length) - (a.after.length - a.before.length));
    let undone = 0;
    while (before && after > before && undone < Math.min(byGrowth.length, 4)) {
      const e = byGrowth[undone++];
      const again = await openDocx(output);
      const item = gas.tlOutline(again.body).find((x) => x.id === e.item.id);
      if (item) gas.tlReplaceFrom(item.el, item.prefix.length, e.before);
      e.undone = true;
      output = await again.save();
      after = countPages(output);
    }
    if (!before || !after) notes.push("page check failed: LibreOffice couldn't convert the file");
    else notes.push(after > before ? `still ${after} pages vs ${before}: check the layout`
      : `${after} page${after === 1 ? "" : "s"}, same as your resume${undone ? `, after undoing ${undone} edit(s)` : ""}`);
  } else if (kept.length) {
    notes.push("page check skipped: install LibreOffice to have it checked");
  }

  const changes = edits.map((e, i) => ({
    section: e.item.kind === "skills" ? (e.item.label || "Skills") : (e.item.entry || e.item.section),
    before: e.before, after: e.after, from: e.from,
    check: i in rejected ? "Rejected: " + rejected[i] : e.undone ? "Undone: page overflow" : "Applied"
  }));
  const applied = changes.filter((c) => c.check === "Applied").length;
  return { status: applied ? "Done" : "Done (no changes)", output: applied ? output : null, changes, notes };
}

/** The changes as a Markdown report. */
export function changesReport(result, { job, resumeName }) {
  const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [`# ${resumeName} tailored for ${job}`, "", `Status: ${result.status}`, ""];
  if (result.changes.length) {
    lines.push("| Section | Before | After | From | Check |", "|---|---|---|---|---|");
    for (const c of result.changes) lines.push(`| ${esc(c.section)} | ${esc(c.before)} | ${esc(c.after)} | ${esc(c.from)} | ${esc(c.check)} |`);
    lines.push("");
  }
  if (result.notes.length) lines.push("## Notes", "", ...result.notes.map((n) => `- ${n}`), "");
  lines.push("Read it over before you send it: the checks catch invented numbers and unsupported claims, but you know your experience best.");
  return lines.join("\n") + "\n";
}
