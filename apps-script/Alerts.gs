/**
 * Internship Alerts: a Google Sheet that emails you and pings your phone when
 * internships you care about are posted.
 *
 * The scanning happens elsewhere: a GitHub Action reads thousands of company job
 * boards every 20 minutes and publishes the new postings as one file. Every 15
 * minutes this script reads that file, keeps what matches the rows on your
 * Alerts tab, and notifies you. Companies the scanner doesn't cover yet are
 * looked up on Greenhouse, Lever and Ashby and checked from here.
 *
 * Everything is prefixed IA_/ia so this file can share a project with the job
 * tracker's Code.gs without names colliding. Setup: see README.md.
 */

const IA_DATA = 'https://raw.githubusercontent.com/Doggo21345/internship-alerts/data/';
const IA_FEED_URL = IA_DATA + 'new.json';
const IA_OPEN_URL = IA_DATA + 'open.json';
const IA_COMPANIES_URL = IA_DATA + 'companies.json';

const IA_TABS = { alerts: 'Alerts', matches: 'Matches', open: 'Open now', settings: 'Alert settings' };
const IA_ALERT_HEADERS = ['On', 'Alert name', 'Role keywords', 'Role types', 'Term', 'Country',
  'Cities / states', 'Company types', 'Companies', 'Exclude words', 'Email', 'Push'];
const IA_ALERT_NOTES = [
  'Untick to pause this alert.',
  'Any name. Shows in the notification so you know which alert fired.',
  'Comma-separated words, e.g. "software, backend, data". A role title needs at least one. Empty = any.',
  'Comma-separated, from: Software, Data/AI, Hardware, Quant, Product, Design, Business. ' +
    'Titles that fit none (like "Engineering Intern") are kept. With keywords too, a title needs either.',
  'e.g. "Summer 2027", or "Summer 2027, Fall 2026". Titles that name no term are kept.',
  'Country codes, e.g. "US" or "US, CA". Postings that don\'t say (like "Remote") are kept. Empty = anywhere.',
  'For local jobs: cities or states, e.g. "Austin, Dallas, TX, Remote". Empty = anywhere.',
  'Comma-separated, from: Big Tech, YC Startup, Quant. Empty with no Companies = every company.',
  'Companies you want, comma-separated, e.g. "Stripe, Jane Street, Ramp". Combined with Company types: ' +
    'a posting fits if it\'s from one of these OR of one of those types. You can also paste a Greenhouse, Lever or Ashby jobs link.',
  'Comma-separated words that rule a title out, e.g. "PhD, MBA, Sales".',
  'Email me matches for this alert.',
  'Push matches to my phone (see the Push topic on the Alert settings tab).'
];
const IA_MATCH_HEADERS = ['Found', 'Company', 'Role', 'Location', 'Posted', 'Link', 'Alert', 'Status'];
const IA_ROLE_TYPES = ['Software', 'Data/AI', 'Hardware', 'Quant', 'Product', 'Design', 'Business'];
const IA_COMPANY_TYPES = ['Big Tech', 'YC Startup', 'Quant'];

// The first check of a new alert looks back this far, so you see it working.
const IA_FIRST_LOOKBACK_MS = 24 * 3600 * 1000;
// More matches than this in one check become a single summary push.
const IA_MAX_PUSHES = 3;
const IA_EMAIL_ROWS = 50;
const IA_OPEN_ROWS = 1000;
// Companies we couldn't find a board for are retried after this long.
const IA_RETRY_UNFOUND_MS = 7 * 24 * 3600 * 1000;

// ---- Setup and menu --------------------------------------------------------------

