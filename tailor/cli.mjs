#!/usr/bin/env node
// Tailor a Word resume to a job.
//
//   ANTHROPIC_API_KEY=sk-ant-... node tailor/cli.mjs \
//     --resume resume.docx --job https://jobs.lever.co/acme/1234... \
//     [--bank bank.csv] [--skills skills.csv] [--jd-file jd.txt] [--out out.docx] [--model claude-sonnet-5-5]
//
// Writes the tailored copy next to your resume (never changes the original)
// plus a .changes.md listing every edit and whether it passed the checks.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tailorDocx, changesReport, readBank, readSkills, jobFromUrl, DEFAULT_MODEL } from "./tailor.mjs";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : undefined; };
const die = (msg) => { console.error(msg); process.exit(1); };

const resumePath = opt("resume");
const jobUrl = opt("job");
const jdFile = opt("jd-file");
if (!resumePath || (!jobUrl && !jdFile)) {
  die("Usage: node tailor/cli.mjs --resume resume.docx (--job <posting link> | --jd-file jd.txt) [--bank bank.csv] [--skills skills.csv] [--out out.docx] [--model id]");
}
if (!/\.docx$/i.test(resumePath)) die("The resume must be a .docx (in Word: File > Save As > Word Document; in Google Docs: File > Download > .docx).");
for (const f of [resumePath, opt("bank"), opt("skills"), jdFile].filter(Boolean)) if (!existsSync(f)) die(`Can't find ${f}`);

const label = jobUrl ? jobUrl.replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "-").slice(0, 60) : basename(jdFile).replace(/\.\w+$/, "");
const out = opt("out") || join(dirname(resumePath), `${basename(resumePath, ".docx")} - ${label}.docx`);

const result = await tailorDocx({
  resume: readFileSync(resumePath),
  job: jobUrl ? jobFromUrl(jobUrl) : null,
  jdText: jdFile ? readFileSync(jdFile, "utf8") : undefined,
  bank: opt("bank") ? readBank(readFileSync(opt("bank"), "utf8")) : [],
  skills: opt("skills") ? readSkills(readFileSync(opt("skills"), "utf8")) : [],
  key: process.env.ANTHROPIC_API_KEY,
  model: opt("model") || DEFAULT_MODEL
});

const report = changesReport(result, { job: jobUrl || jdFile, resumeName: basename(resumePath) });
if (result.output) {
  writeFileSync(out, result.output);
  writeFileSync(out.replace(/\.docx$/i, ".changes.md"), report);
  console.log(`${result.status}: ${out}\nEvery edit: ${out.replace(/\.docx$/i, ".changes.md")}\n`);
} else {
  console.log(`${result.status}. Nothing written.\n`);
}
for (const c of result.changes) console.log(`[${c.check}] ${c.section}\n  - ${c.before}\n  + ${c.after}\n`);
for (const n of result.notes) console.log("note: " + n);
if (result.status === "Failed") process.exit(1);
