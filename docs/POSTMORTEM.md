# Postmortem — why v1 froze

**Written:** 22 July 2026
**Subject:** F1 Fantasy Mission Control v1 (`AK2095/f1-mission-control`)
**Impact:** Dashboard displayed data from 3 May for 11 weeks. Six scheduled refresh tasks ran ~40 times during that period and changed nothing. No alert fired.

This document exists because the failure was more interesting than the feature. It drove every architectural decision in v2.

---

## What v1 was

A single 1,618-line HTML file with inline CSS and JavaScript, plus a shared `state.js` data file, hosted on GitHub Pages. Six scheduled tasks ran on a laptop, scraped data, edited `state.js`, committed, and pushed. GitHub Pages rebuilt; the dashboard showed new numbers.

It worked for one weekend.

---

## Timeline

| Date | Event |
|---|---|
| 2 May 2026 | Built. Initial commit. |
| 3 May 2026 | A scheduled task rewrote `state.js` into a smaller schema, deleting five top-level keys. Charts went blank. |
| 3 May 2026 | Fixed by force-push; added a schema validator + pre-commit hook. Last commit ever pushed. |
| 23 May 2026 | An artifact re-export inlined `state.js` into `index.html`. **Never committed.** |
| 24 May 2026 | Round 5 (Canada). The last date `state.js` knew about. |
| 25 May – 22 Jul | Tasks ran ~40 times. Zero commits. Zero alerts. Data frozen. |
| 22 Jul 2026 | Investigated. Five independent root causes found. |

---

## Root causes

### 1 · The deadlock (primary)

Every scheduled task began with a guard against `RACE_SCHEDULE.raceStartUTC`:

```
postrace-update:   exit if race > 36h in the past
data-refresh:      exit if race finished > 2 days ago
schedule-monitor:  exit if race > 1 day in the past
```

The only task that *advanced* `raceStartUTC` was `postrace-update`, at step 5 of its procedure. But it exited at step 2.

**The clock could only advance if the clock was already current.**

This is a circular dependency with no recovery path. It didn't degrade — it was fine, then permanently dead, with a single missed Sunday as the trigger. It could not self-heal, and nothing external ever checked whether it had.

The general lesson: *never gate the thing that advances state on the state being current.* v2 derives the current round from `Date.now()` against the calendar on every run. There is no stored pointer, so there is nothing to get stuck.

### 2 · Two sources of truth

On 23 May, `<script src="state.js"></script>` in `index.html` was replaced with a 182-line inlined copy of the same data, so the file could be exported as a self-contained artifact.

After that: six tasks wrote `state.js`. Only `mobile.html` read it. The desktop dashboard — the one actually used — read its own private frozen copy and was architecturally incapable of ever updating.

The change was never committed, so the local file and the deployed file were *two different* stale versions.

The lesson: a "make it self-contained" convenience can silently sever a data pipeline. v2 makes the separation a stated contract at the top of `app.js`.

### 3 · Everything was a scrape of a personal browser

League standings came from a DOM scrape (`[class*="row"]`, filtered by text length) against an authenticated session in a personal Chrome profile. Expected-points data scraped a third-party site. Betting odds scraped Polymarket.

This meant the pipeline required a specific laptop to be awake, with Chrome open and a login unexpired. It could never run on a server — which quietly capped the project's ceiling regardless of the other bugs.

v2 uses public, keyless, server-callable APIs for everything automatable, and a manual entry screen for the one thing that isn't.

### 4 · Race identity hardcoded in the view

`index.html` hardcoded `🇺🇸 Miami GP · Round 6 · Sprint Weekend` in static markup, along with Miami-specific action cards, a Miami weather link, and a Polymarket URL for a race that resolved on 3 May.

Even a perfectly updated `state.js` would have left the page saying Miami. And it did: on 22 July the live site showed Miami Round 6 while `state.js` said Canada Round 7.

(Both were wrong. The real calendar had Canada at Round 5 — the round numbering had drifted too, because it was typed by hand rather than read from a source.)

### 5 · The validator measured the wrong thing

After the 3 May schema incident, a pre-commit validator was added. It checked structure: 13 required keys, `lineup ≥ 7`, `rivals ≥ 7`, file length 130–400 lines.

It was structural, not semantic. **A file frozen since May passed it perfectly.** It could not express "this data is about a race that happened two months ago."

It also froze the schema — encoding "8 teams, 7 lineup slots" as a permanent constraint, so legitimate evolution required disabling the safety net.

v2 checks freshness, in the UI, against the derived current round — the property that actually mattered.

---

## What went right

Worth recording, because it shaped v2 too:

- **Data/presentation separation was the correct design.** It was violated, not wrong. v2 keeps it and states it as a contract.
- **The pre-commit validator caught a real class of bug.** The idea was sound; the predicate was too narrow.
- **Version control as the audit trail** made this investigation possible. Commit dates versus file mtimes are what proved the tasks were no-op'ing rather than failing.

---

## Design rules carried into v2

1. **Derive, don't store, "now."** Current round comes from the clock every run.
2. **One source of truth, enforced by contract.** The render layer never contains data.
3. **Silence is a bug.** Failed runs exit non-zero; the UI shows its own staleness banner.
4. **Isolate renderers.** One section's exception cannot blank the page.
5. **Prefer public APIs over scrapes**; where impossible, prefer explicit manual entry over a fragile automation that pretends to work.
6. **Label provenance in the product.** Every number states whether it is automated or hand-entered and when it last changed.

---

## The meta-lesson

Every individual piece of v1 was defensible. The scheduled tasks were well-written. The validator was a genuine response to a real incident. Inlining state made the artifact portable.

The failure was in the *seams* — a guard clause in one task that made another task unreachable, a portability fix that severed a data path, a safety check that measured structure while the actual risk was staleness.

None of these were visible from inside any single component. They were only visible by asking: *what does the system do when a step is skipped?*

v1's answer was "nothing, forever, quietly." v2's is "notice, and say so."
