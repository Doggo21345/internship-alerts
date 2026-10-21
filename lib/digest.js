// The daily roundup: internships and new grad jobs first seen in the last 24
// hours, written up once as a newsletter (HTML to paste into beehiiv) and once
// as a LinkedIn post (plain text, no links, under LinkedIn's 3,000 characters).
// Pure, so tests can check the wording.

const HOUR = 36e5;
export const DIGEST_HOURS = 24;
// Newsletter rows per section; the rest are counted, not listed.
const NEWSLETTER_ROWS = { "Internship": 100, "New Grad": 60 };
// LinkedIn lines per section, before the "+N more" line.
const LINKEDIN_ROWS = { "Internship": 10, "New Grad": 6 };
export const LINKEDIN_MAX = 3000;

const RANK = ["Big Tech", "Quant", "YC Startup"];
const rank = (j) => {
  const i = RANK.findIndex((t) => (j.tags || []).includes(t));
  return i < 0 ? RANK.length : i;
};

/** Big Tech, then Quant, then YC, then everyone else; newest first within each. */
export const byInterest = (a, b) => rank(a) - rank(b) || b.firstSeen - a.firstSeen || a.company.localeCompare(b.company);

/** "Seattle, WA · Austin, TX · NYC · Remote" -> "Seattle, WA · Austin, TX +2". */
export function shortLocation(location, keep = 2) {
  const parts = String(location || "").split(/\s*[·;]\s*/).filter(Boolean);
  return parts.length <= keep ? parts.join(" · ") : `${parts.slice(0, keep).join(" · ")} +${parts.length - keep}`;
}

const html = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/**
 * jobs: the scan's feed (every level), each with firstSeen, level, tags.
 * -> {date, generatedAt, counts, internships, newGrad, subject, html, linkedin}
 */
export function buildDigest(jobs, { now, hours = DIGEST_HOURS, timeZone = "America/Chicago" } = {}) {
  const recent = jobs.filter((j) => j.firstSeen >= now - hours * HOUR);
  const internships = recent.filter((j) => j.level !== "New Grad").sort(byInterest);
  const newGrad = recent.filter((j) => j.level === "New Grad").sort(byInterest);
  const date = new Date(now).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
  const counts = { internships: internships.length, newGrad: newGrad.length };
  const subject = `${plural(counts.internships, "internship")} + ${plural(counts.newGrad, "new grad job")} opened in the last 24 hours (${date})`;
  return {
    date,
    generatedAt: now,
    counts,
    internships,
    newGrad,
    subject,
    html: newsletterHtml({ internships, newGrad, counts, date }),
    linkedin: linkedinPost({ internships, newGrad, counts })
  };
}

// Each level is split into these groups, in this order. Emoji and headings
// survive pasting into beehiiv's editor; most inline styles don't.
const GROUPS = [
  ["🏢 Big Tech", (j) => rank(j) === 0],
  ["📈 Quant", (j) => rank(j) === 1],
  ["🚀 YC startups", (j) => rank(j) === 2],
  ["🌱 Everyone else", (j) => rank(j) === RANK.length]
];
const LINK = "color:#2563eb;text-decoration:underline";
const MUTED = "color:#6b7280";

function jobItem(j) {
  const where = shortLocation(j.location);
  return `<li style="margin:0 0 8px"><b>${html(j.company)}</b>: <a href="${html(j.url)}" style="${LINK}">${html(j.title)}</a>` +
    (where ? ` <span style="${MUTED}">· ${html(where)}</span>` : "") + "</li>";
}

/** One level ("🎓 Internships"): a heading, then each non-empty group, capped at `cap` rows in all. */
function section(title, jobs, cap) {
  if (!jobs.length) return `<h2>${html(title)}</h2><p style="${MUTED}">Nothing new in the last 24 hours.</p>`;
  const out = [`<h2>${html(title)} (${jobs.length})</h2>`];
  let left = cap;
  for (const [name, inGroup] of GROUPS) {
    const group = jobs.filter(inGroup);
    if (!group.length) continue;
    if (left <= 0) { out.push(`<p style="${MUTED}"><i>${name}: ${group.length} more.</i></p>`); continue; }
    out.push(`<h3>${name} (${group.length})</h3>`, `<ul>${group.slice(0, left).map(jobItem).join("")}</ul>`);
    if (group.length > left) out.push(`<p style="${MUTED}"><i>…and ${group.length - left} more.</i></p>`);
    left -= group.length;
  }
  return out.join("\n");
}

function newsletterHtml({ internships, newGrad, counts, date }) {
  const big = [...new Set(internships.concat(newGrad).filter((j) => rank(j) === 0).map((j) => j.company))];
  return [
    `<p>Good morning! Here's everything that opened in the last 24 hours (${html(date)}).</p>`,
    `<blockquote><p>🎓 <b>${plural(counts.internships, "internship")}</b><br>` +
      `💼 <b>${plural(counts.newGrad, "new grad job")}</b>` +
      (big.length ? `<br>🏢 Hiring today: ${html(big.slice(0, 8).join(", "))}${big.length > 8 ? ` +${big.length - 8} more` : ""}` : "") +
      `</p></blockquote>`,
    `<p>Big Tech, quant firms and YC startups are listed first. Postings fill fast, so if one fits, apply today.</p>`,
    "<hr>",
    section("🎓 Internships", internships, NEWSLETTER_ROWS.Internship),
    "<hr>",
    section("💼 New grad", newGrad, NEWSLETTER_ROWS["New Grad"]),
    "<hr>",
    `<p>Know someone hunting? <b>Forward this to them.</b> See you tomorrow.</p>`
  ].join("\n");
}

/** One line per company, in the order its first role appears: "• Google: SWE Intern (+3 more)". */
function companyLines(jobs) {
  const groups = new Map();
  for (const j of jobs) {
    const g = groups.get(j.company) || { first: j, count: 0 };
    g.count++;
    groups.set(j.company, g);
  }
  return [...groups.values()].map(({ first, count }) => ({
    text: `• ${first.company}: ${first.title}${count > 1 ? ` (+${count - 1} more)` : ""}`,
    count
  }));
}

function linkedinPost({ internships, newGrad, counts }) {
  const build = (nI, nG) => {
    const out = [
      `${plural(counts.internships, "INTERNSHIP", "INTERNSHIPS")} and ${plural(counts.newGrad, "new grad job")} opened in the LAST 24 HOURS.`,
      "",
      "Here are the ones I'd apply to first 👇"
    ];
    const add = (title, jobs, n) => {
      if (!jobs.length) return;
      const shown = companyLines(jobs).slice(0, n);
      out.push("", title, ...shown.map((l) => l.text));
      const rest = jobs.length - shown.reduce((sum, l) => sum + l.count, 0);
      if (rest > 0) out.push(`+ ${rest} more`);
    };
    add("Internships", internships, nI);
    add("New grad", newGrad, nG);
    out.push(
      "",
      "Every posting, with apply links, is in today's newsletter. Link in the comments.",
      "",
      "Most of these close fast. Apply TODAY, not this weekend.",
      "",
      "♻️ Repost so someone in your network sees it."
    );
    return out.join("\n");
  };
  // Drop listed lines until it fits; the counts stay right either way.
  let nI = LINKEDIN_ROWS.Internship, nG = LINKEDIN_ROWS["New Grad"];
  let text = build(nI, nG);
  while (text.length > LINKEDIN_MAX && (nI > 0 || nG > 0)) {
    if (nI >= nG && nI > 0) nI--; else nG--;
    text = build(nI, nG);
  }
  return text;
}
