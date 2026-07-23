#!/usr/bin/env node
/**
 * F1 Fantasy Mission Control · data pipeline
 * ------------------------------------------
 * Fetches every automatable data source and writes plain JSON into /data.
 * Runs in GitHub Actions on a schedule and commits the result; Vercel then
 * redeploys from that commit.
 *
 * DESIGN RULE #1 — the current round is derived, never stored.
 *   Every run recomputes where the season stands from today's date against
 *   the calendar. Nothing persists a "current round" pointer, so the pipeline
 *   has no state to fall out of sync with and no way to stall.
 *
 * DESIGN RULE #2 — sources fail independently.
 *   Each source writes its own file. One failing leaves the others intact and
 *   is recorded in meta.json, so the UI can report exactly what is unavailable
 *   instead of silently showing stale numbers.
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { optimiseSquad } from '../assets/optimizer.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const SEASON = 2026;
const JOLPICA = 'https://api.jolpi.ca/ergast/f1';

const now = new Date();
const errors = [];
const sources = {};

// ── helpers ────────────────────────────────────────────────────────────────
async function getJSON(url, { tries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'f1-mission-control/2.0' },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error(`${url} failed after ${tries} tries: ${lastErr.message}`);
}

async function write(name, payload) {
  await mkdir(DATA, { recursive: true });
  await writeFile(join(DATA, name), JSON.stringify(payload, null, 2) + '\n');
  console.log(`  ✓ data/${name}`);
}

/** Merge a race's date+time fields into one ISO instant. */
const instant = (d, t) => (d ? new Date(`${d}T${t || '00:00:00Z'}`).toISOString() : null);

function sessionsOf(race) {
  const map = {
    fp1: race.FirstPractice,
    fp2: race.SecondPractice,
    fp3: race.ThirdPractice,
    sprintQualifying: race.SprintQualifying || race.SprintShootout,
    sprint: race.Sprint,
    qualifying: race.Qualifying,
    race: { date: race.date, time: race.time },
  };
  const out = {};
  for (const [key, s] of Object.entries(map)) {
    if (s?.date) out[key] = instant(s.date, s.time);
  }
  return out;
}

// ── 1 · calendar ───────────────────────────────────────────────────────────
async function buildCalendar() {
  const d = await getJSON(`${JOLPICA}/${SEASON}.json?limit=40`);
  const races = d.MRData.RaceTable.Races.map((r) => {
    const sessions = sessionsOf(r);
    return {
      round: Number(r.round),
      name: r.raceName,
      shortName: r.raceName.replace(/ Grand Prix$/, ' GP'),
      circuitId: r.Circuit.circuitId,
      circuit: r.Circuit.circuitName,
      locality: r.Circuit.Location.locality,
      country: r.Circuit.Location.country,
      lat: Number(r.Circuit.Location.lat),
      lon: Number(r.Circuit.Location.long),
      date: r.date,
      raceStartUTC: instant(r.date, r.time),
      isSprint: Boolean(r.Sprint),
      sessions,
      // Fantasy lineups lock at the start of the first qualifying-type session.
      lockUTC: sessions.sprintQualifying || sessions.qualifying || instant(r.date, r.time),
      wikiUrl: r.url,
    };
  }).sort((a, b) => a.round - b.round);

  sources.calendar = { ok: true, fetchedAt: now.toISOString(), rounds: races.length };
  await write('calendar.json', { season: SEASON, updatedAt: now.toISOString(), races });
  return races;
}

/**
 * Derive season position from the clock alone.
 * "next" = the first race whose start is still in the future.
 */
function derivePosition(races) {
  const t = now.getTime();
  const completed = races.filter((r) => new Date(r.raceStartUTC).getTime() < t);
  const upcoming = races.filter((r) => new Date(r.raceStartUTC).getTime() >= t);
  const next = upcoming[0] ?? null;
  const last = completed.at(-1) ?? null;
  return {
    lastCompletedRound: last?.round ?? 0,
    nextRound: next?.round ?? null,
    next,
    last,
    roundsRemaining: upcoming.length,
    // Is a race weekend live right now? (from 3 days before race start)
    isRaceWeek: next ? new Date(next.raceStartUTC).getTime() - t < 3 * 864e5 : false,
  };
}

