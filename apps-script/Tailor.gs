/**
 * Resume Tailor: makes a copy of your resume (a Google Doc) tailored to one
 * job, without touching its formatting.
 *
 * For each experience or project on the resume, Claude keeps each bullet,
 * swaps it for one from your Bullet bank for that same role, or rewords it
 * toward the job description. Skills lines (Languages, Tools,
 * Methodologies...) are reordered and filled from your Skills bank. Then:
 *   1. code checks every edit: same numbers as its source, about the same
 *      length, no skill you didn't list, no duplicates;
 *   2. a second Claude call reviews every edit against its source and rejects
 *      anything the source doesn't support;
 *   3. the copy is exported to PDF; if it runs onto more pages than your
 *      resume, the edits that grew the most are undone until it fits.
 * Rejected edits keep your original bullet. Every edit is listed on the
 * "Tailor changes" tab.
 *
 * Runs on its own for new matches from the alerts you name on the Resume
 * settings tab, or for one job with Resume Tailor > Tailor for selected job.
 * Shares a project with Alerts.gs; everything here is prefixed TL_/tl.
 */

const TL_TABS = { settings: 'Resume settings', bank: 'Bullet bank', skills: 'Skills bank', log: 'Tailored', changes: 'Tailor changes' };
const TL_LOG_HEADERS = ['Started', 'Company', 'Role', 'Job link', 'Tailored resume', 'Status', 'Checks', 'Job ID', 'Pasted job description'];
const TL_CHANGE_HEADERS = ['Tailored resume', 'Section', 'Before', 'After', 'From', 'Check'];
const TL_DEFAULT_MODEL = 'claude-opus-5-5';
const TL_API = 'https://api.anthropic.com/v1/messages';
// A new bullet may be this much longer than the one it replaces, so lines don't wrap.
const TL_GROWTH = 1.1;
const TL_JD_CHARS = 15000;
const TL_PER_RUN = 2;
const TL_RUN_BUDGET_MS = 4 * 60 * 1000;
const TL_AUTO_WINDOW_MS = 3 * 24 * 3600 * 1000;

// ---- Setup and menu --------------------------------------------------------------

