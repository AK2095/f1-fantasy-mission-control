# 🏎️ F1 Fantasy Mission Control

A decision dashboard for F1 Fantasy. It answers one question well: **what should my lineup be before this weekend's lock, and why?**

Live data, session-level weather, rolling driver form, and league position — refreshed automatically, with every number traceable to a named source.

**→ [Live site](https://f1-mission-control.vercel.app)**

---

## Why this exists

I play F1 Fantasy in an 8-team league. The decisions that matter — which driver to boost, when to burn a chip, whether to chase or protect a lead — all happen in the days before qualifying locks the lineup. The information needed to make them well is scattered across five sites.

This pulls it into one page and adds the derived signals that aren't published anywhere: rolling form, positions-gained rates, reliability risk, and weather resolved to individual sessions rather than "the weekend."

This is v2. [v1 failed](docs/POSTMORTEM.md) in an instructive way, and that postmortem drove most of the architecture below.

---

## Architecture

```
GitHub Actions (cron)  →  scripts/build-data.mjs  →  data/*.json  →  git commit
                                                                        ↓
                                                            Vercel builds & serves
                                                                        ↓
                                                   Browser: fetch JSON → derive → render
```

**There is no backend.** No database, no serverless functions, no secrets.

- **GitHub Actions** is the compute layer — it runs the pipeline on a schedule
- **Git is the database** — every refresh is a diffable, timestamped commit; the season accumulates in the commit log
- **Vercel** is a CDN serving static files
- **The browser** does all derivation, so the interactive parts are instant

The tradeoff: data is fresh as of the last pipeline run rather than the current instant. For a game where lineups lock before qualifying, that costs nothing.

### Data sources

| Data | Source | Automated |
|---|---|---|
| Race calendar, sessions, circuits | [Jolpica-F1](https://api.jolpi.ca/) | ✅ |
| Championship standings | Jolpica-F1 | ✅ |
| Race results & derived form | Jolpica-F1 | ✅ |
| Session-level weather | [Open-Meteo](https://open-meteo.com/) | ✅ |
| Betting markets (winner / pole / fastest lap) | [Polymarket](https://polymarket.com/) Gamma API | ✅ |
| Fantasy prices & per-round scoring | [f1fantasytools.com](https://f1fantasytools.com) | ✅ (scrape) |
| Fantasy league standings | Manual entry | ❌ — no public API |
| Lineup & chip inventory | Manual entry | ❌ |

### The asset model

f1fantasytools publishes no API, but its team-calculator page ships the full asset
dataset in its server-rendered payload: official fantasy prices plus a per-round
breakdown of all 16 fantasy scoring components.

That breakdown is the valuable part. Summing components per round yields a
points-per-round series for every driver and constructor, and the three Strategy
Analyzer objectives fall out of it directly:

| Objective | Metric | Answers |
|---|---|---|
| **Points** | mean points per round | Who has the highest ceiling? |
| **Budget** | mean points per $M | Who frees up cap space? |
| **Sharpe** | mean ÷ standard deviation | Who delivers *reliably*? |

The three disagree, which is the point. Through Round 10, Mercedes leads on raw
points (87.8/round) but Alpine leads on Sharpe (3.22) — a cheap constructor whose
consistency the raw-points view buries. Which lens is correct depends on whether
you are chasing or protecting a lead.

Because it is a scrape of a rendered page rather than a contract, this is the most
fragile source here. It fails soft: every other section is unaffected, and the
provenance table reports the failure.

F1 Fantasy publishes no public API. Rather than scrape an authenticated session — fragile, and it requires storing credentials — the site has an **Update League** panel. It takes about 30 seconds after each race, and it cannot break.

The **Data Provenance** section on the page states which numbers are automated, which are hand-entered, and when each last changed. Nothing is presented as fresher than it is.

---

## Design rules

These are load-bearing, and each one exists because v1 violated it.

**1 · No data in the presentation layer.** `assets/app.js` loads `data/*.json` and renders. It never contains values. v1 inlined a state snapshot into the HTML "so the artifact is self-contained," which silently forked it from the file the automation updated — the dashboard then displayed a frozen copy for months.

**2 · Never store a pointer to "now."** The current round is derived from today's date against the calendar on every run. v1 stored `raceStartUTC` and gated every task on it, including the only task that could advance it. One missed Sunday deadlocked it permanently.

**3 · Silence is a bug.** A pipeline run that fails exits non-zero so GitHub emails about it. The UI independently checks freshness and shows a banner when data is older than the current round. v1's tasks no-op'd invisibly a dozen times.

**4 · Renderers are isolated.** Each section renders in its own try/catch. One failure can't blank the page — v1's entire boot sequence died on a single silent exception.

**5 · Color never carries meaning alone.** Constructor colors always accompany a driver code or team name; status colors always ship with an icon and label.

---

## Running locally

```bash
node scripts/build-data.mjs   # fetch fresh data into data/
node scripts/dev-server.mjs   # serve at http://localhost:4321
```

No dependencies. No build step. Node 22+.

---

## Repo layout

```
├── index.html              # structure only — no data, no logic
├── assets/
│   ├── styles.css          # design system: surfaces, ink, validated palette
│   └── app.js              # load → derive → render
├── data/                   # written by the pipeline; the "database"
│   ├── season.json         #   derived position in the season
│   ├── calendar.json       #   all rounds, sessions, circuits
│   ├── standings.json      #   driver + constructor championship
│   ├── results.json        #   per-round results
│   ├── weather.json        #   forecast per session + scenario model
│   ├── fantasy.json        #   manual: league, lineup, chips
│   └── meta.json           #   provenance + per-source health
├── scripts/
│   ├── build-data.mjs      # the pipeline
│   └── dev-server.mjs      # local preview
└── .github/workflows/
    └── refresh-data.yml    # scheduled refresh
```

---

## Status

Phase 0 — live, real data, all sections rendering. Next: season-long history for backtesting, a client-side lineup optimizer, and a measured comparison of model recommendations against actual picks.

Unofficial. Not affiliated with Formula 1.
