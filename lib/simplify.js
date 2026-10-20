// Simplify's community internship list (github.com/SimplifyJobs), read from the
// JSON its README is generated from. Two uses: its posting links are how we
// find which companies' boards to scan, and its listings on companies' own
// career sites (Google, Meta, Apple, TikTok...) are postings we can't scan.

import { parseBoardUrl } from "./ats.js";

export const SIMPLIFY_URL =
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json";

const CATEGORY = {
  "AI/ML/Data": "Data/AI", "Data Science, AI & Machine Learning": "Data/AI",
  Software: "Software", "Software Engineering": "Software",
  Hardware: "Hardware", "Hardware Engineering": "Hardware",
  Product: "Product", "Product Management": "Product",
  Quant: "Quant", "Quantitative Finance": "Quant"
};

/**
 * Open listings as jobs, minus those on a board we already scan (`scanned`
 * is a Set of board keys), which would only duplicate the board's copy.
 */
export function simplifyJobs(listings, scanned = new Set()) {
  return listings
    .filter((l) => l.active && l.is_visible !== false && l.url)
    .filter((l) => {
      const b = parseBoardUrl(l.url);
      return !b || !scanned.has(b.key);
    })
    .map((l) => ({
      id: `simplify:${l.id}`,
      title: l.title || "",
      company: l.company_name || "",
      location: (l.locations || []).join("; "),
      url: l.url,
      postedAt: (l.date_posted || 0) * 1000,
      terms: l.terms || [],
      roleTypes: CATEGORY[l.category] ? [CATEGORY[l.category]] : []
    }));
}

/** Every board Simplify's links point to: [{...board, company, listings, lastPosted}], most listings first. */
export function boardsFromListings(listings) {
  const found = new Map();
  for (const l of listings) {
    const b = parseBoardUrl(l.url);
    if (!b) continue;
    const f = found.get(b.key) || { ...b, companies: new Map(), listings: 0, lastPosted: 0 };
    f.listings++;
    f.lastPosted = Math.max(f.lastPosted, (l.date_posted || 0) * 1000);
    if (l.company_name) f.companies.set(l.company_name, (f.companies.get(l.company_name) || 0) + 1);
    found.set(b.key, f);
  }
  return [...found.values()].map(({ companies, ...b }) => ({
    ...b,
    // The name most of its listings use (a board's listings can say "Meta" and "Meta Platforms").
    company: [...companies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ""
  })).sort((a, b) => b.listings - a.listings);
}