function setupTailor() {
  const ss = SpreadsheetApp.getActive();
  tlSettingsSheet_(ss);
  tlBankSheet_(ss);
  tlSkillsSheet_(ss);
  tlSheet_(ss, TL_TABS.log, TL_LOG_HEADERS);
  tlSheet_(ss, TL_TABS.changes, TL_CHANGE_HEADERS);
  for (const t of ScriptApp.getProjectTriggers()) {
    if (['tailorQueue', 'tailorMenu'].includes(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('tailorQueue').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('tailorMenu').forSpreadsheet(ss).onOpen().create();
  tailorMenu();
}

function tailorMenu() {
  SpreadsheetApp.getUi().createMenu('Resume Tailor')
    .addItem('Tailor for selected job', 'tailorSelected')
    .addItem('Set Claude API key', 'setClaudeKey')
    .addSeparator()
    .addItem('Set up / repair', 'setupTailor')
    .addToUi();
}

/** The key is kept in your user properties, not on a tab, so people you share the sheet with can't see it. */
function setClaudeKey() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Claude API key', 'Paste a key from console.anthropic.com (starts with sk-ant-). ' +
    'It\'s stored for your Google account only, not in the sheet.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const key = r.getResponseText().trim();
  if (!/^sk-ant-/.test(key)) { ui.alert('That doesn\'t look like a Claude API key.'); return; }
  PropertiesService.getUserProperties().setProperty('TL_CLAUDE_KEY', key);
  ui.alert('Saved.');
}

function tlSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

function tlSettingsSheet_(ss) {
  let sh = ss.getSheetByName(TL_TABS.settings);
  if (sh) return sh;
  sh = ss.insertSheet(TL_TABS.settings);
  sh.getRange(1, 1, 8, 3).setValues([
    ['Setting', 'Value', 'Help'],
    ['Resume doc', '', 'Link to your resume as a Google Doc. A Word file works once opened in Google Docs ' +
      '(File > Save as Google Docs). It\'s never edited; each job gets a copy.'],
    ['Save copies in', '', 'Optional: link to a Drive folder for tailored copies. Empty = next to your resume.'],
    ['Auto-tailor alerts', '', 'Alert names (from the Alerts tab) whose new matches get a tailored resume ' +
      'automatically, comma-separated, or "All". Empty = only when you ask.'],
    ['Daily limit', 5, 'At most this many automatic tailorings a day. Each costs roughly $0.15-0.40 of Claude usage.'],
    ['Email when ready', true, 'Email you a link when an automatic tailoring finishes.'],
    ['Model', TL_DEFAULT_MODEL, 'Claude model. claude-sonnet-5-5 costs about half as much.'],
    ['Claude API key', '', 'Set it with Resume Tailor > Set Claude API key. It isn\'t stored on this tab.']
  ]);
  sh.getRange(1, 1, 1, 3).setFontWeight('bold');
  sh.getRange(6, 2).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  sh.setColumnWidth(1, 160).setColumnWidth(2, 320).setColumnWidth(3, 560);
  return sh;
}

function tlBankSheet_(ss) {
  let sh = ss.getSheetByName(TL_TABS.bank);
  if (sh) return sh;
  sh = tlSheet_(ss, TL_TABS.bank, ['Experience', 'Bullet', 'Skills it shows']);
  sh.getRange(1, 1, 1, 3).setNotes([[
    'Words from that role\'s heading line on your resume, e.g. "Amazon" or "Robotics Club". Each bullet can only replace bullets of that role.',
    'A bullet you\'ve written and stand behind. Only true things: the tailor won\'t add facts, but it will use these.',
    'Optional: what this bullet shows, e.g. "SQL, dashboards, A/B testing". Helps match it to jobs.'
  ]]);
  sh.getRange(2, 1, 2, 3).setValues([
    ['Amazon', 'Built a SQL pipeline that cut weekly report prep from 6 hours to 20 minutes for a 12-person team', 'SQL, automation'],
    ['Amazon', 'Analyzed 2M user sessions in Redshift to find the top 3 drivers of churn, presented to director', 'data analysis, Redshift']
  ]);
  sh.setColumnWidth(1, 160).setColumnWidth(2, 640).setColumnWidth(3, 240);
  return sh;
}

function tlSkillsSheet_(ss) {
  let sh = ss.getSheetByName(TL_TABS.skills);
  if (sh) return sh;
  sh = tlSheet_(ss, TL_TABS.skills, ['Category', 'Items']);
  sh.getRange(1, 1, 1, 2).setNotes([[
    'Match the labels on your resume\'s skills lines, e.g. Languages, Frameworks, Tools, Methodologies.',
    'Comma-separated. Only things you can talk about in an interview.'
  ]]);
  sh.getRange(2, 1, 4, 2).setValues([
    ['Languages', 'Python, Java, TypeScript, SQL, C++'],
    ['Frameworks', 'React, Node.js, PyTorch, Spring Boot'],
    ['Tools', 'Git, Docker, AWS, Linux, Tableau'],
    ['Methodologies', 'Agile, Scrum, Test-Driven Development, CI/CD, A/B Testing']
  ]);
  sh.setColumnWidth(1, 160).setColumnWidth(2, 640);
  return sh;
}

function tlSetting_(ss, label) {
  const sh = tlSettingsSheet_(ss);
  const rows = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 2).getValues();
  const row = rows.find((r) => r[0] === label);
  return row ? row[1] : '';
}

const tlDocId_ = (url) => (String(url || '').match(/\/d\/([\w-]{20,})/) || String(url || '').match(/^([\w-]{20,})$/) || [])[1] || '';
const tlFolderId_ = (url) => (String(url || '').match(/folders\/([\w-]{20,})/) || [])[1] || '';

// ---- Reading the resume ------------------------------------------------------------

const TL_BULLET_CHAR = /^\s*([•●▪◦‣∙·\-–—*]\s+)/;
const TL_HEADING = /^(?:(?:work|professional|relevant|technical|research|leadership|teaching)\s+)?(?:experiences?|employment(?: history)?|work history|projects?|leadership|extracurriculars?(?: activities)?|activities|involvement|skills|technical skills|technologies|tools|methodologies|education|coursework|relevant coursework|awards|honors|certifications?|publications|research|volunteering|volunteer experience|interests|summary|objective)(?:\s*(?:and|&|\/)\s*(?:technologies|tools|interests|projects|activities|leadership|methodologies|certifications|skills))*\s*:?$/i;

function tlSectionKind_(heading) {
  if (/skill|technolog|tools|methodolog/i.test(heading)) return 'skills';
  if (/experience|employment|work history|project|leadership|activit|extracurricular|involvement|research|volunteer/i.test(heading)) return 'experience';
  return 'other';
}

/** Paragraphs and list items in reading order, including those inside tables (common in resume templates). */
function tlParagraphs_(container, out) {
  const T = DocumentApp.ElementType;
  for (let i = 0; i < container.getNumChildren(); i++) {
    const el = container.getChild(i);
    const type = el.getType();
    if (type === T.PARAGRAPH) out.push(el.asParagraph());
    else if (type === T.LIST_ITEM) out.push(el.asListItem());
    else if (type === T.TABLE) tlParagraphs_(el.asTable(), out);
    else if (type === T.TABLE_ROW) tlParagraphs_(el.asTableRow(), out);
    else if (type === T.TABLE_CELL) tlParagraphs_(el.asTableCell(), out);
  }
  return out;
}

/**
 * The parts of a resume the tailor may change, in order:
 * bullets {id, kind:'bullet', section, entry, text, prefix, el} under
 * experience-like headings, and skills lines {id, kind:'skills', label, items,
 * sep, prefix, text, el} under skills headings. Ids are stable for the same
 * document, so a reopened copy lines up.
 */
function tlOutline(body) {
  const items = [];
  let section = null, kind = 'other', entryLines = [], lastWasBullet = false;
  for (const el of tlParagraphs_(body, [])) {
    const text = el.getText();
    const trimmed = text.trim();
    if (!trimmed) continue;
    const isList = el.getType() === DocumentApp.ElementType.LIST_ITEM;
    const charBullet = text.match(TL_BULLET_CHAR);
    const bullet = isList || Boolean(charBullet);
    // Headings are matched by name, not by style: company names are often bold or in capitals too.
    if (!bullet && trimmed.length <= 45 && TL_HEADING.test(trimmed)) {
      section = trimmed.replace(/:$/, '');
      kind = tlSectionKind_(section);
      entryLines = [];
      lastWasBullet = false;
      continue;
    }
    const prefix = charBullet ? charBullet[1] : (text.match(/^\s*/) || [''])[0];
    if (kind === 'skills') {
      const bodyText = text.slice(prefix.length);
      const colon = bodyText.indexOf(':');
      const hasLabel = colon > 0 && colon <= 40;
      const label = hasLabel ? bodyText.slice(0, colon).trim() : '';
      const itemsStart = hasLabel ? prefix.length + colon + 1 + (bodyText.slice(colon + 1).match(/^\s*/) || [''])[0].length : prefix.length;
      const itemsText = text.slice(itemsStart).trim();
      const sep = /\s\|\s/.test(itemsText) ? ' | ' : /;\s/.test(itemsText) ? '; ' : ', ';
      const list = itemsText.split(sep.trim()).map((s) => s.trim()).filter(Boolean);
      if (list.length >= 2) {
        items.push({ id: 's' + items.length, kind: 'skills', section, label, items: list, sep, prefix: text.slice(0, itemsStart), text, el });
      }
      continue;
    }
    if (kind === 'experience' && bullet) {
      items.push({ id: 'b' + items.length, kind: 'bullet', section, entry: entryLines.join(' — '), text: text.slice(prefix.length), prefix, el });
      lastWasBullet = true;
      continue;
    }
    if (kind === 'experience') {
      if (lastWasBullet) entryLines = [];
      entryLines.push(trimmed);
      lastWasBullet = false;
    }
  }
  // A skills line can grow to the length of the longest one: that one fits on its
  // line, so a shorter line has at least that much room. Wrapping is caught by
  // the page check in any case.
  const lines = items.filter((i) => i.kind === 'skills');
  const longest = Math.max(0, ...lines.map((l) => l.text.length));
  for (const l of lines) {
    const len = l.items.join(l.sep).length;
    l.limit = Math.max(Math.round(len * TL_GROWTH), len + 4, longest - l.prefix.length);
  }
  return items;
}

// ---- Banks -------------------------------------------------------------------------

function tlReadBank_(ss) {
  const sh = tlBankSheet_(ss);
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues()
    .map((r, i) => ({ id: 'k' + (i + 2), experience: String(r[0]).trim(), text: String(r[1]).trim(), skills: String(r[2]).trim() }))
    .filter((b) => b.experience && b.text);
}

function tlReadSkills_(ss) {
  const sh = tlSkillsSheet_(ss);
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues()
    .map((r) => ({ category: String(r[0]).trim(), items: String(r[1]).split(',').map((s) => s.trim()).filter(Boolean) }))
    .filter((c) => c.category && c.items.length);
}

const tlWords_ = (s) => String(s || '').toLowerCase().match(/[a-z0-9+#.]+/g) || [];

/** Bank bullets for a role: every word of the bank row's Experience appears in the role's heading lines. */
function tlBankFor(bank, entry) {
  const words = new Set(tlWords_(entry));
  return bank.filter((b) => tlWords_(b.experience).every((w) => words.has(w)));
}

// ---- Checks ------------------------------------------------------------------------

/** "6 hours", "2M", "$1.5k", "35%" -> "6", "2m", "$1.5k", "35%". Commas dropped: 12,000 = 12000. */
function tlNumbers(text) {
  return (String(text).match(/\$?\d[\d,]*(?:\.\d+)?\s*(?:%|[kmb]\b|x\b)?/gi) || [])
    .map((n) => n.replace(/,/g, '').replace(/\s+/g, '').toLowerCase());
}

const tlNorm_ = (s) => String(s).toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();

/** Problems with replacing `before` by `after`, given what it's based on: [] when it's fine. */
function tlCheckBullet(before, after, source) {
  const problems = [];
  const limit = Math.max(Math.round(before.length * TL_GROWTH), before.length + 6);
  if (after.length > limit) problems.push(`too long (${after.length} chars, limit ${limit})`);
  if (after.length < before.length * 0.5) problems.push('much shorter than the original');
  const have = tlNumbers(source);
  const extra = tlNumbers(after).filter((n) => !have.includes(n));
  if (extra.length) problems.push('numbers not in the source: ' + extra.join(', '));
  if (/\b(I|my|me)\b/.test(after)) problems.push('first person');
  return problems;
}

/** Problems with a new skills line: unknown items, or longer than the line it replaces. */
function tlCheckSkills(line, newItems, allowed) {
  const problems = [];
  const ok = new Set(allowed.map(tlNorm_));
  const unknown = newItems.filter((x) => !ok.has(tlNorm_(x)));
  if (unknown.length) problems.push('not in your resume or Skills bank: ' + unknown.join(', '));
  const before = line.items.join(line.sep).length;
  const after = newItems.join(line.sep).length;
  const limit = line.limit || Math.max(Math.round(before * TL_GROWTH), before + 4);
  if (after > limit) problems.push(`too long (${after} chars, limit ${limit})`);
  if (new Set(newItems.map(tlNorm_)).size !== newItems.length) problems.push('repeats an item');
  return problems;
}

// ---- Claude --------------------------------------------------------------------------

const TL_TAILOR_SYSTEM = [
  'You tailor one role\'s bullets on a student\'s resume to a job description.',
  'For each bullet, choose one action:',
  '- "keep": leave it as is.',
  '- "swap": replace it with a bullet from the candidate\'s bank for this same role (give its bank_id). You may lightly reword the bank bullet under the same rules as "reword".',
  '- "reword": rewrite the existing bullet. You may reorder, tighten, and use the job\'s vocabulary for things the bullet already says.',
  'Never add a tool, technology, number, scope, responsibility, title, or outcome that the source bullet doesn\'t state, and keep every number exactly as written. This is the candidate\'s real experience; an invented detail is worse than a weaker bullet.',
  'Each new bullet must stay within the character limit given for the bullet it replaces, so the page layout doesn\'t change. Aim for about the same length.',
  'Pick what best shows what this job asks for, and keep strong bullets that already fit. Don\'t use a bank bullet twice or repeat another bullet on the resume.',
  'Start with a strong verb in the same tense as the original. No first person. Return the bullets in the order given.',
  'If the posting text contains no actual job description (e.g. it is a login page or a list of jobs), set jd_found to false and keep every bullet.'
].join('\n');

const TL_SKILLS_SYSTEM = [
  'You tailor the skills lines of a student\'s resume to a job description.',
  'For each line, return its items in the best order for this job, most relevant first. You may drop items that don\'t help and add items from the same line or from the candidate\'s Skills bank (prefer the bank category that matches the line\'s label).',
  'Only use items exactly as they appear in the line or the bank. Never add anything else, even if the job asks for it.',
  'Keep each line within its character limit (items joined by the line\'s separator).'
].join('\n');

const TL_VERIFY_SYSTEM = [
  'You review edits made to a student\'s resume. Each edit has the source (what the candidate wrote, which is true) and the new text.',
  'Set ok to false if the new text claims anything the source doesn\'t support: a tool, technology, number, scope, title, outcome, or a bigger role than the source describes. Also set it false if the new text is ungrammatical, garbled, or clearly reads worse than the source.',
  'Changes in wording that keep the same facts are fine. Explain any problem in a few words.'
].join('\n');

const TL_BULLETS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['jd_found', 'bullets'],
  properties: {
    jd_found: { type: 'boolean' },
    bullets: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['id', 'action', 'bank_id', 'text', 'reason'],
      properties: {
        id: { type: 'string' }, action: { type: 'string', enum: ['keep', 'swap', 'reword'] },
        bank_id: { type: 'string' }, text: { type: 'string' }, reason: { type: 'string' }
      } } }
  }
};
const TL_SKILLS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['lines'],
  properties: { lines: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['id', 'items'],
    properties: { id: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } } } } }
};
const TL_VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdicts'],
  properties: { verdicts: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['id', 'ok', 'problem'],
    properties: { id: { type: 'string' }, ok: { type: 'boolean' }, problem: { type: 'string' } } } } }
};

