# AK's F1 Mission Control

A decision dashboard for F1 Fantasy. It answers one question well: **what should my team be before this weekend's lock, and why?**

Live race data, session-level weather, betting markets, a risk-adjusted asset model, and an exhaustive team optimiser — refreshed automatically, with every figure traceable to a named source.

**→ [Live dashboard](https://f1-mission-control.vercel.app)**

---

## Why it exists

F1 Fantasy decisions happen in the days before qualifying locks the squad: which driver to boost, when to burn a chip, whether to chase a rival or protect a lead. The information needed to make them well is spread across five sites, and the most useful signals aren't published anywhere — they have to be derived.

This pulls it into one place and computes what's missing: rolling form, points-per-million efficiency, risk-adjusted return, and the single highest-scoring legal squad that fits the budget cap.

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
- **Git is the database** — every refresh is a diffable, timestamped commit, so the season accumulates in the commit log
- **Vercel** serves static files from the edge
- **The browser** does all derivation, so every interactive control responds instantly

The tradeoff: data is fresh as of the last pipeline run rather than the current instant. For a game where squads lock before qualifying, that costs nothing.

### Data sources

| Data | Source | Automated |
|---|---|---|
| Race calendar, sessions, circuits | [Jolpica-F1](https://api.jolpi.ca/) | ✅ |
| Championship standings | Jolpica-F1 | ✅ |
| Race results & derived form | Jolpica-F1 | ✅ |
| Session-level weather | [Open-Meteo](https://open-meteo.com/) | ✅ |
| Betting markets (winner / pole / fastest lap) | [Polymarket](https://polymarket.com/) Gamma API | ✅ |
| Fantasy prices & per-round scoring | [f1fantasytools.com](https://f1fantasytools.com) | ✅ (page scrape) |
| Fantasy league standings | Manual entry | ❌ — no public API |
| Squad & chip inventory | Manual entry | ❌ |

F1 Fantasy publishes no public API. Rather than automate an authenticated session — fragile, and it requires storing credentials — the dashboard has an **Update League** panel. It takes about thirty seconds after each race and cannot break.

The **Data** tab states which figures are automated, which are hand-entered, and when each last changed.

---

## The asset model

f1fantasytools publishes no API, but its team-calculator page ships the full asset dataset in its server-rendered payload: official fantasy prices plus a per-round breakdown of all 16 fantasy scoring components.

That breakdown is the valuable part. Summing components per round yields a points-per-round series for every driver and constructor, and the analysis follows from it:

| Metric | Definition | Answers |
|---|---|---|
| **Mean** | average points per round | Who has the highest ceiling? |
| **σ** | standard deviation of that series | How reliable are they? |
| **Sharpe** | mean ÷ σ | Who delivers reward per unit of risk? |
| **Points per $M** | mean ÷ price | Who frees up cap space? |
| **Momentum** | last two rounds vs season mean | Who is trending, against their own baseline? |

The rankings disagree, which is the point. Through Round 10, Mercedes leads on raw points (87.8/round) while Alpine leads on Sharpe (3.22) — a cheap constructor whose consistency the points view buries. Which lens is correct depends on whether you're chasing or protecting a lead.

### Team Builder

Given the budget cap, the optimiser finds the highest-scoring legal squad — five drivers and two constructors — by **exhaustive search rather than sampling**, so the result is a true optimum rather than an approximation.

It enumerates every 5-driver combination once (C(22,5) = 26,334), records the best score achievable at each cost, then tests all constructor pairs against that table. It reports the squad, the cost, the projected gain over the current squad, and the exact transfers required — flagged against the free-transfer allowance.

---

## Design rules

**No data in the presentation layer.** `assets/app.js` loads `data/*.json` and renders; it never contains values. This is what lets a scheduled job refresh the entire dashboard without touching a line of code.

**The current round is derived, never stored.** Every run recomputes where the season stands from today's date against the calendar. There is no state to fall out of sync.

**Silence is a bug.** A failed pipeline run exits non-zero so the failure surfaces. The UI independently checks freshness and says so when data is older than the current round.

**Renderers are isolated.** Each section renders in its own error boundary, so one failure cannot blank the page.

**Colour never carries meaning alone.** Constructor colours always accompany a text code; drivers are circles and constructors squares in the scatter plot; status colours always ship with an icon and label.

---

## Running locally

```bash
node scripts/build-data.mjs   # fetch fresh data into data/
node scripts/dev-server.mjs   # serve at http://localhost:4321
```

No dependencies, no build step. Node 22+.

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
│   ├── markets.json        #   Polymarket probabilities
│   ├── assets.json         #   prices, per-round scoring, derived metrics
│   ├── fantasy.json        #   manual: league, squad, chips
│   └── meta.json           #   provenance + per-source health
├── scripts/
│   ├── build-data.mjs      # the pipeline
│   └── dev-server.mjs      # local preview
└── .github/workflows/
    └── refresh-data.yml    # scheduled refresh
```

League data is anonymised: teams are identified by team name only.

Unofficial. Not affiliated with Formula 1.
