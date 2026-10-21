// What a posting is: an internship or not, which kind of role, which term,
// and what kind of company posted it. Done once in the scanner so each sheet
// only compares labels.

import { countriesIn } from "./places.js";

// Whole words only: "International" and "Internal" contain "intern".
const INTERN_RE = /\b(?:interns?|internships?|co-?ops?|summer analysts?|summer associates?)\b/i;

export const isInternship = (title) => INTERN_RE.test(title || "");

// New grad: only titles that say so, or a level-one title ("Software Engineer I",
// "Data Analyst 1"). "Engineer II" and senior titles don't count.
const NEW_GRAD_RE = new RegExp([
  String.raw`\b(?:new|university|recent|college)[- ]grad(?:uate)?s?\b`,
  String.raw`\b(?:early[- ]career|entry[- ]level|campus hire)\b`,
  String.raw`\bgraduate (?:program(?:me)?|scheme|engineer|developer|analyst|software engineer)\b`,
  String.raw`\b(?:engineer|developer|programmer|scientist|analyst)\s*(?:,\s*)?(?:I|1)\b(?![-/]?\s*(?:I|1|2|3))`
].join("|"), "i");
const SENIOR_RE = /\b(?:senior|sr\.?|staff|principal|lead|director|head of|vp|ii|iii|iv|2|3)\b/i;

export const isNewGrad = (title) => {
  const t = title || "";
  return !isInternship(t) && NEW_GRAD_RE.test(t) && !SENIOR_RE.test(t.replace(/\b20\d{2}\b/g, ""));
};

/** "Internship", "New Grad", or null for a posting we don't keep. */
export const levelOf = (title) => (isInternship(title) ? "Internship" : isNewGrad(title) ? "New Grad" : null);

// Role types a sheet can pick. A title can have several, or none ("Engineering
// Intern"); sheets keep untyped titles rather than guess.
export const ROLE_TYPES = [
  ["Quant", /\b(?:quant\w*|trad(?:er|ing)|market making)\b/i],
  ["Data/AI", /\b(?:data|machine learning|ml|ai|artificial intelligence|analytics|(?:data|research|applied|computer) scien\w*|deep learning|computer vision|nlp|llm|genai)\b/i],
  ["Software", /\b(?:software|swe|developer|backend|back-end|frontend|front-end|full[- ]?stack|mobile|ios|android|web|platform|infrastructure|cloud|security|devops|sre|site reliability|systems? programm\w*|programmer|coding)\b/i],
  ["Hardware", /\b(?:hardware|electrical|mechanical|firmware|embedded|asic|fpga|rf|silicon|chip|circuit|semiconductor|manufactur\w*|aerospace|avionics|robotics|mechatronics|controls?|optic\w*|physical design|verification|validation|power)\b/i],
  ["Product", /\b(?:product manag\w*|product management|apm|program manag\w*|technical program)\b/i],
  ["Design", /\b(?:designer|product design|ux|ui|user experience|user research|graphic design)\b/i],
  ["Business", /\b(?:business|finance|financial|account\w*|marketing|sales|operations|strategy|consult\w*|investment|banking|analyst|supply chain|hr|people|legal|communications)\b/i]
];

export function roleTypes(title) {
  const t = title || "";
  return ROLE_TYPES.filter(([, re]) => re.test(t)).map(([name]) => name);
}

const SEASONS = { winter: "Winter", spring: "Spring", summer: "Summer", fall: "Fall", autumn: "Fall" };

/** The terms a title names: "SWE Intern (Summer 2027)" -> ["Summer 2027"]; a season or year alone is kept as-is. */
export function termsIn(title) {
  const t = (title || "").toLowerCase();
  const seasons = [...new Set((t.match(/\b(?:winter|spring|summer|fall|autumn)\b/g) || []).map((s) => SEASONS[s]))];
  const years = [...new Set(t.match(/\b20\d{2}\b/g) || [])];
  if (seasons.length && years.length) return seasons.flatMap((s) => years.map((y) => `${s} ${y}`));
  return [...seasons, ...years];
}

/** Lowercase, no punctuation or company suffixes: "Jane Street Capital, LLC" -> "jane street capital". */
export function companyKey(name) {
  return String(name || "").toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|plc|gmbh|lp|llp)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Curated, so they're names people would agree on. Edit freely.
export const BIG_TECH = [
  "Google", "Alphabet", "Meta", "Apple", "Amazon", "Amazon Web Services", "AWS", "Microsoft", "NVIDIA", "Netflix",
  "Tesla", "Salesforce", "Adobe", "Oracle", "IBM", "Intel", "AMD", "Qualcomm", "Cisco", "Uber", "Airbnb",
  "LinkedIn", "Snap", "Spotify", "ByteDance", "TikTok", "Stripe", "Databricks", "OpenAI", "Anthropic",
  "Waymo", "DoorDash", "Pinterest", "Reddit", "Roblox", "Coinbase", "Palantir", "Block", "Shopify",
  "Workday", "ServiceNow", "Snowflake", "Intuit", "PayPal", "eBay", "Dropbox", "Atlassian", "Samsung"
];

export const QUANT = [
  "Jane Street", "Citadel", "Citadel Securities", "Two Sigma", "Hudson River Trading", "HRT", "IMC", "IMC Trading",
  "Optiver", "Susquehanna", "SIG", "Susquehanna International Group", "DRW", "Jump Trading", "Five Rings",
  "Akuna Capital", "Virtu Financial", "Tower Research Capital", "D. E. Shaw", "DE Shaw", "The D. E. Shaw Group",
  "Point72", "Millennium", "Jump", "Old Mission", "Belvedere Trading", "Chicago Trading Company", "Peak6",
  "Wolverine Trading", "Flow Traders", "XTX Markets", "Squarepoint Capital", "Bridgewater Associates",
  "Renaissance Technologies", "AQR", "Radix Trading", "Headlands Technologies", "Vatic Labs", "Old Mission Capital"
];

const BIG_TECH_KEYS = new Set(BIG_TECH.map(companyKey));
const QUANT_KEYS = new Set(QUANT.map(companyKey));

/** Company-type labels a sheet can pick: "Big Tech", "YC Startup", "Quant". `yc` is a Set of companyKeys. */
export function companyTags(company, { yc = new Set() } = {}) {
  const k = companyKey(company);
  const tags = [];
  if (BIG_TECH_KEYS.has(k)) tags.push("Big Tech");
  if (yc.has(k)) tags.push("YC Startup");
  if (QUANT_KEYS.has(k)) tags.push("Quant");
  return tags;
}

/** The fields every sheet filters on, worked out once. */
export function describe(job) {
  return {
    ...job,
    level: job.level || levelOf(job.title),
    countries: [...countriesIn(job.location)],
    roleTypes: [...new Set([...(job.roleTypes || []), ...roleTypes(job.title)])],
    terms: job.terms?.length ? job.terms : termsIn(job.title)
  };
}