/** A Messages API request for UrlFetchApp. Structured output keeps the reply parseable. */
function tlRequest(key, model, system, user, schema, withFallbacks) {
  const body = {
    model, max_tokens: 16000, system,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: user }]
  };
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  // If a safety classifier declines, Anthropic re-runs the request on a suitable model.
  if (withFallbacks) { body.fallbacks = 'default'; headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; }
  return { url: TL_API, method: 'post', contentType: 'application/json', headers, payload: JSON.stringify(body), muteHttpExceptions: true };
}

/** A response -> {data} or {error}. */
function tlParseResponse(res) {
  const code = res.getResponseCode();
  let json;
  try { json = JSON.parse(res.getContentText()); } catch (e) { return { error: `HTTP ${code}: unreadable reply` }; }
  if (code !== 200) return { error: `HTTP ${code}: ${(json.error && json.error.message) || ''}`.slice(0, 300), status: code };
  if (json.stop_reason === 'refusal') return { error: 'Claude declined this one' };
  if (json.stop_reason === 'max_tokens') return { error: 'reply was cut off' };
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return { data: JSON.parse(text) }; } catch (e) { return { error: 'reply wasn\'t valid JSON' }; }
}

/**
 * Runs several Claude calls at once: [{system, user, schema}] -> [{data}|{error}].
 * A 400 that mentions fallbacks is retried without them.
 */
