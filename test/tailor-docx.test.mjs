import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { openDocx } from "../tailor/docx.mjs";
import { tailorDocx, readBank, readSkills, parseCsv, jobFromUrl, changesReport, loadTailorGs } from "../tailor/tailor.mjs";
import { fetchAllSync } from "../tailor/fetch-sync.mjs";
import { makeDocx, readDocx, para, tableXml } from "./docx-fixture.mjs";

const JD = "We want an intern who builds data pipelines in SQL and Python, works in Agile teams, and ships dashboards. ".repeat(5);

const resume = () => makeDocx([
  para("Alex Doe", { bold: true }),
  para("EXPERIENCE", { bold: true }),
  para("", { runs: [["Amazon", true], [" — Data Engineering Intern", false]] }),
  para("Built dashboards for the analytics team in Tableau to track weekly signups and churn", { list: true, runs: [["Built", true], [" dashboards for the analytics team in Tableau to track weekly signups and churn", false]] }),
  para("Automated weekly reports with Python, saving 6 hours a week", { list: true }),
  para("", { raw: '<w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:hyperlink r:id="rId9"><w:r><w:t>Shipped github.com/alex/rover</w:t></w:r></w:hyperlink></w:p>' }),
  para("Robotics Club — Software Lead"),
  para("Led a team of 8 students to build an autonomous rover for competition", { list: true }),
  para("Technical Skills", { bold: true }),
  para("", { runs: [["Languages:", true], [" Python, Java, C++, JavaScript, Go, Kotlin", false]] }),
  para("", { runs: [["Methodologies:", true], [" Agile, Scrum", false]] }),
  para("EDUCATION", { bold: true }),
  para("GPA 3.9", { list: true })
]);

const BANK = "Experience,Bullet,Skills it shows\nAmazon,\"Built a SQL pipeline that cut weekly report prep from 6 hours to 20 minutes\",SQL\nRobotics Club,Wrote the rover's path planner in C++,C++\n";
const SKILLS = "Category,Items\nLanguages,\"Python, Java, SQL\"\nMethodologies,\"Agile, Scrum, CI/CD\"\n";

/** Claude and job-site stand-in for fetchAll. */
function fakeNet(script, { jd = { content: JD } } = {}) {
  const calls = [];
  const fetchAll = (reqs) => reqs.map((r) => {
    if (r.url === "https://api.anthropic.com/v1/messages") {
      const body = JSON.parse(r.payload);
      calls.push(body);
      const kind = body.system.startsWith("You tailor one role") ? "bullets" : body.system.startsWith("You tailor the skills") ? "skills" : "verify";
      return { code: 200, text: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(script[kind](body.messages[0].content)) }], stop_reason: "end_turn" }) };
    }
    if (r.url === "https://boards-api.greenhouse.io/v1/boards/acme/jobs/42") return { code: 200, text: JSON.stringify(jd) };
    return { code: 404, text: "" };
  });
  return { calls, fetchAll };
}

const script = {
  bullets: (user) => user.includes("Amazon") ? { jd_found: true, bullets: [
    { id: "b0", action: "swap", bank_id: "k2", text: "Built a SQL pipeline that cut weekly report prep from 6 hours to 20 minutes", reason: "" },
    { id: "b1", action: "reword", bank_id: "", text: "Automated weekly reports in Python, cutting 40% of prep time", reason: "" }
  ] } : { jd_found: true, bullets: [] },
  skills: () => ({ lines: [{ id: "s3", items: ["Python", "SQL", "Java", "Rust"] }, { id: "s4", items: ["Agile", "Scrum", "CI/CD"] }] }),
  verify: (user) => ({ verdicts: [...user.matchAll(/<edit id="(e\d+)">/g)].map(([, id]) => ({ id, ok: true, problem: "" })) })
};

test("Word files read like Google Docs: list items, labels, linked bullets left alone, tables", async () => {
  const gas = loadTailorGs();
  const doc = await openDocx(await resume());
  const out = gas.tlOutline(doc.body);
  assert.deepEqual([...out.map((i) => i.id)], ["b0", "b1", "b2", "s3", "s4"], "the linked bullet and education aren't offered");
  assert.equal(out[0].entry, "Amazon — Data Engineering Intern");
  assert.equal(out[3].label, "Languages");

  const t = await openDocx(await makeDocx([tableXml([[para("Experience"), para("Acme — Intern"), para("• Wrote tests for billing")]])]));
  assert.deepEqual([...gas.tlOutline(t.body).map((i) => i.text)], ["Wrote tests for billing"]);
});