/** Creates the tabs, installs the 15-minute check and the menu, then runs a first check. */
function setupAlerts() {
  const ss = SpreadsheetApp.getActive();
  iaAlertsSheet_(ss);
  iaMatchesSheet_(ss, IA_TABS.matches);
  const settings = iaSettingsSheet_(ss);
  if (!iaSetting_(settings, 'Email alerts to')) {
    iaSetSetting_(settings, 'Email alerts to', Session.getEffectiveUser().getEmail());
  }
  if (!iaSetting_(settings, 'Push topic')) {
    iaSetSetting_(settings, 'Push topic', 'intern-' + Utilities.getUuid().replace(/-/g, '').slice(0, 16));
  }
  for (const t of ScriptApp.getProjectTriggers()) {
    if (['checkAlerts', 'alertsMenu'].includes(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('checkAlerts').timeBased().everyMinutes(15).create();
  // An installable trigger rather than onOpen(), which the job tracker already uses.
  ScriptApp.newTrigger('alertsMenu').forSpreadsheet(ss).onOpen().create();
  alertsMenu();
  checkAlerts();
}

function alertsMenu() {
  SpreadsheetApp.getUi().createMenu('Internship Alerts')
    .addItem('Check now', 'checkAlerts')
    .addItem('Show what\'s open now', 'showOpenNow')
    .addItem('Send a test alert', 'sendTestAlert')
    .addSeparator()
    .addItem('Set up / repair', 'setupAlerts')
    .addToUi();
}

function iaAlertsSheet_(ss) {
  let sh = ss.getSheetByName(IA_TABS.alerts);
  if (sh) return sh;
  sh = ss.insertSheet(IA_TABS.alerts, 0);
  const n = IA_ALERT_HEADERS.length;
  sh.getRange(1, 1, 1, n).setValues([IA_ALERT_HEADERS]).setFontWeight('bold').setNotes([IA_ALERT_NOTES]);
  sh.getRange(2, 1, 2, n).setValues([
    [true, 'SWE Summer 2027', '', 'Software', 'Summer 2027', 'US', '', '', '', 'PhD, MBA', true, true],
    [false, 'Big Tech + startups in Austin', '', '', 'Summer 2027', 'US', 'Austin, TX, Remote', 'Big Tech, YC Startup', 'Jane Street', '', true, false]
  ]);
  const check = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  for (const col of [1, 11, 12]) sh.getRange(2, col, 200, 1).setDataValidation(check);
  sh.setFrozenRows(1);
  sh.setColumnWidths(2, n - 3, 170);
  sh.getRange(5, 2).setValue('Hover a header for what it does. Add a row per alert.').setFontColor('#888888');
  return sh;
}

function iaMatchesSheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, IA_MATCH_HEADERS.length).setValues([IA_MATCH_HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.setColumnWidth(3, 320);
  return sh;
}

function iaSettingsSheet_(ss) {
  let sh = ss.getSheetByName(IA_TABS.settings);
  if (sh) return sh;
  sh = ss.insertSheet(IA_TABS.settings);
  sh.getRange(1, 1, 7, 3).setValues([
    ['Setting', 'Value', 'Help'],
    ['Email alerts to', '', 'Where alert emails go. Comma-separate several addresses.'],
    ['Push topic', '', 'Phone alerts: install the free ntfy app (iPhone or Android), tap +, and subscribe to ' +
      'this exact topic. Anyone who knows the topic can read your alerts, so keep it random.'],
    ['Last check', '', ''],
    ['Last result', '', ''],
    ['Companies not found', '', 'Companies from your alerts with no board we could find. Paste their jobs ' +
      'link into Companies instead, or ask for them to be added to the scanner.'],
    ['Feed', IA_FEED_URL, 'Where new postings come from. Leave as is.']
  ]);
  sh.getRange(1, 1, 1, 3).setFontWeight('bold');
  sh.setColumnWidth(1, 160).setColumnWidth(2, 320).setColumnWidth(3, 520);
  return sh;
}

function iaSettingRow_(sh, label) {
  const labels = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues();
  const i = labels.findIndex((r) => r[0] === label);
  return i < 0 ? 0 : i + 1;
}
function iaSetting_(sh, label) {
  const row = iaSettingRow_(sh, label);
  return row ? String(sh.getRange(row, 2).getValue()).trim() : '';
}
function iaSetSetting_(sh, label, value) {
  let row = iaSettingRow_(sh, label);
  if (!row) { row = sh.getLastRow() + 1; sh.getRange(row, 1).setValue(label); }
  sh.getRange(row, 2).setValue(value);
}

// ---- Reading alerts ---------------------------------------------------------------

const iaList_ = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

/** Lowercase, no punctuation or company suffixes. Same as companyKey() in lib/classify.js. */
function iaCompanyKey(name) {
  return String(name || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|plc|gmbh|lp|llp)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const IA_COUNTRY_NAMES = {
  'united states': 'US', usa: 'US', america: 'US', canada: 'CA', 'united kingdom': 'GB', uk: 'GB',
  england: 'GB', ireland: 'IE', germany: 'DE', france: 'FR', netherlands: 'NL', switzerland: 'CH',
  india: 'IN', singapore: 'SG', japan: 'JP', australia: 'AU', 'hong kong': 'HK', mexico: 'MX',
  poland: 'PL', spain: 'ES'
};

/** One Alerts row -> an alert, or null for blank/paused rows. Unknown labels are reported in `problems`. */
function iaParseAlert(row, rowNumber) {
  const [on, name, keywords, roleTypes, term, country, cities, companyTypes, companies, exclude, email, push] = row;
  if (on !== true || !(name || keywords || roleTypes || companies || companyTypes)) return null;
  const problems = [];
  const pick = (values, allowed, what) => iaList_(values).map((v) => {
    const hit = allowed.find((a) => a.toLowerCase() === v.toLowerCase());
    if (!hit) problems.push(`unknown ${what} "${v}"`);
    return hit;
  }).filter(Boolean);
  const companyItems = iaList_(companies);
  const isLink = (c) => /^https?:|\.(io|co|com)\//i.test(c);
  const names = {};
  for (const c of companyItems) if (!isLink(c) && iaCompanyKey(c)) names[iaCompanyKey(c)] = c;
  return {
    row: rowNumber,
    name: String(name || `Row ${rowNumber}`).trim(),
    keywords: iaList_(keywords).map((k) => k.toLowerCase()),
    roleTypes: pick(roleTypes, IA_ROLE_TYPES, 'role type'),
    terms: iaList_(term),
    countries: iaList_(country).map((c) => IA_COUNTRY_NAMES[c.toLowerCase()] || c.toUpperCase()),
    cities: iaList_(cities),
    companyTypes: pick(companyTypes, IA_COMPANY_TYPES, 'company type'),
    companies: Object.keys(names),
    companyNames: names, // as typed, for messages
    companyLinks: companyItems.filter(isLink),
    exclude: iaList_(exclude).map((k) => k.toLowerCase()),
    email: email === true,
    push: push === true,
    problems
  };
}

function iaReadAlerts_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, IA_ALERT_HEADERS.length).getValues()
    .map((r, i) => iaParseAlert(r, i + 2)).filter(Boolean);
}

// ---- Matching ---------------------------------------------------------------------

const iaEscape_ = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A word or phrase as a whole word: "ai" doesn't match "maintenance", "ml" doesn't match "html". */
function iaHasWord_(text, word) {
  return new RegExp('(^|[^a-z0-9])' + iaEscape_(word.toLowerCase()) + '($|[^a-z0-9])').test(String(text || '').toLowerCase());
}

/**
 * Does a term the posting names fit one the alert wants? "Summer 2027" fits
 * "Summer 2027", "Summer" and "2027"; it doesn't fit "Fall 2027" or "Summer 2026".
 */
function iaTermFits_(jobTerm, wanted) {
  const parse = (t) => ({
    season: (String(t).match(/winter|spring|summer|fall|autumn/i) || [''])[0].toLowerCase().replace('autumn', 'fall'),
    year: (String(t).match(/20\d{2}/) || [''])[0]
  });
  const a = parse(jobTerm), b = parse(wanted);
  return (!a.season || !b.season || a.season === b.season) && (!a.year || !b.year || a.year === b.year);
}

/** Do a city or state the alert names appear in the location? "TX" is matched as a code, "Austin" as a word. */
function iaPlaceFits_(location, place) {
  if (/^remote$/i.test(place)) return /\bremote\b/i.test(location);
  if (/^[A-Z]{2}$/.test(place)) return new RegExp('(^|[^A-Za-z])' + place + '($|[^A-Za-z])').test(location);
  return iaHasWord_(location, place);
}

/** Does this posting fit this alert? Fields the posting doesn't state are given the benefit of the doubt. */
function iaMatches(job, a) {
  const title = job.title || '';
  if (a.exclude.some((w) => iaHasWord_(title, w))) return false;

  if (a.companies.length || a.companyTypes.length || a.companyLinks.length) {
    const key = iaCompanyKey(job.company);
    const byName = a.companies.some((c) => key === c || key.startsWith(c + ' '));
    const byType = (job.tags || []).some((t) => a.companyTypes.includes(t));
    const byLink = Boolean(job.customFor) && job.customFor.includes(a.row);
    if (!byName && !byType && !byLink) return false;
  }

  const kw = a.keywords.some((w) => iaHasWord_(title, w));
  const types = job.roleTypes || [];
  const typed = types.some((t) => a.roleTypes.includes(t));
  if (a.keywords.length && a.roleTypes.length) { if (!kw && !typed) return false; }
  else if (a.keywords.length) { if (!kw) return false; }
  else if (a.roleTypes.length && types.length && !typed) return false;

  const jobTerms = job.terms || [];
  if (a.terms.length && jobTerms.length && !jobTerms.some((t) => a.terms.some((w) => iaTermFits_(t, w)))) return false;

  const countries = job.countries || [];
  if (a.countries.length && countries.length && !countries.some((c) => a.countries.includes(c))) return false;

  if (a.cities.length && job.location && !a.cities.some((p) => iaPlaceFits_(job.location, p))) return false;
  return true;
}

/** [{job, alerts: [alert, ...]}] for postings matching at least one alert, newest first. */
function iaGroupMatches(jobs, alerts) {
  const out = [];
  for (const job of jobs) {
    const hit = alerts.filter((a) => iaMatches(job, a));
    if (hit.length) out.push({ job, alerts: hit });
  }
  return out.sort((x, y) => (y.job.firstSeen || 0) - (x.job.firstSeen || 0));
}

// ---- Companies the scanner doesn't cover -----------------------------------------

// Whole words only: "International" and "Internal" contain "intern".
const IA_INTERN_RE = /\b(?:interns?|internships?|co-?ops?|summer analysts?|summer associates?)\b/i;

const IA_BOARD_API = {
  greenhouse: (slug) => 'https://boards-api.greenhouse.io/v1/boards/' + slug + '/jobs',
  lever: (slug) => 'https://api.lever.co/v0/postings/' + slug + '?mode=json',
  ashby: (slug) => 'https://api.ashbyhq.com/posting-api/job-board/' + encodeURIComponent(slug)
};

function iaBoardFromLink(link) {
  const s = String(link || '');
  let m;
  if ((m = s.match(/(?:boards|job-boards)\.greenhouse\.io\/([\w-]+)/i))) return 'greenhouse:' + m[1].toLowerCase();
  if ((m = s.match(/jobs\.lever\.co\/([\w.-]+)/i))) return 'lever:' + m[1].toLowerCase();
  if ((m = s.match(/jobs\.ashbyhq\.com\/([^/?#]+)/i))) return 'ashby:' + decodeURIComponent(m[1]).toLowerCase();
  return '';
}

function iaSlugsFor_(name) {
  const words = String(name).toLowerCase().match(/[a-z0-9]+/g) || [];
  return words.length ? [...new Set([words.join(''), words.join('-')])] : [];
}

/** A board API response -> jobs, or null if it isn't one. */
function iaNormalize(board, data, company) {
  const [ats] = board.split(':');
  const ms = (v) => { const n = typeof v === 'number' ? v : Date.parse(v || ''); return isFinite(n) ? n : 0; };
  let jobs = null;
  if (ats === 'greenhouse' && data && Array.isArray(data.jobs)) {
    jobs = data.jobs.map((j) => ({ jobId: j.id, title: j.title, company: company || j.company_name,
      location: (j.location && j.location.name) || '', url: j.absolute_url, postedAt: ms(j.first_published || j.updated_at) }));
  } else if (ats === 'lever' && Array.isArray(data)) {
    jobs = data.map((j) => ({ jobId: j.id, title: j.text, company, location: (j.categories && j.categories.location) || '',
      url: j.hostedUrl, postedAt: ms(j.createdAt) }));
  } else if (ats === 'ashby' && data && Array.isArray(data.jobs)) {
    jobs = data.jobs.filter((j) => j.isListed !== false).map((j) => ({ jobId: j.id, title: j.title, company,
      location: j.location || '', url: j.jobUrl, postedAt: ms(j.publishedAt) }));
  }
  return jobs && jobs.map((j) => ({ ...j, id: board + ':' + j.jobId, title: j.title || '' }));
}

const iaFetchAll_ = (urls) => UrlFetchApp.fetchAll(urls.map((url) => ({ url, muteHttpExceptions: true })))
  .map((r) => { try { return r.getResponseCode() === 200 ? JSON.parse(r.getContentText()) : null; } catch (e) { return null; } });

/**
 * Finds boards for the alerts' companies the scanner doesn't cover, and returns
 * their postings first seen in this check. The first read of a board only
 * remembers what's there; after that, anything new counts.
 */
function iaCustomJobs_(alerts, settings, now) {
  const props = PropertiesService.getScriptProperties();
  const resolved = JSON.parse(props.getProperty('IA_RESOLVED') || '{}');
  let covered = null;
  const wanted = new Map(); // board or company key -> {company, rows}
  for (const a of alerts) {
    for (const link of a.companyLinks) {
      const board = iaBoardFromLink(link);
      if (board) wanted.set(board, { company: '', rows: [...((wanted.get(board) || {}).rows || []), a.row], board });
    }
    for (const c of a.companies) {
      wanted.set('name:' + c, { company: a.companyNames[c], rows: [...((wanted.get('name:' + c) || {}).rows || []), a.row] });
    }
  }
  const names = [...wanted.keys()].filter((k) => k.startsWith('name:'));
  if (names.length) {
    try {
      covered = new Set(JSON.parse(UrlFetchApp.fetch(IA_COMPANIES_URL).getContentText()).companies);
    } catch (e) {
      covered = null; // can't tell what's covered; skip lookups this time
    }
  }
  const notFound = [];
  if (covered) {
    for (const k of names) {
      const c = k.slice(5);
      if ([...covered].some((x) => x === c || x.startsWith(c + ' '))) { wanted.delete(k); continue; }
      const r = resolved[c];
      if (r && r.board) { wanted.get(k).board = r.board; continue; }
      if (r && now - r.checked < IA_RETRY_UNFOUND_MS) { notFound.push(wanted.get(k).company); wanted.delete(k); continue; }
      const tries = [];
      for (const ats of ['greenhouse', 'ashby', 'lever']) for (const s of iaSlugsFor_(c)) tries.push(ats + ':' + s);
      const got = iaFetchAll_(tries.map((b) => IA_BOARD_API[b.split(':')[0]](b.slice(b.indexOf(':') + 1))));
      const hit = tries.find((b, i) => got[i] && iaNormalize(b, got[i], c));
      resolved[c] = hit ? { board: hit, checked: now } : { checked: now };
      if (hit) wanted.get(k).board = hit; else { notFound.push(wanted.get(k).company); wanted.delete(k); }
    }
  } else {
    for (const k of names) wanted.delete(k);
  }
  props.setProperty('IA_RESOLVED', JSON.stringify(resolved));
  iaSetSetting_(settings, 'Companies not found', notFound.join(', '));

  const boards = [...wanted.values()].filter((w) => w.board);
  if (!boards.length) return [];
  const data = iaFetchAll_(boards.map((w) => IA_BOARD_API[w.board.split(':')[0]](w.board.slice(w.board.indexOf(':') + 1))));
  const out = [];
  boards.forEach((w, i) => {
    const jobs = data[i] && iaNormalize(w.board, data[i], w.company);
    if (!jobs) return;
    const key = 'IA_SEEN:' + w.board;
    const before = props.getProperty(key);
    const seen = new Set(JSON.parse(before || '[]'));
    const interns = jobs.filter((j) => IA_INTERN_RE.test(j.title));
    if (before) {
      for (const j of interns) {
        if (!seen.has(String(j.jobId))) {
          out.push({ ...j, company: j.company || iaTitle_(w.board.split(':')[1]), firstSeen: now, customFor: w.rows });
        }
      }
    }
    // Only open postings are kept, which stays well under the 9 KB a property can hold.
    props.setProperty(key, JSON.stringify(interns.map((j) => String(j.jobId)).slice(0, 600)));
  });
  return out;
}

const iaTitle_ = (s) => String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ---- The check --------------------------------------------------------------------

/** Every 15 minutes: new postings since the last check that fit an alert get sent and logged. */
function checkAlerts() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    const ss = SpreadsheetApp.getActive();
    const settings = iaSettingsSheet_(ss);
    const now = Date.now();
    iaSetSetting_(settings, 'Last check', new Date(now));
    const alerts = iaReadAlerts_(iaAlertsSheet_(ss));
    const problems = alerts.flatMap((a) => a.problems.map((p) => `${a.name}: ${p}`));

    const res = UrlFetchApp.fetch(iaSetting_(settings, 'Feed') || IA_FEED_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      iaSetSetting_(settings, 'Last result', `Couldn't read the feed (HTTP ${res.getResponseCode()}). Will retry.`);
      return;
    }
    const feed = JSON.parse(res.getContentText());

    // Each alert remembers how far through the feed it's read. The feed's own
    // timestamp, not the clock, so a feed that's a few minutes stale loses nothing.
    const props = PropertiesService.getScriptProperties();
    const cursors = JSON.parse(props.getProperty('IA_CURSORS') || '{}');
    const fresh = [];
    for (const a of alerts) {
      const since = cursors[a.name] || feed.generatedAt - IA_FIRST_LOOKBACK_MS;
      fresh.push({ alert: a, jobs: feed.jobs.filter((j) => j.firstSeen > since) });
      cursors[a.name] = Math.max(since, feed.generatedAt);
    }
    const custom = iaCustomJobs_(alerts, settings, now);

    const byId = new Map();
    for (const { alert, jobs } of fresh) {
      for (const j of jobs.concat(custom)) {
        if (!iaMatches(j, alert)) continue;
        const m = byId.get(j.id) || { job: j, alerts: [] };
        if (!m.alerts.includes(alert)) m.alerts.push(alert);
        byId.set(j.id, m);
      }
    }
    // Already logged (e.g. a renamed alert re-reading the feed) isn't news.
    const logged = iaLoggedLinks_(ss);
    const matches = [...byId.values()].filter((m) => !logged.has(m.job.url))
      .sort((x, y) => (y.job.firstSeen || 0) - (x.job.firstSeen || 0));

    const sent = iaNotify_(matches, settings);
    iaLog_(iaMatchesSheet_(ss, IA_TABS.matches), matches, now);
    props.setProperty('IA_CURSORS', JSON.stringify(cursors));
    iaSetSetting_(settings, 'Last result',
      `${alerts.length} alert(s) on; ${matches.length} new match(es)${sent ? '; ' + sent : ''}` +
      (problems.length ? '. Check: ' + problems.join('; ') : ''));
  } finally {
    lock.releaseLock();
  }
}

function iaLoggedLinks_(ss) {
  const sh = iaMatchesSheet_(ss, IA_TABS.matches);
  const last = sh.getLastRow();
  if (last < 2) return new Set();
  const links = sh.getRange(2, 6, Math.min(last - 1, 3000), 1).getValues();
  return new Set(links.map((r) => String(r[0])));
}

/** Newest at the top. */
function iaLog_(sh, matches, now) {
  if (!matches.length) return;
  const rows = matches.map(({ job, alerts }) => [new Date(job.firstSeen || now), job.company, job.title, job.location,
    job.postedAt ? new Date(job.postedAt) : '', job.url, alerts.map((a) => a.name).join(', '), '']);
  sh.insertRowsBefore(2, rows.length);
  sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  sh.getRange(2, 1, rows.length, 1).setNumberFormat('MMM d, h:mm am/pm');
  sh.getRange(2, 5, rows.length, 1).setNumberFormat('MMM d');
}

// ---- Notifications ---------------------------------------------------------------

function iaAgo_(ms, now) {
  if (!ms) return '';
  const h = Math.max(0, Math.round((now - ms) / 36e5));
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  return d < 14 ? d + 'd ago' : Math.round(d / 7) + 'w ago';
}

const iaHtml_ = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The email for a check: {subject, htmlBody}. */
function iaEmail(matches, now, sheetUrl) {
  const names = [...new Set(matches.map((m) => m.job.company))];
  const subject = `${matches.length} new internship${matches.length === 1 ? '' : 's'}: ` +
    names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3} more` : '');
  const rows = matches.slice(0, IA_EMAIL_ROWS).map(({ job, alerts }) =>
    `<tr><td style="padding:6px 10px 6px 0"><b>${iaHtml_(job.company)}</b><br>` +
    `<a href="${iaHtml_(job.url)}">${iaHtml_(job.title)}</a></td>` +
    `<td style="padding:6px 10px;color:#555">${iaHtml_(job.location)}</td>` +
    `<td style="padding:6px 10px;color:#555;white-space:nowrap">${iaHtml_(iaAgo_(job.postedAt, now))}</td>` +
    `<td style="padding:6px 0;color:#888">${iaHtml_(alerts.map((a) => a.name).join(', '))}</td></tr>`).join('');
  const more = matches.length > IA_EMAIL_ROWS ? `<p>…and ${matches.length - IA_EMAIL_ROWS} more on the Matches tab.</p>` : '';
  const htmlBody = `<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">${rows}</table>${more}` +
    `<p style="color:#888;font-size:12px">From your <a href="${iaHtml_(sheetUrl)}">Internship Alerts sheet</a>. ` +
    `Change or pause alerts on its Alerts tab.</p>`;
  return { subject, htmlBody };
}

/** ntfy messages for a check: one per posting, or one summary when there are many. */
function iaPushes(matches, topic, sheetUrl) {
  if (matches.length <= IA_MAX_PUSHES) {
    return matches.map(({ job, alerts }) => ({
      topic, title: `${job.company}: ${job.title}`.slice(0, 200),
      message: [job.location, 'Alert: ' + alerts.map((a) => a.name).join(', ')].filter(Boolean).join('\n'),
      click: job.url, tags: ['briefcase']
    }));
  }
  const lines = matches.slice(0, 8).map(({ job }) => `${job.company}: ${job.title}`);
  if (matches.length > 8) lines.push(`+${matches.length - 8} more`);
  return [{ topic, title: `${matches.length} new internships`, message: lines.join('\n'), click: sheetUrl, tags: ['briefcase'] }];
}

/** Sends email and push for the matches; returns what was sent, for Last result. */
function iaNotify_(matches, settings) {
  const now = Date.now();
  const sheetUrl = SpreadsheetApp.getActive().getUrl();
  const emailed = matches.filter((m) => m.alerts.some((a) => a.email));
  const pushed = matches.filter((m) => m.alerts.some((a) => a.push));
  const done = [];
  const to = iaSetting_(settings, 'Email alerts to');
  if (emailed.length && to) {
    if (MailApp.getRemainingDailyQuota() > 0) {
      const { subject, htmlBody } = iaEmail(emailed, now, sheetUrl);
      MailApp.sendEmail({ to, subject, htmlBody, name: 'Internship Alerts' });
      done.push('emailed');
    } else {
      done.push('email skipped: Google\'s daily email limit is used up');
    }
  }
  const topic = iaSetting_(settings, 'Push topic');
  if (pushed.length && topic) {
    for (const p of iaPushes(pushed, topic, sheetUrl)) {
      UrlFetchApp.fetch('https://ntfy.sh/', { method: 'post', contentType: 'application/json',
        payload: JSON.stringify(p), muteHttpExceptions: true });
    }
    done.push('pushed');
  }
  return done.join(', ');
}

function sendTestAlert() {
  const settings = iaSettingsSheet_(SpreadsheetApp.getActive());
  const job = { id: 'test', company: 'Example Co', title: 'Software Engineer Intern (Summer 2027)', location: 'Austin, TX',
    url: 'https://example.com', postedAt: Date.now(), firstSeen: Date.now() };
  const sent = iaNotify_([{ job, alerts: [{ name: 'Test alert', email: true, push: true }] }], settings);
  SpreadsheetApp.getUi().alert(sent ? `Sent (${sent}). If your phone didn't buzz, check the topic in the ntfy app ` +
    `matches the Push topic on the Alert settings tab exactly.` : 'Nothing sent: fill in Email alerts to and Push topic first.');
}

/** Fills the "Open now" tab with every open posting that fits an alert. Nothing is sent. */
function showOpenNow() {
  const ss = SpreadsheetApp.getActive();
  const alerts = iaReadAlerts_(iaAlertsSheet_(ss));
  const open = JSON.parse(UrlFetchApp.fetch(IA_OPEN_URL).getContentText());
  const matches = iaGroupMatches(open.jobs, alerts)
    .sort((x, y) => (y.job.postedAt || 0) - (x.job.postedAt || 0)).slice(0, IA_OPEN_ROWS);
  const sh = iaMatchesSheet_(ss, IA_TABS.open);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, IA_MATCH_HEADERS.length).clearContent();
  iaLog_(sh, matches, Date.now());
  ss.setActiveSheet(sh);
  SpreadsheetApp.getUi().alert(`${matches.length} open posting(s) fit your alerts` +
    (matches.length === IA_OPEN_ROWS ? ` (showing the newest ${IA_OPEN_ROWS})` : '') + '.');
}