function tlClaudeAll_(key, model, calls) {
  const send = (withFallbacks, which) => UrlFetchApp.fetchAll(which.map((c) => tlRequest(key, model, c.system, c.user, c.schema, withFallbacks)))
    .map(tlParseResponse);
  const out = send(true, calls);
  const retry = out.map((r, i) => (r.status === 400 && /fallback/i.test(r.error) ? i : -1)).filter((i) => i >= 0);
  if (retry.length) send(false, retry.map((i) => calls[i])).forEach((r, k) => { out[retry[k]] = r; });
  return out;
}

// ---- Job descriptions -------------------------------------------------------------

function tlText(html) {
  const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, '\'').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
  return decode(decode(String(html || ''))
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|h\d|li|tr|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n[ \n]*/g, '\n').trim();
}

/** "workday:host/site:R123" -> {ats, slug, jobId}. */
function tlSplitId(id) {
  const s = String(id || '');
  const first = s.indexOf(':'), last = s.lastIndexOf(':');
  if (first < 0 || last === first) return { ats: s.slice(0, first), slug: '', jobId: s.slice(first + 1) };
  return { ats: s.slice(0, first), slug: s.slice(first + 1, last), jobId: s.slice(last + 1) };
}

/** The request that gets a posting's full description, and how to read the reply. */
function tlJdRequest(job) {
  const { ats, slug, jobId } = tlSplitId(job.id);
  const get = (url) => ({ url, muteHttpExceptions: true, headers: { Accept: 'application/json' } });
  switch (ats) {
    case 'greenhouse':
      return [get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}`), (d) => tlText(d.content)];
    case 'lever':
      return [get(`https://api.lever.co/v0/postings/${slug}/${jobId}`), (d) => [d.descriptionPlain,
        ...(d.lists || []).map((l) => l.text + '\n' + tlText(l.content)), d.additionalPlain].filter(Boolean).join('\n')];
    case 'ashby':
      return [get(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`),
        (d) => ((d.jobs || []).find((j) => j.id === jobId) || {}).descriptionPlain || ''];
    case 'smartrecruiters':
      return [get(`https://api.smartrecruiters.com/v1/companies/${slug}/postings/${jobId}`),
        (d) => Object.values((d.jobAd && d.jobAd.sections) || {}).map((x) => (x.title ? x.title + '\n' : '') + tlText(x.text)).join('\n')];
    case 'workday': {
      const [host, site] = slug.split('/');
      const path = String(job.url).split(`${host}/${site}`)[1] || '';
      return [get(`https://${host}/wday/cxs/${host.split('.')[0]}/${site}${path}`), (d) => tlText(d.jobPostingInfo && d.jobPostingInfo.jobDescription)];
    }
    default:
      return [{ url: job.url, muteHttpExceptions: true, followRedirects: true }, null];
  }
}