test("tailoring a .docx: edits land in the right runs, formatting and the original untouched", async () => {
  const original = await resume();
  const net = fakeNet(script);
  const r = await tailorDocx({ resume: original, job: jobFromUrl("https://job-boards.greenhouse.io/acme/jobs/42"),
    bank: readBank(BANK), skills: readSkills(SKILLS), key: "sk-ant-x", fetchAll: net.fetchAll, pages: null });
  assert.equal(r.status, "Done");
  const paras = await readDocx(r.output);
  const swapped = paras[3];
  assert.equal(swapped.text, "Built a SQL pipeline that cut weekly report prep from 6 hours to 20 minutes");
  assert.equal(swapped.list, true, "still a bullet");
  assert.equal(swapped.runs[0].bold, true, "takes the first character's formatting");
  assert.equal(swapped.runs[0].size, "21");
  assert.equal(paras[4].text, "Automated weekly reports with Python, saving 6 hours a week", "invented 40% rejected");
  assert.equal(paras[5].text, "Shipped github.com/alex/rover", "linked bullet untouched");
  const methods = paras[10];
  assert.equal(methods.text, "Methodologies: Agile, Scrum, CI/CD");
  assert.equal(methods.runs[0].bold, true);
  assert.equal(methods.runs.at(-1).bold, false);
  assert.equal(paras[9].text, "Languages: Python, Java, C++, JavaScript, Go, Kotlin", "Rust isn't yours: line unchanged");
  assert.equal((await readDocx(original))[3].text.startsWith("Built dashboards"), true);

  assert.ok(r.changes.some((c) => c.from === "Bullet bank row 2" && c.check === "Applied"));
  assert.ok(r.notes.some((n) => /numbers not in the source: 40%/.test(n)));
  assert.ok(r.notes.some((n) => /page check skipped/.test(n)), "no page counter: says so");
  const md = changesReport(r, { job: "acme", resumeName: "resume.docx" });
  assert.match(md, /\| Amazon — Data Engineering Intern \| Built dashboards/);
  assert.equal(net.calls[0].model, "claude-opus-5-5");
});

test("page overflow undoes the biggest edit", async () => {
  const net = fakeNet({ ...script, skills: () => ({ lines: [] }) });
  let n = 0;
  const pages = () => [1, 2, 1][n++] ?? 1; // original 1, tailored 2, after undo 1
  const r = await tailorDocx({ resume: await resume(), job: jobFromUrl("https://job-boards.greenhouse.io/acme/jobs/42"),
    bank: readBank(BANK), skills: [], key: "k", fetchAll: net.fetchAll, pages });
  assert.equal(r.status, "Done (no changes)");
  assert.equal(r.changes[0].check, "Undone: page overflow");
  assert.ok(r.notes.some((x) => /after undoing 1 edit/.test(x)));
});

test("no key or no description: nothing is called or written", async () => {
  const net = fakeNet(script, { jd: { content: "short" } });
  const a = await tailorDocx({ resume: await resume(), job: jobFromUrl("https://job-boards.greenhouse.io/acme/jobs/42"), key: "k", fetchAll: net.fetchAll, pages: null });
  assert.equal(a.status, "Needs job description");
  const b = await tailorDocx({ resume: await resume(), jdText: JD, key: "", fetchAll: net.fetchAll, pages: null });
  assert.equal(b.status, "Failed");
  assert.equal(net.calls.length, 0);
});

test("CSV and posting links", () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","he said ""hi"""\r\nz,\n'), [["a", "b"], ["x, y", 'he said "hi"'], ["z", ""]]);
  assert.deepEqual(readBank(BANK).map((b) => b.id), ["k2", "k3"]);
  assert.deepEqual(readSkills(SKILLS)[1].items, ["Agile", "Scrum", "CI/CD"]);
  assert.equal(jobFromUrl("https://job-boards.greenhouse.io/acme/jobs/42").id, "greenhouse:acme:42");
  assert.equal(jobFromUrl("https://jobs.lever.co/acme/b2fa7adc-21bf-4cca-a50b-d48d61970cbb/apply").id, "lever:acme:b2fa7adc-21bf-4cca-a50b-d48d61970cbb");
  assert.equal(jobFromUrl("https://jobs.ashbyhq.com/sierra/7af8aa4e-ba84-49ba-bc53-19358f4564ff").id, "ashby:sierra:7af8aa4e-ba84-49ba-bc53-19358f4564ff");
  assert.equal(jobFromUrl("https://jobs.smartrecruiters.com/AECOM2/744000145646439").id, "smartrecruiters:AECOM2:744000145646439");
  assert.match(jobFromUrl("https://fmr.wd1.myworkdayjobs.com/targeted/job/PA/Intern_1").id, /^workday:fmr\.wd1\.myworkdayjobs\.com\/targeted:/);
  assert.equal(jobFromUrl("https://careers.google.com/jobs/1").id, "url:https://careers.google.com/jobs/1");
});

test("fetchAllSync really fetches, in parallel, from a separate process", async () => {
  const server = spawn(process.execPath, ["-e",
    'const s = require("http").createServer((q, r) => setTimeout(() => r.end(JSON.stringify({ path: q.url, method: q.method })), 300));' +
    's.listen(0, "127.0.0.1", () => console.log("PORT " + s.address().port));']);
  const port = await new Promise((resolve) => server.stdout.on("data", (d) => { const m = String(d).match(/PORT (\d+)/); if (m) resolve(m[1]); }));
  try {
    const t0 = Date.now();
    const res = fetchAllSync([{ url: `http://127.0.0.1:${port}/a` }, { url: `http://127.0.0.1:${port}/b`, method: "post", payload: "x" }]);
    assert.deepEqual(res.map((r) => JSON.parse(r.text)), [{ path: "/a", method: "GET" }, { path: "/b", method: "POST" }]);
    assert.ok(Date.now() - t0 < 1500, "both at once");
  } finally {
    server.kill();
  }
});