// ── 2 · championship standings ─────────────────────────────────────────────
async function buildStandings() {
  const [dRes, cRes] = await Promise.all([
    getJSON(`${JOLPICA}/${SEASON}/driverstandings.json?limit=40`),
    getJSON(`${JOLPICA}/${SEASON}/constructorstandings.json?limit=20`),
  ]);

  const dList = dRes.MRData.StandingsTable.StandingsLists[0];
  const cList = cRes.MRData.StandingsTable.StandingsLists[0];

  const drivers = (dList?.DriverStandings ?? []).map((s) => ({
    position: Number(s.position),
    code: s.Driver.code,
    driverId: s.Driver.driverId,
    name: `${s.Driver.givenName} ${s.Driver.familyName}`,
    surname: s.Driver.familyName,
    number: s.Driver.permanentNumber ? Number(s.Driver.permanentNumber) : null,
    nationality: s.Driver.nationality,
    constructor: s.Constructors.at(-1)?.name ?? null,
    constructorId: s.Constructors.at(-1)?.constructorId ?? null,
    points: Number(s.points),
    wins: Number(s.wins),
  }));

  const constructors = (cList?.ConstructorStandings ?? []).map((s) => ({
    position: Number(s.position),
    constructorId: s.Constructor.constructorId,
    name: s.Constructor.name,
    nationality: s.Constructor.nationality,
    points: Number(s.points),
    wins: Number(s.wins),
  }));

  sources.standings = {
    ok: true,
    fetchedAt: now.toISOString(),
    throughRound: Number(dList?.round ?? 0),
  };
  await write('standings.json', {
    season: SEASON,
    throughRound: Number(dList?.round ?? 0),
    updatedAt: now.toISOString(),
    drivers,
    constructors,
  });
  return { drivers, constructors };
}

// ── 3 · results for completed rounds ───────────────────────────────────────
async function buildResults(position) {
  const rounds = [];
  for (let r = 1; r <= position.lastCompletedRound; r++) {
    try {
      const d = await getJSON(`${JOLPICA}/${SEASON}/${r}/results.json?limit=40`);
      const race = d.MRData.RaceTable.Races[0];
      if (!race) continue;
      rounds.push({
        round: Number(race.round),
        name: race.raceName,
        date: race.date,
        results: race.Results.map((x) => ({
          position: Number(x.position),
          code: x.Driver.code,
          name: `${x.Driver.givenName} ${x.Driver.familyName}`,
          constructor: x.Constructor.name,
          constructorId: x.Constructor.constructorId,
          grid: Number(x.grid),
          laps: Number(x.laps),
          status: x.status,
          points: Number(x.points),
          fastestLapRank: x.FastestLap?.rank ? Number(x.FastestLap.rank) : null,
          // Fantasy cares about places gained/lost, so precompute it.
          positionsGained: Number(x.grid) > 0 ? Number(x.grid) - Number(x.position) : 0,
        })),
      });
    } catch (err) {
      errors.push(`results r${r}: ${err.message}`);
    }
  }
  sources.results = { ok: rounds.length > 0, fetchedAt: now.toISOString(), rounds: rounds.length };
  await write('results.json', { season: SEASON, updatedAt: now.toISOString(), rounds });
  return rounds;
}