/** {text, generic}: generic = scraped from a careers page, so Claude confirms it's really a job description. */
function tlFetchJd_(job) {
  const [{ url, ...params }, read] = tlJdRequest(job);
  const res = UrlFetchApp.fetch(url, params);
  if (res.getResponseCode() !== 200) return { text: '', generic: !read };
  const body = res.getContentText();
  try {
    const text = read ? read(JSON.parse(body)) : tlText(body);
    return { text: String(text || '').slice(0, TL_JD_CHARS), generic: !read };
  } catch (e) {
    return { text: '', generic: !read };
  }
}

// ---- Editing the copy -----------------------------------------------------------------

/** Replaces text from `start` to the end of a paragraph, keeping the formatting of its first replaced character. */
function tlReplaceFrom(el, start, newText) {
  const t = el.editAsText();
  const old = t.getText();
  if (start >= old.length) { t.appendText(newText); return; }
  const attrs = t.getAttributes(start);
  const keep = {};
  for (const k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) keep[k] = attrs[k];
  t.insertText(start, newText);
  t.deleteText(start + newText.length, start + newText.length + (old.length - start) - 1);
  if (newText.length) t.setAttributes(start, start + newText.length - 1, keep);
}

const tlApply_ = (item, after) => tlReplaceFrom(item.el, item.prefix.length, after);

/** Pages in an exported PDF: the page tree's /Count. */
function tlPdfPages(pdfText) {
  const counts = (String(pdfText).match(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g) || [])
    .map((m) => Number((m.match(/\/Count\s+(\d+)/) || [])[1] || 0));
  if (counts.length) return Math.max(...counts);
  return (String(pdfText).match(/\/Type\s*\/Page\b(?!s)/g) || []).length;
}

