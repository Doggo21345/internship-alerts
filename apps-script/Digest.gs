/**
 * Daily roundup: every morning, emails you a LinkedIn post and a newsletter
 * listing the internships and new grad jobs that opened in the last 24 hours.
 * Only the repo owner needs this. It can share an Apps Script project with
 * Kicker.gs, but doesn't need an alerts sheet.
 *
 * The scanner writes the roundup (digest.json on the data branch) on every
 * scan; this only fetches it and sends it. Nothing is posted for you:
 *  - LinkedIn: copy the post from the email, or use its "Open LinkedIn" link.
 *    Put your newsletter link in the first comment.
 *  - beehiiv: copy the newsletter part of the email into a new post. Pasting
 *    keeps the headings, bold and links.
 *
 * Setup:
 *  1. script.google.com > New project (or the Kicker project). Paste this file.
 *  2. Optional, in Project Settings > Script properties:
 *     DIGEST_TO = where to send it (defaults to your Google account's address)
 *     DIGEST_HOUR = hour of day to send, 0-23 in the project's time zone (default 8)
 *  3. Run setupDigest once and approve. Run sendDigest to get one right away.
 */

const DIGEST_URL = 'https://raw.githubusercontent.com/Doggo21345/internship-alerts/data/digest.json';
// A roundup older than this means scans have stopped; the email says so.
const DIGEST_STALE_MS = 3 * 3600 * 1000;

function setupDigest() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'sendDigest') ScriptApp.deleteTrigger(t);
  }
  const hour = Number(PropertiesService.getScriptProperties().getProperty('DIGEST_HOUR') || 8);
  ScriptApp.newTrigger('sendDigest').timeBased().everyDays(1).atHour(hour).create();
}

function sendDigest() {
  const res = UrlFetchApp.fetch(DIGEST_URL, { muteHttpExceptions: true });
  const to = PropertiesService.getScriptProperties().getProperty('DIGEST_TO') ||
    Session.getEffectiveUser().getEmail();
  if (res.getResponseCode() !== 200) {
    MailApp.sendEmail({ to, subject: 'Daily roundup: couldn\'t read digest.json',
      htmlBody: `<p>${DIGEST_URL} answered HTTP ${res.getResponseCode()}. Check the scan workflow on GitHub.</p>` });
    return;
  }
  const d = JSON.parse(res.getContentText());
  if (!d.counts.internships && !d.counts.newGrad) return;
  const { subject, htmlBody } = digestEmail(d, Date.now());
  MailApp.sendEmail({ to, subject, htmlBody, name: 'Daily roundup' });
}

const dgHtml_ = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The email: the LinkedIn post first, then the newsletter, ready to copy. */
function digestEmail(d, now) {
  const stale = now - d.generatedAt > DIGEST_STALE_MS
    ? `<p style="color:#b00020"><b>Heads up:</b> this roundup is from ${Math.round((now - d.generatedAt) / 36e5)} hours ago. ` +
      `Scans may have stopped; check the scan workflow on GitHub.</p>`
    : '';
  // LinkedIn opens its composer with this text filled in. If it ever stops
  // doing that, copy the post from the box above instead.
  const share = 'https://www.linkedin.com/feed/?shareActive=true&text=' + encodeURIComponent(d.linkedin);
  const htmlBody = stale +
    `<h1 style="font-family:sans-serif;font-size:18px">1. LinkedIn post</h1>` +
    `<pre style="white-space:pre-wrap;font-family:sans-serif;font-size:14px;background:#f4f4f4;padding:12px;border-radius:6px">${dgHtml_(d.linkedin)}</pre>` +
    `<p style="font-family:sans-serif"><a href="${dgHtml_(share)}">Open LinkedIn with this post filled in</a>. ` +
    `Put your newsletter link in the first comment.</p>` +
    `<hr><h1 style="font-family:sans-serif;font-size:18px">2. Newsletter</h1>` +
    `<p style="font-family:sans-serif;color:#555">Title: <b>${dgHtml_(d.subject)}</b><br>` +
    `Copy everything below the line into a new beehiiv post.</p><hr>` +
    `<div style="font-family:sans-serif;font-size:14px">${d.html}</div>`;
  return { subject: `Roundup ready: ${d.subject}`, htmlBody };
}
