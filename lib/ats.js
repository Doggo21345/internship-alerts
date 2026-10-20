// The job boards (ATSs) companies post on: recognizing a board from a posting
// link, the public endpoint that lists its jobs, and turning each response into
// one job shape: {jobId, title, company, location, url, postedAt}.
//
// Greenhouse, Lever, Ashby and SmartRecruiters publish documented public APIs.
// Workday doesn't: its career pages load jobs from an unauthenticated JSON
// endpoint (/wday/cxs/...), which is what we call. It can change without notice.

/**
 * A posting or board link -> {ats, slug, key} (plus host/site for Workday),
 * or null when it isn't a board we can read.
 */
export function parseBoardUrl(url) {
  const u = String(url || "");
  let m;
  if ((m = u.match(/greenhouse\.io\/embed\/job_app\?(?:[^#]*&)?for=([\w-]+)/i)) ||
      (m = u.match(/(?:boards|job-boards)\.greenhouse\.io\/(?!embed\b)([\w-]+)/i))) {
    return board("greenhouse", m[1].toLowerCase());
  }
  if ((m = u.match(/\/\/jobs\.lever\.co\/([\w.-]+)/i))) return board("lever", m[1].toLowerCase());
  if ((m = u.match(/\/\/jobs\.ashbyhq\.com\/([^/?#]+)/i))) {
    return board("ashby", decodeURIComponent(m[1]).toLowerCase());
  }
  if ((m = u.match(/\/\/(?:jobs|careers)\.smartrecruiters\.com\/([\w-]+)/i))) {
    return board("smartrecruiters", m[1]);
  }
  // https://{tenant}.wd5.myworkdayjobs.com/[en-US/]{site}/job/...
  if ((m = u.match(/\/\/([\w-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?([\w-]+)/i))) {
    const [, tenant, wd, site] = m;
    if (/^(job|wday|details)$/i.test(site)) return null;
    const host = `${tenant.toLowerCase()}.${wd.toLowerCase()}.myworkdayjobs.com`;
    return { ats: "workday", slug: `${tenant.toLowerCase()}/${site}`, host, site, key: `workday:${host}/${site}` };
  }
  return null;
}

const board = (ats, slug) => ({ ats, slug, key: `${ats}:${slug}` });

/** "greenhouse:stripe" or "workday:rtx.wd5.myworkdayjobs.com/Site" -> board, or null. */
export function parseBoardKey(key) {
  const m = String(key || "").match(/^(\w+):(.+)$/);
  if (!m) return null;
  const [, ats, rest] = m;
  if (ats === "workday") {
    const w = rest.match(/^([\w-]+\.wd\d+\.myworkdayjobs\.com)\/([\w-]+)$/);
    return w ? parseBoardUrl(`https://${w[1]}/${w[2]}`) : null;
  }
  return ["greenhouse", "lever", "ashby", "smartrecruiters"].includes(ats) ? board(ats, rest) : null;
}

const toMs = (v) => {
  const n = typeof v === "number" ? v : Date.parse(v || "");
  return Number.isFinite(n) ? n : 0;
};

/**
 * The requests that list a board's jobs: [{url, method?, body?}]. Workday is
 * newest first, so its first page is enough for anything posted since the last
 * scan; `page` asks for the next one.
 */
export function boardRequest(b, page = 0) {
  switch (b.ats) {
    case "greenhouse": return { url: `https://boards-api.greenhouse.io/v1/boards/${b.slug}/jobs` };
    case "lever": return { url: `https://api.lever.co/v0/postings/${b.slug}?mode=json` };
    case "ashby": return { url: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(b.slug)}` };
    case "smartrecruiters":
      return { url: `https://api.smartrecruiters.com/v1/companies/${b.slug}/postings?q=intern&limit=100` };
    case "workday": {
      const tenant = b.host.split(".")[0];
      return {
        url: `https://${b.host}/wday/cxs/${tenant}/${b.site}/jobs`,
        method: "POST",
        body: JSON.stringify({ appliedFacets: {}, limit: WORKDAY_PAGE, offset: page * WORKDAY_PAGE, searchText: "internship" })
      };
    }
    default: return null;
  }
}

export const WORKDAY_PAGE = 20;

/** Workday only says "Posted Today", "Posted 3 Days Ago", "Posted 30+ Days Ago". */
export function workdayPostedAt(text, now) {
  const t = String(text || "").toLowerCase();
  if (/today/.test(t)) return now;
  if (/yesterday/.test(t)) return now - 864e5;
  const m = t.match(/(\d+)\+?\s*days?/);
  return m ? now - Number(m[1]) * 864e5 : 0;
}

/** A board's response -> [{jobId, title, company, location, url, postedAt}], or null if it isn't one. */
export function normalizeJobs(b, data, { company = "", now = Date.now() } = {}) {
  if (b.ats === "greenhouse" && Array.isArray(data?.jobs)) {
    return data.jobs.map((j) => ({
      jobId: String(j.id || ""),
      title: j.title || "",
      company: company || j.company_name || "",
      location: j.location?.name || "",
      url: j.absolute_url || "",
      postedAt: toMs(j.first_published || j.updated_at)
    }));
  }
  if (b.ats === "lever" && Array.isArray(data)) {
    return data.map((j) => ({
      jobId: String(j.id || ""),
      title: j.text || "",
      company,
      location: j.categories?.location || (j.categories?.allLocations || []).join("; "),
      url: j.hostedUrl || "",
      postedAt: toMs(j.createdAt)
    }));
  }
  if (b.ats === "ashby" && Array.isArray(data?.jobs)) {
    return data.jobs.filter((j) => j.isListed !== false).map((j) => ({
      jobId: String(j.id || ""),
      title: j.title || "",
      company,
      location: [j.location, ...(j.secondaryLocations || []).map((s) => s.location)].filter(Boolean).join("; "),
      url: j.jobUrl || "",
      postedAt: toMs(j.publishedAt)
    }));
  }
  if (b.ats === "smartrecruiters" && Array.isArray(data?.content)) {
    return data.content.map((j) => ({
      jobId: String(j.id || ""),
      title: j.name || "",
      company: company || j.company?.name || "",
      location: j.location?.fullLocation || [j.location?.city, j.location?.region, j.location?.country].filter(Boolean).join(", "),
      url: `https://jobs.smartrecruiters.com/${b.slug}/${j.id}`,
      postedAt: toMs(j.releasedDate)
    }));
  }
  if (b.ats === "workday" && Array.isArray(data?.jobPostings)) {
    return data.jobPostings.filter((j) => j.externalPath).map((j) => ({
      jobId: String(j.bulletFields?.[0] || j.externalPath),
      title: j.title || "",
      company,
      location: j.locationsText || "",
      url: `https://${b.host}/${b.site}${j.externalPath}`,
      postedAt: workdayPostedAt(j.postedOn, now)
    }));
  }
  return null;
}

/** Board names to try for a company: "Jane Street" -> ["janestreet", "jane-street"]. */
export function slugsFor(name) {
  const words = String(name || "").toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company)\b\.?/g, "")
    .match(/[a-z0-9]+/g) || [];
  return words.length ? [...new Set([words.join(""), words.join("-")])] : [];
}