function tlPagesOf_(fileId) {
  const pdf = DriveApp.getFileById(fileId).getAs('application/pdf');
  return tlPdfPages(pdf.getDataAsString('ISO-8859-1'));
}

// ---- One tailoring ------------------------------------------------------------------

/**
 * Proposed edits for a resume outline: [{item, after, from, source}] plus
 * notes on what was rejected. `calls` returns Claude's replies in order.
 */
function tlPropose(outline, jd, bank, skillsBank, callClaude) {
  const bullets = outline.filter((i) => i.kind === 'bullet');
  const lines = outline.filter((i) => i.kind === 'skills');
  const entries = [];
  for (const b of bullets) {
    let e = entries.find((x) => x.entry === b.entry);
    if (!e) entries.push(e = { entry: b.entry, items: [] });
    e.items.push(b);
  }
  const jdBlock = `<job_description>\n${jd.text}\n</job_description>`;
  const allBullets = bullets.map((b) => '- ' + b.text).join('\n');
  const calls = entries.map((e) => {
    const own = tlBankFor(bank, e.entry);
    return {
      system: TL_TAILOR_SYSTEM, schema: TL_BULLETS_SCHEMA, entry: e, bank: own,
      user: `${jdBlock}\n\n<role>${e.entry || '(no heading)'}</role>\n\n<bullets>\n` +
        e.items.map((b) => `${b.id} (limit ${Math.max(Math.round(b.text.length * TL_GROWTH), b.text.length + 6)} chars): ${b.text}`).join('\n') +
        `\n</bullets>\n\n<bank>\n${own.map((k) => `${k.id}: ${k.text}${k.skills ? ` [shows: ${k.skills}]` : ''}`).join('\n') || '(none)'}\n</bank>\n\n` +
        `<whole_resume_bullets>\n${allBullets}\n</whole_resume_bullets>`
    };
  });
  const allSkills = [...new Set([...lines.flatMap((l) => l.items), ...skillsBank.flatMap((c) => c.items)])];
  if (lines.length) {
    calls.push({
      system: TL_SKILLS_SYSTEM, schema: TL_SKILLS_SCHEMA, skills: true,
      user: `${jdBlock}\n\n<lines>\n` + lines.map((l) => `${l.id} label="${l.label}" separator="${l.sep}" limit=${l.limit}: ${l.items.join(l.sep)}`).join('\n') + `\n</lines>\n\n<skills_bank>\n` +
        (skillsBank.map((c) => `${c.category}: ${c.items.join(', ')}`).join('\n') || '(none)') + '\n</skills_bank>'
    });
  }
  const replies = callClaude(calls);
  const edits = [], notes = [];
  let jdMissing = false;
  calls.forEach((c, i) => {
    const r = replies[i];
    if (r.error) { notes.push(`${c.skills ? 'skills' : c.entry.entry}: ${r.error}`); return; }
    if (c.skills) {
      for (const out of r.data.lines || []) {
        const line = lines.find((l) => l.id === out.id);
        if (!line) continue;
        const after = out.items.join(line.sep);
        if (after === line.items.join(line.sep)) continue;
        const problems = tlCheckSkills(line, out.items, allSkills);
        if (problems.length) { notes.push(`${line.label || 'skills'}: ${problems.join('; ')}`); continue; }
        edits.push({ item: line, before: line.items.join(line.sep), after, from: 'Skills bank', source: allSkills.join(', ') });
      }
      return;
    }
    if (r.data.jd_found === false) { jdMissing = true; return; }
    const usedBank = new Set();
    for (const out of r.data.bullets || []) {
      const b = c.entry.items.find((x) => x.id === out.id);
      if (!b || out.action === 'keep' || out.text.trim() === b.text.trim()) continue;
      const after = out.text.trim();
      let source = b.text, from = 'Reworded';
      if (out.action === 'swap') {
        const k = c.bank.find((x) => x.id === out.bank_id);
        if (!k || usedBank.has(k.id)) { notes.push(`${b.text.slice(0, 40)}…: bank bullet ${out.bank_id} isn't for this role`); continue; }
        usedBank.add(k.id);
        source = k.text;
        from = `Bullet bank row ${k.id.slice(1)}`;
      }
      const problems = tlCheckBullet(b.text, after, source);
      if (edits.some((e) => tlNorm_(e.after) === tlNorm_(after)) ||
          bullets.some((x) => x !== b && tlNorm_(x.text) === tlNorm_(after))) problems.push('duplicate of another bullet');
      if (problems.length) { notes.push(`${b.text.slice(0, 40)}…: ${problems.join('; ')}`); continue; }
      edits.push({ item: b, before: b.text, after, from, source });
    }
  });
  return { edits, notes, jdMissing };
}

