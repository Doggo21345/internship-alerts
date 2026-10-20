/**
 * Starts the scan workflow about every 20 minutes. Only the repo owner needs this,
 * in its own Apps Script project (not in anyone's alerts sheet).
 *
 * Why: GitHub runs scheduled workflows "best effort". On this repo the
 * every-20-minutes schedule fired twice in 13 hours (2026-10-20), so the
 * schedule alone can leave alerts hours late. Apps Script time triggers are
 * reliable, and a workflow started through the API runs right away.
 *
 * Setup:
 *  1. github.com > Settings > Developer settings > Fine-grained tokens >
 *     Generate. Repository access: only internship-alerts. Permissions:
 *     Actions: Read and write. Nothing else.
 *  2. script.google.com > New project. Paste this file.
 *  3. Project Settings > Script properties > add GITHUB_TOKEN = the token.
 *  4. Run setupKicker once and approve.
 */

const KICK_REPO = 'Doggo21345/internship-alerts';
const KICK_WORKFLOW = 'scan.yml';

function setupKicker() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'kickScan') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('kickScan').timeBased().everyMinutes(10).create();
  kickScan();
}

/**
 * Every 10 minutes: starts a scan unless one is running or queued, or the
 * last one began under 18 minutes ago. That works out to a scan every 20.
 */
function kickScan() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('Add GITHUB_TOKEN under Project Settings > Script properties.');
  const api = 'https://api.github.com/repos/' + KICK_REPO + '/actions/workflows/' + KICK_WORKFLOW;
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };

  const runs = JSON.parse(UrlFetchApp.fetch(api + '/runs?per_page=1', { headers }).getContentText()).workflow_runs || [];
  const last = runs[0];
  if (last && last.status !== 'completed') return;
  if (last && Date.now() - Date.parse(last.created_at) < 18 * 60 * 1000) return;

  const res = UrlFetchApp.fetch(api + '/dispatches', {
    method: 'post', headers, contentType: 'application/json',
    payload: JSON.stringify({ ref: 'main' }), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 204) {
    throw new Error('GitHub said ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
}