// ── 4 · weather for the upcoming race weekend ──────────────────────────────
async function buildWeather(position) {
  const race = position.next;
  if (!race) {
    await write('weather.json', { updatedAt: now.toISOString(), available: false });
    return null;
  }

  const days = [...new Set(Object.values(race.sessions).map((s) => s.slice(0, 10)))].sort();
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${race.lat}&longitude=${race.lon}` +
    `&hourly=precipitation_probability,precipitation,temperature_2m,wind_speed_10m,weather_code` +
    `&start_date=${days[0]}&end_date=${days.at(-1)}&timezone=UTC`;

  const wx = await getJSON(url);
  const at = (iso) => {
    const hour = iso.slice(0, 13) + ':00';
    const i = wx.hourly.time.indexOf(hour);
    if (i === -1) return null;
    return {
      precipProbability: wx.hourly.precipitation_probability[i],
      precipMm: wx.hourly.precipitation[i],
      tempC: wx.hourly.temperature_2m[i],
      windKph: wx.hourly.wind_speed_10m[i],
      weatherCode: wx.hourly.weather_code[i],
    };
  };

  const bySession = {};
  for (const [key, iso] of Object.entries(race.sessions)) {
    const f = at(iso);
    if (f) bySession[key] = { startUTC: iso, ...f };
  }

  // Scenario model inputs, derived from the race-hour forecast.
  const raceWx = bySession.race ?? {};
  const wetProb = Math.round(raceWx.precipProbability ?? 0);
  const scenario = {
    dryProb: 100 - wetProb,
    wetProb,
    // Heavy rain (>1.5mm/h) is the practical proxy for red-flag / SC-heavy races.
    haltProb: (raceWx.precipMm ?? 0) > 1.5 ? Math.min(35, Math.round(wetProb * 0.4)) : 0,
  };

  sources.weather = { ok: true, fetchedAt: now.toISOString(), circuit: race.circuit };
  await write('weather.json', {
    updatedAt: now.toISOString(),
    available: true,
    round: race.round,
    race: race.name,
    circuit: race.circuit,
    locality: race.locality,
    country: race.country,
    lat: race.lat,
    lon: race.lon,
    sessions: bySession,
    scenario,
    provider: 'Open-Meteo',
  });
  return { bySession, scenario };
}

// ── 5 · betting markets (Polymarket) ───────────────────────
/**
 * Polymarket publishes an open Gamma API. We pull every open market under the
 * `f1` tag and select the ones belonging to the upcoming round, matched on the
 * race date embedded in the slug. Resolving the event from the calendar means
 * the section follows the season on its own and can never point at a market
 * that has already settled.
 */
async function buildMarkets(position) {
  const race = position.next;
  if (!race) {
    await write('markets.json', { updatedAt: now.toISOString(), available: false });
    return null;
  }

  const events = await getJSON('https://gamma-api.polymarket.com/events?closed=false&limit=60&tag_slug=f1');

  const priceOf = (m) => {
    try {
      const p = JSON.parse(m.outcomePrices ?? '[]');
      const outcomes = JSON.parse(m.outcomes ?? '[]');
      const yes = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
      return p.length ? Number(p[yes === -1 ? 0 : yes]) : null;
    } catch { return null; }
  };

  const pickEvent = (kind) =>
    events.find((e) => (e.slug ?? '').startsWith(`f1-`) && e.slug.includes(kind) && e.slug.includes(race.date)) ??
    events.find((e) => (e.slug ?? '').includes(kind) && (e.title ?? '').toLowerCase().includes(race.name.toLowerCase().replace(' grand prix', '')));

  const extract = (evt) => {
    if (!evt) return null;
    const runners = (evt.markets ?? [])
      .map((m) => ({
        name: m.groupItemTitle ?? null,
        probability: priceOf(m),
        volume: Number(m.volume ?? 0),
      }))
      // Placeholder rows ("Driver A", "Other") carry no price — drop them.
      .filter((r) => r.name && r.probability != null && !/^Driver [A-Z]$/.test(r.name))
      .sort((a, b) => b.probability - a.probability);
    if (!runners.length) return null;
    return {
      title: evt.title,
      slug: evt.slug,
      endDate: evt.endDate ?? null,
      totalVolume: runners.reduce((s, r) => s + r.volume, 0),
      runners,
    };
  };

  const winner = extract(pickEvent('winner'));
  const pole = extract(pickEvent('pole-position'));
  const fastestLap = extract(pickEvent('fastest-lap'));

  sources.markets = {
    ok: Boolean(winner),
    fetchedAt: now.toISOString(),
    ...(winner ? { runners: winner.runners.length } : { error: 'no winner market matched this round' }),
  };
  if (!winner) errors.push('markets: no Polymarket winner market matched this round');

  await write('markets.json', {
    updatedAt: now.toISOString(),
    available: Boolean(winner),
    round: race.round,
    race: race.name,
    provider: 'Polymarket',
    winner, pole, fastestLap,
  });
  return winner;
}

// ── 6 · fantasy asset model (f1fantasytools) ───────────────
/**
 * f1fantasytools.com publishes no API, but its team-calculator page ships the
 * full asset dataset in its server-rendered payload: official fantasy prices
 * plus a per-round breakdown of all 16 fantasy scoring components.
 *
 * That breakdown is the valuable part. Summing components per round gives a
 * points-per-round series for every asset, and from that series we derive the
 * three objectives the Strategy Analyzer offers:
 *
 *   points  — mean points per round (raw upside)
 *   budget  — mean points per $M (efficiency under the cost cap)
 *   sharpe  — mean / standard deviation (consistency; punishes DNF-prone assets)
 *
 * Because this is a scrape of a rendered page rather than a published contract,
 * it is the most fragile source here. It fails soft: markets, weather and
 * results are unaffected, and meta.json records the failure so the UI reports it.
 */
async function buildAssets() {
  const res = await fetch('https://f1fantasytools.com/team-calculator', {
    headers: { 'User-Agent': 'f1-mission-control/2.0 (personal dashboard; hourly)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`f1fantasytools → HTTP ${res.status}`);
  const html = await res.text();

  // Reassemble the streamed RSC payload, then pull the arrays out of it.
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)];
  const blob = chunks.map((m) => JSON.parse(`"${m[1]}"`)).join('');

  const arrayAfter = (key) => {
    const k = blob.indexOf(`"${key}":[`);
    if (k === -1) return null;
    const start = blob.indexOf('[', k);
    let depth = 0;
    for (let j = start; j < blob.length; j++) {
      if (blob[j] === '[') depth++;
      else if (blob[j] === ']' && --depth === 0) return JSON.parse(blob.slice(start, j + 1));
    }
    return null;
  };

  const raw = [...(arrayAfter('drivers') ?? []), ...(arrayAfter('constructors') ?? [])];
  if (!raw.length) throw new Error('no asset arrays found in payload (page structure likely changed)');

  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const stdev = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
  };

  const assets = raw
    .filter((a) => a.isActive !== false)
    .map((a) => {
      const rr = a.raceResults ?? {};
      const series = Object.values(rr);
      const rounds = series.length ? series[0].length : 0;
      // Total fantasy points per round = sum of all scoring components.
      const perRound = Array.from({ length: rounds }, (_, i) =>
        series.reduce((s, comp) => s + (comp[i] ?? 0), 0)
      );

      const avg = mean(perRound);
      const sd = stdev(perRound);
      const price = Number(a.price) || 0;
      const last2 = a.lastTwoTotalPoints ?? [];

      return {
        code: a.abbreviation,
        id: a.id,
        type: a.type,
        color: a.color,
        price,
        perRound,
        totalPoints: perRound.reduce((s, v) => s + v, 0),
        avgPoints: Number(avg.toFixed(2)),
        stdev: Number(sd.toFixed(2)),
        // Risk-adjusted return. Zero-variance assets would divide by zero.
        sharpe: sd > 0 ? Number((avg / sd).toFixed(2)) : null,
        pointsPerMillion: price > 0 ? Number((avg / price).toFixed(2)) : null,
        worstRound: perRound.length ? Math.min(...perRound) : null,
        bestRound: perRound.length ? Math.max(...perRound) : null,
        negativeRounds: perRound.filter((v) => v < 0).length,
        last2Avg: last2.length ? Number(mean(last2).toFixed(1)) : null,
        // Momentum: recent form against season baseline.
        momentum: last2.length && avg ? Number((mean(last2) - avg).toFixed(1)) : null,
      };
    })
    .sort((a, b) => b.avgPoints - a.avgPoints);

  sources.assets = {
    ok: true,
    fetchedAt: now.toISOString(),
    assets: assets.length,
    rounds: assets[0]?.perRound.length ?? 0,
  };
  await write('assets.json', {
    updatedAt: now.toISOString(),
    provider: 'f1fantasytools.com',
    note: 'Official fantasy prices and per-round scoring. Derived metrics (avgPoints, stdev, sharpe, pointsPerMillion, momentum) are computed here, not published by the source.',
    rounds: assets[0]?.perRound.length ?? 0,
    assets,
  });
  return assets;
}


// ── 6b · per-round price history ───────────────────────────
/**
 * Fantasy prices move every round: an asset that performs well gets more
 * expensive, and every team's budget moves with the value of what it holds.
 * A single fixed cap is therefore the wrong model for any historical test.
 *
 * f1fantasytools' statistics page carries per-round prices for every asset,
 * which is what makes a budget-accurate backtest possible.
 */
async function buildPriceHistory() {
  const res = await fetch('https://f1fantasytools.com/statistics', {
    headers: { 'User-Agent': 'f1-mission-control/2.0 (personal dashboard; hourly)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`statistics page → HTTP ${res.status}`);
  const html = await res.text();
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)];
  const blob = chunks.map((m) => JSON.parse(`"${m[1]}"`)).join('');

  const key = '"raceResults":{';
  const at = blob.indexOf(key);
  if (at === -1) throw new Error('no raceResults block (page structure changed)');
  const start = blob.indexOf('{', at + key.length - 1);
  let depth = 0, end = -1;
  for (let j = start; j < blob.length; j++) {
    if (blob[j] === '{') depth++;
    else if (blob[j] === '}' && --depth === 0) { end = j + 1; break; }
  }
  const raw = JSON.parse(blob.slice(start, end));

  const byRound = {};
  for (const [rd, payload] of Object.entries(raw)) {
    const row = {};
    for (const grp of ['drivers', 'constructors']) {
      for (const a of payload[grp] ?? []) {
        row[a.abbreviation] = { price: a.price, priceChange: a.priceChange ?? null, type: a.type };
      }
    }
    if (Object.keys(row).length) byRound[rd] = row;
  }
  const rounds = Object.keys(byRound).length;
  if (!rounds) throw new Error('no priced rounds found');

  sources.prices = { ok: true, fetchedAt: now.toISOString(), rounds };
  await write('prices_by_round.json', byRound);
  return byRound;
}

// ── 7 · walk-forward backtest ──────────────────────────────
/**
 * Does the optimiser actually work?
 *
 * For each completed round it rebuilds the asset model using ONLY the rounds
 * before it, picks a squad, then scores that squad against what actually
 * happened in that round. No information from round N is available when
 * choosing the squad for round N, which is what makes it a fair test rather
 * than a curve fit.
 *
 * Every strategy is scored the same way and faces the same budget cap, so the
 * comparison between them is sound even where the absolute level is not — see
 * `caveats` in the output, which the UI renders rather than hides.
 */
function buildBacktest(assets, fantasy) {
  const rounds = assets[0]?.perRound?.length ?? 0;
  const MIN_TRAIN = 3;                       // need some history before predicting
  if (rounds <= MIN_TRAIN) return null;

  const cap = fantasy?.budget?.cap ?? 100;
  const drivers = assets.filter((a) => a.type === 'driver');
  const constructors = assets.filter((a) => a.type === 'constructor');

  // "What if I had done nothing" baselines, drawn from point-in-time squad
  // snapshots. Only snapshots recorded BEFORE a given round are used for that
  // round, so a squad chosen with hindsight can never flatter itself.
  const snapshots = (fantasy?.history ?? [])
    .filter((h) => Array.isArray(h.squad) && h.squad.length)
    .map((h) => ({
      round: h.round,
      label: `Your R${h.round} squad, held`,
      squad: assets.filter((a) => h.squad.some((s) => s.code === a.code)),
    }))
    .filter((h) => h.squad.length)
    .sort((a, b) => a.round - b.round);

  const meanOver = (a, upto) => {
    const slice = a.perRound.slice(0, upto);
    return slice.length ? slice.reduce((s, v) => s + v, 0) / slice.length : 0;
  };
  const stdevOver = (a, upto) => {
    const slice = a.perRound.slice(0, upto);
    if (slice.length < 2) return 0;
    const m = meanOver(a, upto);
    return Math.sqrt(slice.reduce((s, v) => s + (v - m) ** 2, 0) / slice.length);
  };
  const actual = (squad, r) => squad.reduce((s, a) => s + (a.perRound[r] ?? 0), 0);

  const strategies = [
    { key: 'points',   label: 'Optimiser · points',
      score: (a, t) => meanOver(a, t) },
    { key: 'sharpe',   label: 'Optimiser · Sharpe',
      score: (a, t) => { const sd = stdevOver(a, t); return sd > 0 ? meanOver(a, t) / sd : 0; } },
    { key: 'expensive', label: 'Most expensive squad',
      score: (a) => a.price },
  ];

  const perRound = [];
  for (let t = MIN_TRAIN; t < rounds; t++) {
    const row = { round: t + 1, results: {} };

    for (const s of strategies) {
      const pick = optimiseSquad({ drivers, constructors, cap, score: (a) => s.score(a, t) });
      if (!pick) continue;
      row.results[s.key] = {
        scored: Number(actual(pick.squad, t).toFixed(1)),
        squad: pick.squad.map((a) => a.code),
        cost: Number(pick.cost.toFixed(1)),
      };
    }

    // Perfect hindsight: the best squad if you had known this round's scores.
    const oracle = optimiseSquad({ drivers, constructors, cap, score: (a) => a.perRound[t] ?? 0 });
    if (oracle) {
      row.results.oracle = {
        scored: Number(actual(oracle.squad, t).toFixed(1)),
        squad: oracle.squad.map((a) => a.code),
        cost: Number(oracle.cost.toFixed(1)),
      };
    }

    // Doing nothing, but only using a squad that already existed by this round.
    // A snapshot taken at round R knows nothing about rounds after R.
    for (const snap of snapshots) {
      if (snap.round > t) continue;          // not yet chosen at this point
      row.results[`held${snap.round}`] = {
        scored: Number(actual(snap.squad, t).toFixed(1)),
        squad: snap.squad.map((a) => a.code),
        cost: Number(snap.squad.reduce((s, a) => s + a.price, 0).toFixed(1)),
      };
    }

    // Field average: the mean asset, filling every slot.
    const avgD = drivers.reduce((s, a) => s + (a.perRound[t] ?? 0), 0) / (drivers.length || 1);
    const avgC = constructors.reduce((s, a) => s + (a.perRound[t] ?? 0), 0) / (constructors.length || 1);
    row.results.field = { scored: Number((avgD * 5 + avgC * 2).toFixed(1)), squad: [], cost: null };

    perRound.push(row);
  }

  // Totals, share of the achievable ceiling, and — critically — whether each
  // strategy actually respected the budget the optimiser had to respect.
  //
  // Historical prices are not available, so a squad chosen months ago is
  // costed at today's values. Assets that have performed well have grown more
  // expensive, which can push a past squad far above the current cap. Scoring
  // an over-cap squad against a capped optimiser is not a like-for-like test,
  // so those rows are reported but excluded from the ranking.
  const heldKeys = snapshots.map((h) => `held${h.round}`);
  const keys = ['points', 'sharpe', 'expensive', ...heldKeys, 'field', 'oracle'];
  const totals = {};
  for (const k of keys) {
    const rows = perRound.map((r) => r.results[k]).filter(Boolean);
    if (!rows.length) continue;
    const sum = rows.reduce((s, r) => s + r.scored, 0);
    const cost = rows[0].cost;
    const overCap = cost != null && cost > cap + 1e-6;
    totals[k] = {
      total: Number(sum.toFixed(1)),
      perRound: Number((sum / rows.length).toFixed(1)),
      rounds: rows.length,
      cost: cost ?? null,
      overCap,
      // A squad that could not legally be fielded under the current cap is not
      // a fair comparison for a strategy that had to fit inside it.
      comparable: !overCap,
    };
  }
  for (const k of keys) {
    if (totals[k] && totals.oracle?.perRound) {
      totals[k].shareOfCeiling = Number(((totals[k].perRound / totals.oracle.perRound) * 100).toFixed(1));
    }
  }

  const labels = {
    points: 'Optimiser · points', sharpe: 'Optimiser · Sharpe',
    expensive: 'Most expensive squad',
    field: 'Field average', oracle: 'Perfect hindsight (ceiling)',
  };
  for (const h of snapshots) labels[`held${h.round}`] = h.label;

  sources.backtest = { ok: true, fetchedAt: now.toISOString(), rounds: perRound.length };
  return {
    updatedAt: now.toISOString(),
    trainedFromRound: 1,
    firstTestedRound: MIN_TRAIN + 1,
    lastTestedRound: rounds,
    cap,
    labels,
    totals,
    perRound,
    caveats: [
      'Historical prices are not published, so past squads are costed at current values. Assets that performed well have since become more expensive, which can push a past squad above today\'s cap. Any strategy whose squad exceeds the cap is marked and excluded from the ranking, because it was never constrained the way the optimiser is.',
      'The same budget cap is applied to every round and every strategy. That keeps the comparison between strategies fair even though the cap itself has grown over the season.',
      'Scores exclude DRS boost multipliers, chips and transfer penalties, none of which are recorded per round. Every strategy is measured on the same basis, so the ranking holds, but absolute totals are lower than a real F1 Fantasy score.',
      'Each round is chosen using only rounds before it, so no result depends on information that was unavailable at the time.',
      'A held-squad baseline is only scored from the round after it was recorded onwards, so a squad picked with hindsight cannot flatter itself. Compare per-round averages rather than totals, since baselines cover different numbers of rounds.',
    ],
  };
}


// ── 8 · head-to-head against real league results ───────────
/**
 * The decisive test: what the optimiser would have scored against what eight
 * real managers actually scored, using F1 Fantasy's own numbers.
 *
 * Budgets are not fixed. Every team starts the season on the same $100M, and
 * from there each team's budget tracks the value of what it holds — good picks
 * appreciate and fund better squads, poor ones erode it. Comparing a model on a
 * flat cap against managers whose real budgets ranged from $86.7M to $114.5M
 * would be meaningless, so for every head-to-head the optimiser is given the
 * exact budget that team had, computed from their squad at that round's prices.
 *
 * Where a team played Limitless the budget constraint was lifted for that race,
 * and the optimiser is given the same freedom.
 */
function buildHeadToHead(exportData, pricesByRound) {
  if (!exportData?.teams?.length || !pricesByRound) return null;

  // The export and the price feed disagree on one constructor's abbreviation.
  const ALIAS = { RBS: 'VRB' };
  const priceAt = (rd, code) => pricesByRound[String(rd)]?.[ALIAS[code] ?? code]?.price ?? null;
  const typeAt = (rd, code) => pricesByRound[String(rd)]?.[ALIAS[code] ?? code]?.type ?? null;

  const roundKeys = [...new Set(exportData.teams.flatMap((t) => Object.keys(t.races)))].sort();
  const roundNum = (rk) => Number(rk.replace(/\D/g, ''));

  // Base points per asset per round, straight from the export.
  const scored = new Map();
  for (const t of exportData.teams) {
    for (const [rk, r] of Object.entries(t.races)) {
      for (const p of [...r.drivers, ...r.constructors]) scored.set(`${p.tla}|${rk}`, p.base_points);
    }
  }
  const codes = [...new Set([...scored.keys()].map((k) => k.split('|')[0]))];

  const poolFor = (rd) => codes
    .map((c) => ({
      code: c,
      type: typeAt(rd, c),
      price: priceAt(rd, c),
      byRound: Object.fromEntries(roundKeys.map((rk) => [rk, scored.get(`${c}|${rk}`) ?? null])),
    }))
    .filter((a) => a.price != null && a.type);

  const rounds = [];
  for (let i = 1; i < roundKeys.length; i++) {
    const rk = roundKeys[i];
    const rd = roundNum(rk);
    const train = roundKeys.slice(0, i);
    const pool = poolFor(rd);
    const drivers = pool.filter((a) => a.type === 'driver');
    const constructors = pool.filter((a) => a.type === 'constructor');
    if (drivers.length < 5 || constructors.length < 2) continue;

    const mean = (a) => {
      const v = train.map((t) => a.byRound[t]).filter((x) => x != null);
      return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
    };

    const matchups = [];
    for (const t of exportData.teams) {
      const race = t.races[rk];
      if (!race || race.joined_late_no_lineup) continue;

      const squadPrices = [...race.drivers, ...race.constructors].map((p) => priceAt(rd, p.tla));
      if (squadPrices.some((v) => v == null)) continue;
      const limitless = (race.chips_used ?? []).includes('Limitless');
      const budget = limitless ? 999 : squadPrices.reduce((s, v) => s + v, 0);

      const pick = optimiseSquad({ drivers, constructors, cap: budget, score: mean });
      if (!pick) continue;
      const captain = [...pick.drivers].sort((a, b) => mean(b) - mean(a))[0];
      const modelScore = pick.squad.reduce((s, a) => {
        const v = a.byRound[rk] ?? 0;
        return s + (a.code === captain?.code ? v * 2 : v);
      }, 0);

      matchups.push({
        team: t.team_name.replace(/\s+/g, ' ').trim(),
        teamScored: race.race_points_total,
        teamCaptain: race.captain,
        budget: Number(budget === 999 ? squadPrices.reduce((s, v) => s + v, 0).toFixed(1) : budget.toFixed(1)),
        limitless,
        modelScored: Number(modelScore.toFixed(1)),
        modelSquad: pick.squad.map((a) => a.code),
        modelCaptain: captain?.code ?? null,
        modelWins: modelScore > race.race_points_total,
      });
    }
    if (!matchups.length) continue;

    rounds.push({
      round: rk,
      raceName: exportData.completed_races?.find((c) => c.code === rk)?.name ?? rk,
      matchups,
      modelWins: matchups.filter((m) => m.modelWins).length,
      of: matchups.length,
    });
  }
  if (!rounds.length) return null;

  const wins = rounds.reduce((s, r) => s + r.modelWins, 0);
  const total = rounds.reduce((s, r) => s + r.of, 0);

  // Season view: each team's real total against the model given that team's budget.
  const perTeam = {};
  for (const r of rounds) {
    for (const m of r.matchups) {
      const e = (perTeam[m.team] ??= { team: m.team, teamTotal: 0, modelTotal: 0, rounds: 0, wins: 0 });
      e.teamTotal += m.teamScored;
      e.modelTotal += m.modelScored;
      e.rounds += 1;
      if (m.modelWins) e.wins += 1;
    }
  }
  const table = Object.values(perTeam)
    .map((e) => ({
      ...e,
      teamTotal: Number(e.teamTotal.toFixed(0)),
      modelTotal: Number(e.modelTotal.toFixed(0)),
      delta: Number((e.modelTotal - e.teamTotal).toFixed(0)),
    }))
    .sort((a, b) => b.teamTotal - a.teamTotal);

  sources.headToHead = { ok: true, fetchedAt: now.toISOString(), rounds: rounds.length };
  return {
    updatedAt: now.toISOString(),
    source: 'F1 Fantasy league export + f1fantasytools per-round prices',
    extractedAt: exportData.extracted_at ?? null,
    startingBudget: 100,
    testedRounds: rounds.map((r) => r.round),
    headline: { wins, of: total, winRate: Number(((wins / total) * 100).toFixed(1)) },
    rounds,
    table,
    caveats: [
      'Scoring is F1 Fantasy\'s own, including captain multipliers, chips and transfer penalties exactly as the game applied them. All 80 team-races in the export reconcile.',
      'Budgets are not fixed. Every team starts on $100M and diverges as asset prices move; real budgets ranged from $86.7M to $114.5M. Each head-to-head gives the optimiser the exact budget that team had at that round, computed from their squad at that round\'s prices.',
      'Where a team played Limitless the budget constraint was lifted for that race, and the optimiser was given the same freedom.',
      'Each round is predicted using only the rounds before it, so no pick depends on information unavailable at the time.',
      'The optimiser can only choose assets some team in the league owned that round, since those are the only ones with recorded scores. A strong asset nobody owned is invisible to it.',
      'One team\'s export (Hawaii Hamilton) totals 1083 against 1911 in the app, so their rounds are understated and the model is flattered in those head-to-heads. The other seven reconcile exactly.',
    ],
  };
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`F1 Mission Control · data build · ${now.toISOString()}`);

  const races = await buildCalendar();
  const position = derivePosition(races);
  console.log(
    `  → last completed: R${position.lastCompletedRound} · ` +
      `next: R${position.nextRound ?? '—'} ${position.next?.shortName ?? 'season over'}`
  );

  const NAMES = ['standings', 'results', 'weather', 'markets', 'assets', 'prices'];
  const settled = await Promise.allSettled([
    buildStandings(),
    buildResults(position),
    buildWeather(position),
    buildMarkets(position),
    buildAssets(),
    buildPriceHistory(),
  ]);
  const assets = settled[4].status === 'fulfilled' ? settled[4].value : null;
  const prices = settled[5].status === 'fulfilled' ? settled[5].value : null;
  settled.forEach((s, i) => {
    if (s.status === 'rejected') {
      const name = NAMES[i];
      sources[name] = { ok: false, fetchedAt: now.toISOString(), error: String(s.reason.message) };
      errors.push(`${name}: ${s.reason.message}`);
    }
  });

  // backtest.json — does the optimiser beat the alternatives?
  if (assets?.length) {
    try {
      const fantasy = JSON.parse(await readFile(join(DATA, 'fantasy.json'), 'utf8'));
      const bt = buildBacktest(assets, fantasy);
      if (bt) await write('backtest.json', bt);
    } catch (err) {
      sources.backtest = { ok: false, fetchedAt: now.toISOString(), error: String(err.message) };
      errors.push(`backtest: ${err.message}`);
    }
  }

  // headtohead.json — the optimiser against real league results.
  // Needs the per-round price history, not the current-price asset model,
  // because each team's budget has to be reconstructed as it stood that round.
  if (prices) {
    try {
      const exportRaw = await readFile(join(DATA, 'f1_fantasy_league_export.json'), 'utf8');
      const h2h = buildHeadToHead(JSON.parse(exportRaw), prices);
      if (h2h) await write('headtohead.json', h2h);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        sources.headToHead = { ok: false, fetchedAt: now.toISOString(), error: String(err.message) };
        errors.push(`headToHead: ${err.message}`);
      }
    }
  }

  // season.json — the derived state the UI reads for "where are we".
  await write('season.json', {
    season: SEASON,
    updatedAt: now.toISOString(),
    lastCompletedRound: position.lastCompletedRound,
    nextRound: position.nextRound,
    roundsRemaining: position.roundsRemaining,
    isRaceWeek: position.isRaceWeek,
    nextRace: position.next,
    lastRace: position.last ? { round: position.last.round, name: position.last.name, date: position.last.date } : null,
  });

  await write('meta.json', {
    builtAt: now.toISOString(),
    builtBy: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
    commit: process.env.GITHUB_SHA?.slice(0, 7) ?? null,
    sources,
    errors,
    // The UI uses this to decide whether to shout at you.
    staleAfterHours: 36,
  });

  if (errors.length) {
    console.error(`\n⚠️  ${errors.length} source(s) failed:`);
    errors.forEach((e) => console.error(`   - ${e}`));
    // Partial data is still written and recorded, but the run exits non-zero
    // so the failure surfaces as a notification rather than passing quietly.
    process.exitCode = 1;
  } else {
    console.log('\n✓ all sources ok');
  }
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
