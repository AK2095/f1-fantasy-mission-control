#!/usr/bin/env node
/**
 * F1 Mission Control · data pipeline
 * ---------------------------------
 * Fetches every automatable data source and writes plain JSON into /data.
 * Runs in GitHub Actions on a schedule; commits the result. Vercel redeploys.
 *
 * DESIGN RULE #1 — no stored pointer to "current round".
 *   v1 died because the only task that could advance the round was gated on
 *   the round already being current. Here, the current round is DERIVED from
 *   today's date against the calendar, every single run. It cannot deadlock.
 *
 * DESIGN RULE #2 — never write a partial file.
 *   Each source writes its own file. One source failing leaves the others
 *   intact and is recorded in meta.json so the UI can show what went stale.
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
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
 * Derive season position from the clock alone — the anti-deadlock rule.
 * "next" = first race whose start is still in the future.
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

  // Scenario model inputs — the thing that was hardcoded to zeros in v1.
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
 * `f1` tag and pick the ones belonging to the upcoming round, matched on the
 * race date in the slug — so this follows the calendar automatically instead of
 * pointing at a hardcoded event the way v1 did (its URL was pinned to a Miami
 * market that had already resolved).
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
 * Because this is a scrape of a rendered page rather than a contract, it is the
 * most fragile source here. It fails soft: markets/weather/results are
 * unaffected, and meta.json records the failure so the UI can say so.
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

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`F1 Mission Control · data build · ${now.toISOString()}`);

  const races = await buildCalendar();
  const position = derivePosition(races);
  console.log(
    `  → last completed: R${position.lastCompletedRound} · ` +
      `next: R${position.nextRound ?? '—'} ${position.next?.shortName ?? 'season over'}`
  );

  const NAMES = ['standings', 'results', 'weather', 'markets', 'assets'];
  const settled = await Promise.allSettled([
    buildStandings(),
    buildResults(position),
    buildWeather(position),
    buildMarkets(position),
    buildAssets(),
  ]);
  settled.forEach((s, i) => {
    if (s.status === 'rejected') {
      const name = NAMES[i];
      sources[name] = { ok: false, fetchedAt: now.toISOString(), error: String(s.reason.message) };
      errors.push(`${name}: ${s.reason.message}`);
    }
  });

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
    // Partial data is written and recorded, but the run is marked failed so
    // GitHub emails us. Silence was v1's fatal flaw.
    process.exitCode = 1;
  } else {
    console.log('\n✓ all sources ok');
  }
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