/** Asks Claude to review every edit; returns the ones it rejects, by index, with why. */
function tlVerify(edits, callClaude) {
  if (!edits.length) return {};
  const user = '<edits>\n' + edits.map((e, i) => `<edit id="e${i}">\n<source>${e.source}</source>\n<before>${e.before}</before>\n<new>${e.after}</new>\n</edit>`).join('\n') + '\n</edits>';
  const [r] = callClaude([{ system: TL_VERIFY_SYSTEM, user, schema: TL_VERIFY_SCHEMA }]);
  // If the review itself fails, nothing is trusted: every edit is rejected.
  if (r.error) return Object.fromEntries(edits.map((e, i) => [i, 'review failed: ' + r.error]));
  const rejected = {};
  edits.forEach((e, i) => {
    const v = (r.data.verdicts || []).find((x) => x.id === 'e' + i);
    if (!v) rejected[i] = 'not reviewed';
    else if (!v.ok) rejected[i] = v.problem || 'rejected by review';
  });
  return rejected;
}

/**
 * Tailors the resume for one job: {status, url, checks}. Status is Done,
 * Done (no changes), Needs job description, or Failed.
 */
function tlTailor_(ss, job) {
  const key = PropertiesService.getUserProperties().getProperty('TL_CLAUDE_KEY');
  if (!key) return { status: 'Failed', checks: 'No Claude API key: Resume Tailor > Set Claude API key' };
  const resumeId = tlDocId_(tlSetting_(ss, 'Resume doc'));
  if (!resumeId) return { status: 'Failed', checks: 'Add your resume\'s link on the Resume settings tab' };
  const model = String(tlSetting_(ss, 'Model') || TL_DEFAULT_MODEL).trim();
  const callClaude = (calls) => tlClaudeAll_(key, model, calls);

  const jd = job.pastedJd ? { text: String(job.pastedJd).slice(0, TL_JD_CHARS), generic: false } : tlFetchJd_(job);
  if (jd.text.length < 300) return { status: 'Needs job description', checks: 'Couldn\'t read the posting. Paste it in the last column and pick Tailor for selected job again.' };

  const original = DriveApp.getFileById(resumeId);
  const folderId = tlFolderId_(tlSetting_(ss, 'Save copies in'));
  const name = `${original.getName()} - ${job.company} ${job.title}`.slice(0, 180);
  const copy = folderId ? original.makeCopy(name, DriveApp.getFolderById(folderId)) : original.makeCopy(name);
  const url = 'https://docs.google.com/document/d/' + copy.getId() + '/edit';

  let doc = DocumentApp.openById(copy.getId());
  let outline = tlOutline(doc.getBody());
  if (!outline.length) {
    copy.setTrashed(true);
    return { status: 'Failed', checks: 'Found no bullets under an Experience/Projects heading and no Skills lines.' };
  }
  const { edits, notes, jdMissing } = tlPropose(outline, jd, tlReadBank_(ss), tlReadSkills_(ss), callClaude);
  if (jdMissing && !edits.length) {
    copy.setTrashed(true);
    return { status: 'Needs job description', checks: 'That page doesn\'t contain the job description. Paste it in the last column and try again.' };
  }
  const rejected = tlVerify(edits, callClaude);
  const kept = edits.filter((e, i) => !(i in rejected));
  Object.keys(rejected).forEach((i) => notes.push(`review: "${edits[i].after.slice(0, 50)}…" ${rejected[i]}`));
  for (const e of kept) tlApply_(e.item, e.after);
  doc.saveAndClose();

  // The copy must fit on as many pages as the resume. Undo the edits that grew most until it does.
  let pageNote = '';
  if (kept.length) {
    const before = tlPagesOf_(resumeId);
    let after = tlPagesOf_(copy.getId());
    const byGrowth = kept.slice().sort((a, b) => (b.after.length - b.before.length) - (a.after.length - a.before.length));
    let undone = 0;
    while (after > before && undone < Math.min(byGrowth.length, 4)) {
      const e = byGrowth[undone++];
      doc = DocumentApp.openById(copy.getId());
      outline = tlOutline(doc.getBody());
      const item = outline.find((x) => x.id === e.item.id);
      if (item) tlApply_(item, e.before);
      doc.saveAndClose();
      e.undone = true;
      after = tlPagesOf_(copy.getId());
    }
    pageNote = after > before ? `; still ${after} pages vs ${before}, check the layout` : `; ${after} page${after === 1 ? '' : 's'}, same as your resume` +
      (undone ? ` after undoing ${undone} edit(s)` : '');
  }

  const applied = kept.filter((e) => !e.undone);
  tlLogChanges_(ss, url, edits, rejected);
  const checks = `${applied.length} edit(s) made${pageNote}` + (notes.length ? '. Not used: ' + notes.join(' | ') : '');
  return { status: applied.length ? 'Done' : 'Done (no changes)', url, checks: checks.slice(0, 2000) };
}

