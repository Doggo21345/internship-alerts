import test from "node:test";
import assert from "node:assert/strict";
import { loadAlerts } from "./gas-fakes.mjs";
import { fakeDrive, p, li, table } from "./doc-fakes.mjs";

const JD = "We want an intern who builds data pipelines in SQL and Python, works in Agile teams, and ships dashboards. ".repeat(5);

const resume = () => [
  p("Alex Doe"),
  p("EXPERIENCE"),
  p("Amazon — Data Engineering Intern"),
  p("Seattle, WA | Jun 2026 – Aug 2026"),
  li("Built dashboards for the analytics team in Tableau to track weekly signups and churn", { BOLD: true }),
  li("Automated weekly reports with Python, saving 6 hours a week"),
  p("Robotics Club — Software Lead"),
  li("Led a team of 8 students to build an autonomous rover for competition"),
  p("Technical Skills"),
  p("Languages: Python, Java, C++, JavaScript, Go, Kotlin"),
  p("Methodologies: Agile, Scrum"),
  p("EDUCATION"),
  p("University of Texas at Austin"),
  li("GPA 3.9")
];

/** Claude stand-in: decides by which system prompt the request carries. */
function claude(script) {
  const calls = [];
  const handler = (opts) => {
    const body = JSON.parse(opts.payload);
    calls.push(body);
    const kind = body.system.startsWith("You tailor one role") ? "bullets" : body.system.startsWith("You tailor the skills") ? "skills" : "verify";
    const data = script[kind](body.messages[0].content, body);
    if (data && data.__status) return data;
    return { content: [{ type: "text", text: JSON.stringify(data) }], stop_reason: "end_turn" };
  };
  return { calls, handler };
}

function setup({ script, charsPerPage, jd = { content: JD } } = {}) {
  const drive = fakeDrive({ charsPerPage });
  const resumeId = drive.add("Alex Doe Resume", resume());
  const ai = claude(script);
  const env = loadAlerts({
    files: ["Alerts.gs", "Tailor.gs"],
    extra: { DriveApp: drive.DriveApp, DocumentApp: drive.DocumentApp },
    responses: (url, opts) => {
      if (url === "https://api.anthropic.com/v1/messages") return ai.handler(opts);
      if (url === "https://boards-api.greenhouse.io/v1/boards/acme/jobs/42") return jd;
      if (url === "https://careers.example.com/job/1") return "<html><script>var x=1</script><body>Sign in to see jobs</body></html>".padEnd(400, " ");
      return undefined;
    }
  });
  env.gas.setupTailor();
  const settings = env.sheets.get("Resume settings");
  settings.set(2, 2, `https://docs.google.com/document/d/${resumeId}/edit`);
  env.props.set("user:TL_CLAUDE_KEY", "sk-ant-test");
  return { ...env, drive, resumeId, ai };
}

const job = { id: "greenhouse:acme:42", company: "Acme", title: "Data Intern", url: "https://acme.com/jobs/42" };

const goodScript = {
  bullets: (user) => user.includes("Amazon") ? { jd_found: true, bullets: [
    { id: "b0", action: "swap", bank_id: "k2", text: "Built a SQL pipeline that cut weekly report prep from 6 hours to 20 minutes", reason: "SQL" },
    { id: "b1", action: "reword", bank_id: "", text: "Automated weekly reports in Python, cutting 40% of prep time", reason: "made up number" }
  ] } : { jd_found: true, bullets: [
    { id: "b2", action: "reword", bank_id: "", text: "Led 8 students in Agile sprints to ship an autonomous competition rover", reason: "agile" }
  ] },
  skills: () => ({ lines: [{ id: "s3", items: ["Python", "SQL", "Java", "Rust"] }, { id: "s4", items: ["Agile", "Scrum", "CI/CD"] }] }),
  verify: (user) => {
    const ids = [...user.matchAll(/<edit id="(e\d+)">[\s\S]*?<new>([\s\S]*?)<\/new>/g)];
    return { verdicts: ids.map(([, id, after]) => ({ id, ok: !/Agile sprints/.test(after), problem: /Agile sprints/.test(after) ? "source doesn't mention Agile" : "" })) };
  }
};

test("outline: bullets by role, skills lines with labels, education left alone, tables included", () => {
  const { gas, drive } = setup({ script: goodScript });
  const id = drive.add("r", resume());
  const out = gas.tlOutline(gas.DocumentApp.openById(id).getBody());
  assert.deepEqual([...out.map((i) => i.id)], ["b0", "b1", "b2", "s3", "s4"]);
  assert.equal(out[0].entry, "Amazon — Data Engineering Intern — Seattle, WA | Jun 2026 – Aug 2026");
  assert.equal(out[2].entry, "Robotics Club — Software Lead");
  assert.equal(out[3].label, "Languages");
  assert.deepEqual([...out[3].items], ["Python", "Java", "C++", "JavaScript", "Go", "Kotlin"]);

  const t = drive.add("t", [table([[[p("Experience"), p("Acme — Intern"), p("• Wrote tests for the billing service")]]])]);
  const tout = gas.tlOutline(gas.DocumentApp.openById(t).getBody());
  assert.equal(tout.length, 1);
  assert.equal(tout[0].text, "Wrote tests for the billing service");
  assert.equal(tout[0].prefix, "• ");
});

