# Internship Alerts

Get an email and a phone notification when an internship you care about is
posted. You set alerts in a Google Sheet, e.g. "Software, Summer 2027, US",
"Big Tech or YC startups in Austin", or "Stripe, Jane Street, Ramp".

## How it works

```
GitHub Action, every 20 min                    Your Google Sheet, every 15 min
  reads ~2,600 company job boards  ── data ──▶   keeps what fits your Alerts tab
  + Simplify's internship list      branch      emails you + pushes to your phone
  publishes what's new                          logs it on the Matches tab
```

- **The scanner** (`scripts/scan.mjs`, run by `.github/workflows/scan.yml`)
  reads every board in `data/boards.json` and publishes three files to the
  `data` branch:
  - `new.json`: postings first seen in the last 3 days
  - `open.json`: every open internship
  - `companies.json`: the companies it covers

  It only reads each company's public job listings. A company's first scan
  only records what's already posted. After that, a posting counts as new when
  it appears and isn't dated more than 14 days back.
- **The board list** (`scripts/build-boards.mjs`, weekly via
  `.github/workflows/boards.yml`) comes from three places:
  - every Greenhouse, Lever, Ashby, SmartRecruiters and Workday board that
    [Simplify's internship list](https://github.com/SimplifyJobs/Summer2026-Internships)
    links to;
  - `data/extra-boards.txt`;
  - YC companies marked as hiring, found by trying their names as board
    addresses.

  Boards that no longer exist are dropped.
- **The sheet** (`apps-script/Alerts.gs`) reads `new.json` every 15 minutes
  and keeps what matches your alerts. For each company on your list that the
  scanner doesn't cover, it looks for a Greenhouse, Lever or Ashby board and
  checks that board itself.

Coverage on 2026-10-20: 2,574 boards (1,033 Workday, 681 Ashby, 547 Greenhouse,
187 Lever, 126 SmartRecruiters), plus Simplify's listings on companies' own
career sites (Google, Meta, Apple, Microsoft, TikTok...). A full scan found
9,870 open internships and took about 3 minutes.

## Set up your sheet (5 minutes)

1. Create a Google Sheet. Open **Extensions > Apps Script**.
2. Replace `Code.gs` with this repo's `apps-script/Alerts.gs`. Then, in Project
   Settings, tick **Show "appsscript.json" manifest file in editor**, and
   replace that file with `apps-script/appsscript.json`. Rename the project
   (e.g. "Internship Alerts"). That name is what the permission screen shows.

   Already using the job tracker? You can add `Alerts.gs` as a second file in
   the same project. Its names don't collide with `Code.gs`. Merge the two
   manifests' `oauthScopes` lists.
3. Pick `setupAlerts` in the function dropdown and click **Run**, then approve.

   **"Google hasn't verified this app"** is expected: it's your own script.
   Click **Advanced**, then **Go to (project name)**, then **Allow**. School and
   work accounts sometimes block this; use a personal Gmail.

   | Permission | Why |
   |---|---|
   | See, edit, create and delete **only this spreadsheet** | the Alerts, Matches and settings tabs |
   | Send email as you | the alert emails, to the address on the settings tab |
   | Connect to an external service | reads the postings feed, job boards, and sends phone pushes |
   | Run when you're not present | the 15-minute check |
   | Display third-party web content | the "Internship Alerts" menu |
   | See your primary email address | the default address for alerts |
4. **Phone alerts:** install the free [ntfy](https://ntfy.sh) app (iPhone or
   Android), tap **+**, and subscribe to the **Push topic** from the
   **Alert settings** tab. Anyone who knows the topic can read your alerts, so
   keep the random one setup made.
5. Edit the **Alerts** tab. Hover over a header to see what that column does. Then use
   **Internship Alerts > Send a test alert** to check email and push, and
   **Show what's open now** to see everything that already fits your alerts.

The sheet keeps checking when it's closed: the 15-minute trigger runs on
Google's servers. **Alert settings > Last result** shows what the last check did.

### Alert columns

| Column | Example | Notes |
|---|---|---|
| Role keywords | `software, backend` | whole words in the title |
| Role types | `Software, Data/AI` | from Software, Data/AI, Hardware, Quant, Product, Design, Business. Titles that fit none ("Engineering Intern") are kept |
| Term | `Summer 2027` | titles that name no term are kept |
| Country | `US, CA` | postings that don't say (e.g. "Remote") are kept |
| Cities / states | `Austin, TX, Remote` | for local jobs |
| Company types | `Big Tech, YC Startup, Quant` | |
| Companies | `Stripe, Jane Street` | or a Greenhouse, Lever or Ashby jobs link. A posting fits if it's from one of these OR of one of the Company types |
| Exclude words | `PhD, MBA` | |

## Limits worth knowing

- **Workday has no public API.** The scanner uses the JSON endpoint behind
  Workday career pages, which could change. Workday dates are only "Posted
  Today" or "Posted 3 Days Ago", so they're approximate. Workday also limits
  request rates, so its boards are read 4 at a time with retries.
- **YC board matching is by name**, so a YC company can be matched to a
  different company's board with the same name.
- **Company types are curated lists** (`lib/classify.js`) plus the YC
  directory. "VC-funded" beyond YC needs a data source we don't have (Crunchbase
  is paid).
- **Google's limits on a free account:** about 100 alert emails a day (one per
  check, at most) and 90 minutes of trigger time a day (a check takes seconds).
- **Handshake isn't scraped:** it's behind your school login and its terms
  forbid it. Planned: read Handshake's own alert emails from Gmail, alongside the
  job tracker.

## Running it yourself

```
npm test
node scripts/build-boards.mjs     # ~15 min; --skip-yc and --limit N for quick runs
node scripts/scan.mjs             # writes out/
```

To add companies to everyone's scan, add lines to `data/extra-boards.txt`. That
also triggers a rebuild of the board list.

**Keeping scans on time.** GitHub runs scheduled workflows "best effort."
On this repo the every-20-minutes schedule fired only twice in 13 hours. To
fix that, the repo owner runs `apps-script/Kicker.gs` in a separate Apps Script
project. It starts a scan through the GitHub API about every 20 minutes;
setup steps are at the top of the file. Anyone running a copy of the scanner
needs their own kicker.

GitHub turns off scheduled workflows in public repos after 60 days without
activity. The weekly board-list commit should prevent that. If the scan ever
stops, re-enable it under **Actions**.