function tlLogChanges_(ss, url, edits, rejected) {
  if (!edits.length) return;
  const sh = tlSheet_(ss, TL_TABS.changes, TL_CHANGE_HEADERS);
  const rows = edits.map((e, i) => [url, e.item.kind === 'skills' ? (e.item.label || 'Skills') : (e.item.entry || e.item.section),
    e.before, e.after, e.from, i in rejected ? 'Rejected: ' + rejected[i] : e.undone ? 'Undone: page overflow' : 'Applied']);
  sh.insertRowsBefore(2, rows.length);
  sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

function tlLog_(ss, job, result, row) {
  const sh = tlSheet_(ss, TL_TABS.log, TL_LOG_HEADERS);
  const values = [new Date(), job.company, job.title, job.url, result.url || '', result.status, result.checks || '', job.id, job.pastedJd || ''];
  if (row) { sh.getRange(row, 1, 1, values.length).setValues([values]); return; }
  sh.insertRowsBefore(2, 1);
  sh.getRange(2, 1, 1, values.length).setValues([values]);
}

// ---- Running it ----------------------------------------------------------------------

/** Menu: tailor for the selected row of Matches, Open now, or Tailored (a retry, using a pasted description). */
function tailorSelected() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getActiveSheet();
  const row = ss.getActiveRange().getRow();
  const ui = SpreadsheetApp.getUi();
  if (row < 2) { ui.alert('Select a job\'s row first.'); return; }
  let job, logRow = 0;
  const v = sh.getRange(row, 1, 1, 9).getValues()[0];
  if (sh.getName() === TL_TABS.log) {
    job = { company: v[1], title: v[2], url: v[3], id: v[7], pastedJd: v[8] };
    logRow = row;
  } else if ([IA_TABS.matches, IA_TABS.open].includes(sh.getName())) {
    job = { company: v[1], title: v[2], url: v[5], id: v[8] };
  } else {
    ui.alert('Select a row on the Matches, Open now, or Tailored tab.');
    return;
  }
  const result = tlTailor_(ss, job);
  tlLog_(ss, job, result, logRow);
  ui.alert(`${result.status}${result.url ? '\n' + result.url : ''}\n\n${result.checks || ''}`);
}

/** Every 15 minutes: tailors new matches from the alerts named on Resume settings, within the daily limit. */
function tailorQueue() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(5000)) return;
  try {
    const ss = SpreadsheetApp.getActive();
    const auto = String(tlSetting_(ss, 'Auto-tailor alerts') || '').trim();
    if (!auto || !PropertiesService.getUserProperties().getProperty('TL_CLAUDE_KEY')) return;
    const wanted = /^all$/i.test(auto) ? null : auto.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const limit = Number(tlSetting_(ss, 'Daily limit')) || 0;
    const props = PropertiesService.getScriptProperties();
    const dayKey = 'TL_DAY:' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    let today = Number(props.getProperty(dayKey) || 0);
    if (today >= limit) return;

    const log = tlSheet_(ss, TL_TABS.log, TL_LOG_HEADERS);
    const done = new Set(log.getLastRow() > 1 ? log.getRange(2, 8, log.getLastRow() - 1, 1).getValues().map((r) => String(r[0])) : []);
    const matches = ss.getSheetByName(IA_TABS.matches);
    if (!matches || matches.getLastRow() < 2) return;
    const now = Date.now(), started = now;
    const rows = matches.getRange(2, 1, Math.min(matches.getLastRow() - 1, 300), 9).getValues();
    const todo = rows.filter((r) => r[8] && !done.has(String(r[8])) && now - new Date(r[0]).getTime() < TL_AUTO_WINDOW_MS &&
      (!wanted || String(r[6]).split(',').some((a) => wanted.includes(a.trim().toLowerCase()))));
    let ran = 0;
    for (const r of todo) {
      if (ran >= TL_PER_RUN || today >= limit || Date.now() - started > TL_RUN_BUDGET_MS) break;
      const job = { company: r[1], title: r[2], url: r[5], id: String(r[8]) };
      const result = tlTailor_(ss, job);
      tlLog_(ss, job, result, 0);
      ran++;
      props.setProperty(dayKey, String(++today));
      if (result.url && tlSetting_(ss, 'Email when ready') === true) {
        MailApp.sendEmail({
          to: Session.getEffectiveUser().getEmail(), name: 'Resume Tailor',
          subject: `Tailored resume ready: ${job.company} - ${job.title}`,
          htmlBody: `<p><a href="${result.url}">Your tailored resume</a> for <a href="${job.url}">${job.title}</a> at ${job.company}.</p>` +
            `<p style="color:#555">${String(result.checks).replace(/[<>&]/g, '')}</p>` +
            `<p style="color:#888;font-size:12px">Every edit is on the Tailor changes tab. Read it over before you send it.</p>`
        });
      }
    }
  } finally {
    lock.releaseLock();
  }
}