test("code checks: numbers must come from the source, length stays put, skills must be yours", () => {
  const { gas } = setup({ script: goodScript });
  const before = "Automated weekly reports with Python, saving 6 hours a week";
  assert.deepEqual([...gas.tlCheckBullet(before, "Automated weekly Python reports, saving 6 hours each week", before)], []);
  assert.match(gas.tlCheckBullet(before, "Automated reports in Python, saving 40% of time", before).join(), /numbers not in the source: 40%/);
  assert.match(gas.tlCheckBullet(before, before + " for the entire analytics org of the company", before).join(), /too long/);
  assert.match(gas.tlCheckBullet(before, "I automated weekly reports with Python, saving 6 hours", before).join(), /first person/);
  assert.deepEqual([...gas.tlNumbers("cut 12,000 rows by 35% and $1.5k, 2M users")], ["12000", "35%", "$1.5k", "2m"]);
  const line = { items: ["Python", "Java"], sep: ", " };
  assert.match(gas.tlCheckSkills(line, ["Python", "Rust"], ["Python", "Java"]).join(), /Rust/);
  assert.deepEqual([...gas.tlCheckSkills(line, ["Java", "Python"], ["Python", "Java"])], []);
});

test("tailoring: good edits applied to a copy, bad ones rejected by checks or review, formatting kept", () => {
  const { gas, sheets, drive, resumeId, ai } = setup({ script: goodScript });
  const result = gas.tlTailor_(gas.SpreadsheetApp.getActive(), job);
  assert.equal(result.status, "Done");
  const copyId = result.url.match(/\/d\/(\w+)/)[1];
  assert.notEqual(copyId, resumeId);
  assert.match(drive.text(resumeId), /Built dashboards for the analytics team in Tableau/, "original untouched");

  const out = drive.text(copyId);
  assert.match(out, /Built a SQL pipeline that cut weekly report prep from 6 hours to 20 minutes/, "bank swap applied");
  assert.match(out, /Automated weekly reports with Python, saving 6 hours a week/, "invented 40% rejected by code");
  assert.match(out, /Led a team of 8 students to build an autonomous rover/, "review rejected the Agile claim");
  assert.match(out, /Languages: Python, Java, C\+\+, JavaScript, Go, Kotlin/, "Rust isn't yours, so that line is unchanged");
  assert.match(out, /Methodologies: Agile, Scrum, CI\/CD/, "CI/CD is in the Skills bank");
  assert.match(out, /GPA 3.9/);

  const doc = gas.DocumentApp.openById(copyId).getBody();
  const swapped = doc.children[4];
  assert.equal(swapped.text.chars[0].attrs.BOLD, true, "kept the bullet's formatting");
  assert.equal(swapped.text.chars.at(-1).attrs.BOLD, true);

  const changes = sheets.get("Tailor changes");
  const statuses = [];
  for (let r = 2; r <= changes.getLastRow(); r++) statuses.push(`${changes.cell(r, 5)} | ${changes.cell(r, 6)}`);
  assert.ok(statuses.some((s) => /Bullet bank row 2 \| Applied/.test(s)), statuses.join("\n"));
  assert.ok(statuses.some((s) => /Reworded \| Rejected: source doesn't mention Agile/.test(s)), statuses.join("\n"));
  assert.match(result.checks, /numbers not in the source: 40%/);
  assert.match(result.checks, /Rust/);

  const first = ai.calls[0];
  assert.equal(first.model, "claude-opus-5-5");
  assert.equal(first.fallbacks, "default");
  assert.equal(first.output_config.format.type, "json_schema");
  assert.match(first.messages[0].content, /k2: Built a SQL pipeline/, "only that role's bank bullets are offered");
  assert.ok(!ai.calls.find((c) => c.system.startsWith("You tailor one role") && /Robotics/.test(c.messages[0].content)).messages[0].content.includes("k2:"));
});

test("an edit that pushes the copy onto another page is undone", () => {
  const total = resume().map((x) => x.getText().length + 1).reduce((a, b) => a + b);
  const grow = { ...goodScript, bullets: (user) => user.includes("Amazon") ? { jd_found: true, bullets: [
    { id: "b1", action: "reword", bank_id: "", text: "Automated weekly team reports with Python, saving 6 hours a week", reason: "" }] } : { jd_found: true, bullets: [] },
    skills: () => ({ lines: [] }), verify: () => ({ verdicts: [{ id: "e0", ok: true, problem: "" }] }) };
  const { gas, drive, sheets } = setup({ script: grow, charsPerPage: total + 3 });
  const result = gas.tlTailor_(gas.SpreadsheetApp.getActive(), job);
  assert.equal(result.status, "Done (no changes)");
  assert.match(drive.text(result.url.match(/\/d\/(\w+)/)[1]), /Automated weekly reports with Python, saving 6 hours a week/);
  assert.match(result.checks, /after undoing 1 edit/);
  assert.equal(sheets.get("Tailor changes").cell(2, 6), "Undone: page overflow");
});

test("no job description: nothing is made, and you're asked to paste one", () => {
  const { gas, drive } = setup({ script: goodScript, jd: { content: "short" } });
  const before = drive.files.size;
  const r = gas.tlTailor_(gas.SpreadsheetApp.getActive(), job);
  assert.equal(r.status, "Needs job description");
  assert.equal(drive.files.size, before);

  const noJd = { ...goodScript, bullets: () => ({ jd_found: false, bullets: [] }), skills: () => ({ lines: [] }) };
  const env2 = setup({ script: noJd });
  const r2 = env2.gas.tlTailor_(env2.gas.SpreadsheetApp.getActive(), { ...job, id: "simplify:abc", url: "https://careers.example.com/job/1", pastedJd: "" });
  assert.equal(r2.status, "Needs job description");
  assert.ok([...env2.drive.files.values()].filter((f) => !f.trashed).length === 1, "the copy was trashed");
});

test("a failed review rejects every edit", () => {
  const { gas, drive } = setup({ script: { ...goodScript, verify: () => ({ __status: 529, body: { error: { message: "overloaded" } } }) } });
  const r = gas.tlTailor_(gas.SpreadsheetApp.getActive(), job);
  assert.equal(r.status, "Done (no changes)");
  assert.match(drive.text(r.url.match(/\/d\/(\w+)/)[1]), /Built dashboards for the analytics team in Tableau/);
});

test("a 400 about fallbacks is retried without them", () => {
  let n = 0;
  const script = { ...goodScript, bullets: (user, body) => {
    if (body.fallbacks) { n++; return { __status: 400, body: { error: { message: "fallbacks: not supported here" } } }; }
    return goodScript.bullets(user);
  } };
  const { gas } = setup({ script });
  const r = gas.tlTailor_(gas.SpreadsheetApp.getActive(), job);
  assert.equal(n, 2);
  assert.equal(r.status, "Done");
});

test("job description requests for each board", () => {
  const { gas } = setup({ script: goodScript });
  const url = (j) => gas.tlJdRequest(j)[0].url;
  assert.equal(url({ id: "greenhouse:acme:42" }), "https://boards-api.greenhouse.io/v1/boards/acme/jobs/42");
  assert.equal(url({ id: "lever:acme:abc-1" }), "https://api.lever.co/v0/postings/acme/abc-1");
  assert.equal(url({ id: "ashby:mistral ai:x" }), "https://api.ashbyhq.com/posting-api/job-board/mistral%20ai");
  assert.equal(url({ id: "smartrecruiters:AECOM2:7440" }), "https://api.smartrecruiters.com/v1/companies/AECOM2/postings/7440");
  assert.equal(url({ id: "workday:fmr.wd1.myworkdayjobs.com/targeted:2135720", url: "https://fmr.wd1.myworkdayjobs.com/targeted/job/PA/Intern_2135720-1" }),
    "https://fmr.wd1.myworkdayjobs.com/wday/cxs/fmr/targeted/job/PA/Intern_2135720-1");
  assert.equal(url({ id: "simplify:1", url: "https://jobs.example.com/1" }), "https://jobs.example.com/1");
  assert.equal(gas.tlText("&lt;p&gt;Build &amp;amp; ship&lt;/p&gt;&lt;ul&gt;&lt;li&gt;SQL&lt;/li&gt;&lt;/ul&gt;"), "Build & ship\n- SQL");
  assert.equal(gas.tlPdfPages("<< /Type /Pages /Count 2 /Kids [1 0 R 2 0 R] >>"), 2);
});

test("background: new matches from chosen alerts get tailored, within the daily limit", () => {
  const { gas, sheets, sent } = setup({ script: goodScript });
  const ss = gas.SpreadsheetApp.getActive();
  gas.iaMatchesSheet_(ss, "Matches");
  const m = sheets.get("Matches");
  const now = Date.now();
  m.setValues = undefined;
  const row = (id, alert) => [new Date(now - 3600e3), "Acme", "Data Intern", "", "", "https://acme.com/jobs/42", alert, "", id];
  m.getRange(2, 1, 3, 9).setValues([row("greenhouse:acme:42", "SWE"), row("greenhouse:acme:43", "Other"), row("greenhouse:acme:42b", "swe, Other")]);
  const settings = sheets.get("Resume settings");
  settings.set(4, 2, "SWE");
  settings.set(5, 2, 1);
  gas.tailorQueue();
  const log = sheets.get("Tailored");
  assert.equal(log.getLastRow(), 2, "daily limit of 1");
  assert.equal(log.cell(2, 8), "greenhouse:acme:42");
  assert.equal(log.cell(2, 6), "Done");
  assert.equal(sent.emails.length, 1);
  assert.match(sent.emails[0].subject, /Tailored resume ready: Acme - Data Intern/);
  gas.tailorQueue();
  assert.equal(log.getLastRow(), 2, "limit reached for today");
});
