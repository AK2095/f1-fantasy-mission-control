/* ============================================================
   F1 Fantasy Mission Control · application layer
   ------------------------------------------------------------
   Contract: this file holds NO data. It loads /data/*.json,
   derives, and renders. Values belong in /data, never here —
   that separation is what lets a scheduled job refresh the whole
   dashboard without touching a line of code.
   ============================================================ */

import { optimiseSquad, SQUAD } from './optimizer.mjs';

const DATA_FILES = ['season', 'calendar', 'standings', 'results', 'weather', 'markets',
                    'assets', 'fantasy', 'backtest', 'meta'];
const LS_KEY = 'f1mc.fantasy.override';
const HOUR = 36e5;

const TABS = [
  ['overview', 'Overview'],
  ['builder',  'Team Builder'],
  ['strategy', 'Strategy'],
  ['backtest', 'Track Record'],
  ['markets',  'Markets'],
  ['consider', 'Consider'],
  ['league',   'League'],
  ['season',   'Season'],
  ['about',    'About'],
];

const state = {
  data: {},
  errors: [],
  ui: { tab: 'overview', objective: 'points', market: 'winner', builder: 'points' },
  cache: {},
};

// ── utilities ──────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  return n;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const cls = (id) => `c-${(id || 'unknown').replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;

/** el() plus inline styles. Avoids chaining off append(), which returns undefined. */
const styled = (node, styles) => { Object.assign(node.style, styles); return node; };

const scrollWrap = (node) => {
  const box = el('div', 'table-scroll');
  box.append(node);
  return box;
};

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function relativeTime(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 6e4);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function countdownParts(targetISO) {
  const ms = new Date(targetISO).getTime() - Date.now();
  if (ms <= 0) return null;
  return {
    d: Math.floor(ms / 864e5), h: Math.floor((ms % 864e5) / 36e5),
    m: Math.floor((ms % 36e5) / 6e4), s: Math.floor((ms % 6e4) / 1000),
  };
}

function fmtCountdown(t) {
  if (!t) return 'LOCKED';
  const p = (n) => String(n).padStart(2, '0');
  return t.d > 0 ? `${t.d}d ${p(t.h)}h ${p(t.m)}m` : `${p(t.h)}h ${p(t.m)}m ${p(t.s)}s`;
}

const SESSION_LABELS = {
  fp1: 'Practice 1', fp2: 'Practice 2', fp3: 'Practice 3',
  sprintQualifying: 'Sprint Qualifying', sprint: 'Sprint',
  qualifying: 'Qualifying', race: 'Race',
};

function wxLabel(code, precipProb) {
  if (code == null) return '—';
  if (code >= 95) return 'Storm';
  if (code >= 80) return 'Showers';
  if (code >= 61) return 'Rain';
  if (code >= 51) return 'Drizzle';
  if (code >= 45) return 'Fog';
  if (code >= 3) return 'Overcast';
  if (code >= 1) return 'Part cloud';
  return precipProb > 40 ? 'Mixed' : 'Clear';
}

// ── load ───────────────────────────────────────────────────
async function loadAll() {
  const results = await Promise.allSettled(
    DATA_FILES.map(async (name) => {
      const res = await fetch(`data/${name}.json`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${name}.json → HTTP ${res.status}`);
      return [name, await res.json()];
    })
  );
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') state.data[r.value[0]] = r.value[1];
    else state.errors.push(`${DATA_FILES[i]}: ${r.reason.message}`);
  });

  try {
    const override = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (override?.updatedAt) state.data.fantasy = { ...state.data.fantasy, ...override, _local: true };
  } catch { /* ignore malformed local data */ }
}

// ── selectors ──────────────────────────────────────────────
const myCodes = () => new Set((state.data.fantasy?.lineup ?? []).map((l) => l.code));
const allAssets = () => state.data.assets?.assets ?? [];
const driversOnly = () => allAssets().filter((a) => a.type === 'driver');
const constructorsOnly = () => allAssets().filter((a) => a.type === 'constructor');

function constructorIndex() {
  if (state.cache.cidx) return state.cache.cidx;
  const map = new Map();
  for (const d of state.data.standings?.drivers ?? []) map.set(d.code, d.constructorId);
  for (const l of state.data.fantasy?.lineup ?? []) map.set(l.code, l.constructorId);
  const alias = {
    MER: 'mercedes', FER: 'ferrari', MCL: 'mclaren', RED: 'red_bull', VRB: 'rb',
    ALP: 'alpine', AST: 'aston_martin', WIL: 'williams', AUD: 'audi', HAA: 'haas', CAD: 'cadillac',
  };
  for (const a of allAssets()) {
    if (!map.has(a.code)) map.set(a.code, alias[String(a.id).split('_')[0]] ?? 'unknown');
  }
  state.cache.cidx = map;
  return map;
}

function driverForm(n = 3) {
  const rounds = state.data.results?.rounds ?? [];
  const acc = new Map();
  for (const rd of rounds.slice(-n)) {
    for (const r of rd.results) {
      const cur = acc.get(r.code) ?? {
        code: r.code, name: r.name, constructorId: r.constructorId,
        constructor: r.constructor, points: 0, gained: 0, dnf: 0, starts: 0,
      };
      cur.points += r.points; cur.gained += r.positionsGained; cur.starts += 1;
      if (!/^(Finished|\+\d+ Lap)/.test(r.status)) cur.dnf += 1;
      acc.set(r.code, cur);
    }
  }
  return [...acc.values()]
    .map((d) => ({ ...d, avgPoints: d.starts ? d.points / d.starts : 0 }))
    .sort((a, b) => b.avgPoints - a.avgPoints);
}

function leagueContext() {
  const f = state.data.fantasy;
  if (!f?.standings?.length) return null;
  const sorted = [...f.standings].sort((a, b) => a.rank - b.rank);
  const meIdx = sorted.findIndex((s) => s.isMe);
  if (meIdx === -1) return null;
  const me = sorted[meIdx];
  return {
    me, sorted, total: sorted.length,
    above: meIdx > 0 ? sorted[meIdx - 1] : null,
    below: meIdx < sorted.length - 1 ? sorted[meIdx + 1] : null,
    gapAbove: meIdx > 0 ? sorted[meIdx - 1].points - me.points : null,
    gapBelow: meIdx < sorted.length - 1 ? me.points - sorted[meIdx + 1].points : null,
  };
}

const OBJECTIVES = {
  points: {
    label: 'Points', key: 'avgPoints', unit: 'pts/race',
    blurb: 'Ranked by mean fantasy points per round. Ignores both price and consistency — the ceiling-chasing view, correct when you are behind and need variance.',
    fmt: (a) => a.avgPoints?.toFixed(1) ?? '—',
  },
  budget: {
    label: 'Budget', key: 'pointsPerMillion', unit: 'pts per $M',
    blurb: 'Ranked by mean points per $M of price. The efficiency view — it surfaces the budget enablers that free up cap space for a premium pick elsewhere.',
    fmt: (a) => a.pointsPerMillion?.toFixed(2) ?? '—',
  },
  sharpe: {
    label: 'Sharpe', key: 'sharpe', unit: 'mean ÷ σ',
    blurb: 'Ranked by mean points divided by standard deviation — reward per unit of risk. Punishes assets whose average rests on one big weekend and favours those that deliver reliably. The right lens when protecting a lead.',
    fmt: (a) => a.sharpe?.toFixed(2) ?? '—',
  },
};

function stalenessReport() {
  const { meta, season, fantasy } = state.data;
  const issues = [];
  const autoAge = meta?.builtAt ? (Date.now() - new Date(meta.builtAt).getTime()) / HOUR : Infinity;
  if (autoAge > (meta?.staleAfterHours ?? 36)) {
    issues.push({
      level: 'critical', title: 'Automated data is out of date',
      text: `The last successful refresh was ${relativeTime(meta?.builtAt)}. Figures below may no longer reflect the current round.`,
    });
  }
  for (const [name, s] of Object.entries(meta?.sources ?? {})) {
    if (!s.ok) {
      issues.push({
        level: 'warning', title: `Source unavailable: ${name}`,
        text: `${s.error || 'Unknown error.'} Every other section is unaffected — sources are fetched independently.`,
      });
    }
  }
  const lastRound = season?.lastCompletedRound ?? 0;
  const fRound = fantasy?.updatedThroughRound ?? 0;
  if (lastRound > fRound) {
    const behind = lastRound - fRound;
    issues.push({
      level: behind > 2 ? 'critical' : 'warning',
      title: `League standings ${behind} round${behind === 1 ? '' : 's'} behind`,
      text: `League data is current through Round ${fRound}; Round ${lastRound} has been run. Use “Update League” to bring it current.`,
    });
  }
  for (const e of state.errors) issues.push({ level: 'critical', title: 'Data file missing', text: e });
  return issues;
}

// ── team optimisation ──────────────────────────────────────
/** Wraps the shared optimiser with this app's asset model and budget. */
function optimiseTeam(objectiveKey) {
  const cap = state.data.fantasy?.budget?.cap ?? 100;
  const score = (a) => (objectiveKey === 'sharpe' ? (a.sharpe ?? 0) : a.avgPoints);
  const best = optimiseSquad({ drivers: driversOnly(), constructors: constructorsOnly(), cap, score });
  if (!best) return null;
  return {
    objective: objectiveKey,
    drivers: best.drivers,
    constructors: best.constructors,
    cost: best.cost,
    cap,
    projectedPoints: best.squad.reduce((s, a) => s + a.avgPoints, 0),
  };
}

// ── chart primitives ───────────────────────────────────────
function sparkline(series, { w = 96, h = 24, stroke = 'var(--series-1)' } = {}) {
  const svg = svgEl('svg', { class: 'spark', viewBox: `0 0 ${w} ${h}`, width: w, height: h,
                             preserveAspectRatio: 'none', role: 'img' });
  if (!series?.length) return svg;
  const min = Math.min(0, ...series), max = Math.max(...series, 1);
  const span = max - min || 1;
  const x = (i) => (i / Math.max(1, series.length - 1)) * w;
  const y = (v) => h - ((v - min) / span) * h;
  if (min < 0) svg.append(svgEl('line', { class: 'spark-zero', x1: 0, x2: w, y1: y(0), y2: y(0) }));
  svg.append(svgEl('path', { class: 'spark-line', stroke,
    d: series.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ') }));
  svg.append(svgEl('circle', { cx: x(series.length - 1), cy: y(series.at(-1)), r: 2.2, fill: stroke }));
  return svg;
}

/**
 * Risk / reward scatter. Drivers are circles, constructors squares —
 * so asset type is carried by shape, never by colour alone.
 */
function riskRewardChart(assets, mine) {
  const W = 760, H = 420;
  const M = { t: 18, r: 22, b: 46, l: 54 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': 'Risk versus reward scatter plot of fantasy assets' });
  if (!assets.length) return svg;

  const maxX = Math.max(...assets.map((a) => a.stdev), 1) * 1.08;
  const maxY = Math.max(...assets.map((a) => a.avgPoints), 1) * 1.08;
  const minY = Math.min(0, ...assets.map((a) => a.avgPoints));
  const x = (v) => M.l + (v / maxX) * iw;
  const y = (v) => M.t + ih - ((v - minY) / (maxY - minY || 1)) * ih;

  for (let i = 0; i <= 4; i++) {
    const gy = M.t + (ih / 4) * i;
    svg.append(svgEl('line', { class: 'chart-grid', x1: M.l, x2: M.l + iw, y1: gy, y2: gy }));
    const t = svgEl('text', { class: 'chart-tick', x: M.l - 8, y: gy + 3.5, 'text-anchor': 'end' });
    t.textContent = (maxY - ((maxY - minY) / 4) * i).toFixed(0);
    svg.append(t);
    const gx = M.l + (iw / 4) * i;
    const tx = svgEl('text', { class: 'chart-tick', x: gx, y: M.t + ih + 16, 'text-anchor': 'middle' });
    tx.textContent = ((maxX / 4) * i).toFixed(0);
    svg.append(tx);
  }
  svg.append(svgEl('line', { class: 'chart-axis', x1: M.l, x2: M.l, y1: M.t, y2: M.t + ih }));
  svg.append(svgEl('line', { class: 'chart-axis', x1: M.l, x2: M.l + iw, y1: M.t + ih, y2: M.t + ih }));

  const xl = svgEl('text', { class: 'chart-label', x: M.l + iw / 2, y: H - 8, 'text-anchor': 'middle' });
  xl.textContent = 'Volatility  (σ of points per round)  →  riskier';
  svg.append(xl);
  const yl = svgEl('text', { class: 'chart-label', x: 13, y: M.t + ih / 2, 'text-anchor': 'middle',
    transform: `rotate(-90 13 ${M.t + ih / 2})` });
  yl.textContent = 'Mean points per round  →  better';
  svg.append(yl);

  const maxPrice = Math.max(...assets.map((a) => a.price), 1);
  for (const a of assets) {
    const isMine = mine.has(a.code);
    const size = 4 + (a.price / maxPrice) * 8;
    const cx = x(a.stdev), cy = y(a.avgPoints);
    const common = {
      class: 'dot', fill: a.color || 'var(--ink-3)',
      opacity: isMine ? 1 : 0.4, 'stroke-width': isMine ? 2.5 : 1.5,
    };
    const mark = a.type === 'constructor'
      ? svgEl('rect', { ...common, x: cx - size, y: cy - size, width: size * 2, height: size * 2, rx: 2 })
      : svgEl('circle', { ...common, cx, cy, r: size });
    const title = svgEl('title');
    title.textContent = `${a.code} · ${a.type} · $${a.price}M · ${a.avgPoints} pts/race · σ ${a.stdev} · Sharpe ${a.sharpe ?? '—'}`;
    mark.append(title);
    svg.append(mark);

    if (isMine || a.avgPoints > maxY * 0.55) {
      const lbl = svgEl('text', { class: 'dot-label', x: cx, y: cy - size - 4,
        'text-anchor': 'middle', opacity: isMine ? 1 : 0.7 });
      lbl.textContent = a.code;
      svg.append(lbl);
    }
  }
  return svg;
}

// ── shared render helpers ──────────────────────────────────
const chipFor = (code, extra = '') => {
  const cidx = constructorIndex();
  return `<span class="team-chip ${cls(cidx.get(code))}"><span class="team-bar"></span>
          <span class="code">${esc(code)}</span></span>${extra}`;
};

function assetTable(assets, objKey, mine) {
  const obj = OBJECTIVES[objKey];
  const table = el('table');
  table.innerHTML = `<thead><tr>
      <th>#</th><th>Asset</th><th class="num">Price</th>
      <th class="num">${esc(obj.label)}</th><th class="num">σ</th><th>Form</th>
    </tr></thead>`;
  const tb = el('tbody');
  for (const [i, a] of assets.entries()) {
    const tr = el('tr', mine.has(a.code) ? 'is-mine' : '');
    tr.innerHTML =
      `<td><span class="pos">${i + 1}</span></td>
       <td>${chipFor(a.code, mine.has(a.code) ? ' <span class="pill is-accent">yours</span>' : '')}</td>
       <td class="num">$${a.price.toFixed(1)}M</td>
       <td class="num strong">${esc(obj.fmt(a))}</td>
       <td class="num">${a.stdev.toFixed(1)}</td>
       <td></td>`;
    tr.lastElementChild.append(sparkline(a.perRound, {
      stroke: (a.momentum ?? 0) >= 0 ? 'var(--good)' : 'var(--critical)',
    }));
    tb.append(tr);
  }
  table.append(tb);
  return scrollWrap(table);
}

// ── renderers ──────────────────────────────────────────────
function renderBanners() {
  const host = $('#banners');
  host.innerHTML = '';
  for (const i of stalenessReport()) {
    host.append(el('div', `banner is-${i.level}`,
      `<span class="banner-icon">${i.level === 'critical' ? '⛔' : '⚠'}</span>
       <div><div class="banner-title">${esc(i.title)}</div>
       <div class="banner-text">${esc(i.text)}</div></div>`));
  }
}

function renderHero() {
  const race = state.data.season?.nextRace;
  const ctx = leagueContext();
  if (!race) { $('#hero-race').textContent = 'Season complete'; return; }

  $('#hero-eyebrow').textContent =
    `Round ${race.round} of ${state.data.calendar?.races?.length ?? 22}${race.isSprint ? ' · Sprint weekend' : ''}`;
  $('#hero-race').textContent = race.name;
  $('#hero-sub').textContent = `${race.circuit} · ${race.locality}, ${race.country}`;
  $('#racebar-round').textContent = `R${race.round}`;
  $('#racebar-name').textContent = race.name;

  const stats = $('#hero-stats');
  stats.innerHTML = '';
  const mk = (label, value, note) => el('div', 'stat',
    `<div class="stat-label">${esc(label)}</div><div class="stat-value">${value}</div>
     ${note ? `<div class="stat-note">${note}</div>` : ''}`);

  if (ctx) {
    stats.append(mk('League rank', `P${ctx.me.rank}`, `of ${ctx.total} teams`));
    stats.append(mk('Points', ctx.me.points.toLocaleString(),
      state.data.fantasy?._local ? 'edited locally' : `through R${state.data.fantasy.updatedThroughRound}`));
    stats.append(mk(ctx.gapAbove == null ? 'Lead' : 'Gap above',
      ctx.gapAbove == null ? `+${ctx.gapBelow ?? 0}` : `−${ctx.gapAbove}`,
      ctx.gapAbove == null ? `over ${esc(ctx.below?.team ?? '—')}` : esc(ctx.above.team)));
  }
  const chips = state.data.fantasy?.chips;
  if (chips) stats.append(mk('Chips left', String(chips.remaining?.length ?? 0), (chips.remaining ?? []).slice(0, 2).join(', ')));
  const ft = state.data.fantasy?.freeTransfers;
  if (ft) stats.append(mk('Free transfers', `${ft.available}/${ft.of}`, ft.available === 0 ? 'penalty applies' : 'no penalty'));

  tickCountdown();
}

function tickCountdown() {
  const race = state.data.season?.nextRace;
  if (!race) return;
  const lock = countdownParts(race.lockUTC);
  const start = countdownParts(race.raceStartUTC);
  const txt = fmtCountdown(lock ?? start);
  const lbl = lock ? 'until lineup lock' : start ? 'until lights out' : 'race underway';
  $('#countdown-val').textContent = txt;
  $('#countdown-lbl').textContent = lbl;
  $('#racebar-countdown').textContent = txt;
  $('#racebar-label').textContent = lbl;
}

function renderSessions() {
  const race = state.data.season?.nextRace;
  const wx = state.data.weather;
  const host = $('#sessions');
  host.innerHTML = '';
  if (!race) { host.append(el('div', 'empty', '<strong>No upcoming race</strong>The season is complete.')); return; }

  const lockKey = race.sessions.sprintQualifying ? 'sprintQualifying' : 'qualifying';
  for (const [key, iso] of Object.entries(race.sessions)) {
    const w = wx?.sessions?.[key];
    const isLock = key === lockKey;
    host.append(el('div', `session${isLock ? ' is-lock' : ''}`,
      `<div><div class="session-name">${esc(SESSION_LABELS[key] ?? key)}
         ${isLock ? '<span class="pill is-accent">LINEUP LOCK</span>' : ''}</div>
         <div class="session-time">${esc(fmtDateTime(iso))}</div></div>
       <div class="wx">${w ? esc(wxLabel(w.weatherCode, w.precipProbability)) : '—'}</div>
       <div class="wx">${w ? `${Math.round(w.tempC)}° · ${w.precipProbability}%` : ''}</div>`));
  }
}

function renderScenario() {
  const wx = state.data.weather;
  const host = $('#scenario');
  host.innerHTML = '';
  if (!wx?.available) { host.append(el('div', 'empty', '<strong>No forecast</strong>Weather source unavailable.')); return; }
  const s = wx.scenario;
  for (const r of [
    { label: 'Dry race', value: s.dryProb, fill: 'var(--series-4)' },
    { label: 'Wet race', value: s.wetProb, fill: 'var(--series-1)' },
    { label: 'Stoppage risk', value: s.haltProb, fill: 'var(--critical)' },
  ]) {
    host.append(el('div', 'bar-row',
      `<div class="bar-label">${esc(r.label)}</div>
       <div class="bar-track"><div class="bar-fill" style="width:${r.value}%; --fill:${r.fill}"></div></div>
       <div class="bar-value">${r.value}%</div>`));
  }
  const rw = wx.sessions?.race;
  if (rw) {
    host.append(el('p', 'note',
      `Race hour at ${esc(wx.circuit)}: ${esc(wxLabel(rw.weatherCode, rw.precipProbability))}, ` +
      `${Math.round(rw.tempC)}°C, ${rw.precipProbability}% precipitation, wind ${Math.round(rw.windKph)} km/h. ` +
      `Taken from the hourly forecast at each session's start time rather than a whole-weekend average.`));
  }
}

/* ── Team Builder ─────────────────────────────────────────── */
function renderBuilder() {
  const tabs = $('#builder-tabs');
  const summary = $('#builder-summary');
  const dHost = $('#builder-drivers');
  const cHost = $('#builder-constructors');
  const diff = $('#builder-diff');
  [summary, dHost, cHost, diff].forEach((n) => (n.innerHTML = ''));

  if (!allAssets().length) {
    tabs.innerHTML = '';
    summary.append(el('div', 'empty', '<strong>Asset model unavailable</strong>The team builder needs price and scoring data.'));
    return;
  }

  tabs.innerHTML = '';
  for (const [key, label] of [['points', 'Maximise points'], ['sharpe', 'Maximise consistency']]) {
    const b = el('button', null, esc(label));
    b.setAttribute('aria-selected', String(state.ui.builder === key));
    b.addEventListener('click', () => { state.ui.builder = key; renderBuilder(); });
    tabs.append(b);
  }

  const result = optimiseTeam(state.ui.builder);
  if (!result) {
    summary.append(el('div', 'empty', '<strong>No legal team found</strong>No combination fits inside the budget cap.'));
    return;
  }

  const cap = result.cap;
  $('#builder-budget').textContent = `Cap $${cap.toFixed(1)}M`;

  const mineSet = myCodes();
  const current = state.data.fantasy?.lineup ?? [];
  const assetIdx = new Map(allAssets().map((a) => [a.code, a]));
  const currentProjected = current.reduce((s, l) => s + (assetIdx.get(l.code)?.avgPoints ?? 0), 0);
  const gain = result.projectedPoints - currentProjected;

  summary.append(el('div', 'stat-row',
    `<div class="stat-mini"><div class="stat-label">Projected</div>
       <div class="stat-value">${result.projectedPoints.toFixed(1)}</div>
       <div class="stat-note">pts per round</div></div>
     <div class="stat-mini"><div class="stat-label">Cost</div>
       <div class="stat-value">$${result.cost.toFixed(1)}M</div>
       <div class="stat-note">$${(cap - result.cost).toFixed(1)}M unspent</div></div>
     <div class="stat-mini"><div class="stat-label">Your team</div>
       <div class="stat-value">${currentProjected.toFixed(1)}</div>
       <div class="stat-note">pts per round</div></div>
     <div class="stat-mini"><div class="stat-label">Difference</div>
       <div class="stat-value ${gain >= 0 ? 'delta-up' : 'delta-down'}">${gain >= 0 ? '+' : ''}${gain.toFixed(1)}</div>
       <div class="stat-note">pts per round</div></div>`));

  const squadTable = (list, host) => {
    const table = el('table');
    table.innerHTML = `<thead><tr><th>Asset</th><th class="num">Price</th>
      <th class="num">Mean</th><th class="num">σ</th><th class="num">Sharpe</th><th>Form</th></tr></thead>`;
    const tb = el('tbody');
    for (const a of list) {
      const held = mineSet.has(a.code);
      const tr = el('tr', held ? 'is-mine' : '');
      tr.innerHTML =
        `<td>${chipFor(a.code, held ? ' <span class="pill is-good">held</span>' : ' <span class="pill is-warning">buy</span>')}</td>
         <td class="num">$${a.price.toFixed(1)}M</td>
         <td class="num strong">${a.avgPoints.toFixed(1)}</td>
         <td class="num">${a.stdev.toFixed(1)}</td>
         <td class="num">${a.sharpe?.toFixed(2) ?? '—'}</td>
         <td></td>`;
      tr.lastElementChild.append(sparkline(a.perRound, {
        stroke: (a.momentum ?? 0) >= 0 ? 'var(--good)' : 'var(--critical)',
      }));
      tb.append(tr);
    }
    table.append(tb);
    host.append(scrollWrap(table));
  };
  squadTable(result.drivers, dHost);
  squadTable(result.constructors, cHost);

  // Difference against the current squad.
  const suggested = new Set([...result.drivers, ...result.constructors].map((a) => a.code));
  const toBuy = [...result.drivers, ...result.constructors].filter((a) => !mineSet.has(a.code));
  const toSell = current.filter((l) => !suggested.has(l.code));

  if (!toBuy.length && !toSell.length) {
    diff.append(el('div', 'banner is-good',
      `<span class="banner-icon">✓</span><div><div class="banner-title">Your team is already optimal</div>
       <div class="banner-text">No change improves the ${state.ui.builder === 'sharpe' ? 'consistency' : 'points'} objective within your cap.</div></div>`));
  } else {
    const ft = state.data.fantasy?.freeTransfers?.available ?? 0;
    const moves = Math.max(toBuy.length, toSell.length);
    diff.append(el('div', `banner ${moves > ft ? 'is-warning' : 'is-good'}`,
      `<span class="banner-icon">${moves > ft ? '⚠' : '✓'}</span>
       <div><div class="banner-title">${moves} transfer${moves === 1 ? '' : 's'} required · ${ft} free</div>
       <div class="banner-text">${moves > ft
          ? `That is ${moves - ft} more than your free allowance, so a points penalty would apply. Weigh the projected gain against it.`
          : 'This fits inside your free transfer allowance, so it costs no points.'}</div></div>`));

    const grid = el('div', 'grid grid-2');
    grid.style.marginTop = 'var(--s4)';
    const mkList = (title, items, kind) => {
      const box = el('div');
      box.append(el('div', 'card-title', title));
      const list = el('div', 'chip-row');
      list.style.marginTop = 'var(--s2)';
      if (!items.length) list.append(el('span', 'note', 'None'));
      for (const a of items) {
        list.append(el('span', `pill ${kind === 'buy' ? 'is-good' : 'is-critical'}`,
          `${esc(a.code ?? a.name)} · $${(a.price ?? 0).toFixed(1)}M`));
      }
      box.append(list);
      return box;
    };
    grid.append(mkList('Bring in', toBuy, 'buy'));
    grid.append(mkList('Drop', toSell, 'sell'));
    diff.append(grid);
  }

  diff.append(el('p', 'note',
    `Objective: <strong>${state.ui.builder === 'sharpe' ? 'consistency (Sharpe)' : 'raw points'}</strong>. ` +
    `Search covers every legal combination of ${SQUAD.drivers} drivers and ${SQUAD.constructors} constructors ` +
    `within $${cap.toFixed(1)}M — ${driversOnly().length} drivers and ${constructorsOnly().length} constructors in scope. ` +
    `Projections are season means, so they describe a typical round rather than a prediction for this specific race.`));
}

/* ── Strategy Analyzer ────────────────────────────────────── */
function renderStrategy() {
  const tabs = $('#objective-tabs');
  const dHost = $('#strategy-drivers');
  const cHost = $('#strategy-constructors');
  const chartHost = $('#risk-chart');
  [dHost, cHost, chartHost].forEach((n) => (n.innerHTML = ''));

  if (!allAssets().length) {
    tabs.innerHTML = '';
    dHost.append(el('div', 'empty', '<strong>Asset model unavailable</strong>'));
    return;
  }

  tabs.innerHTML = '';
  for (const [key, o] of Object.entries(OBJECTIVES)) {
    const b = el('button', null, esc(o.label));
    b.setAttribute('aria-selected', String(state.ui.objective === key));
    b.addEventListener('click', () => { state.ui.objective = key; renderStrategy(); });
    tabs.append(b);
  }

  const obj = OBJECTIVES[state.ui.objective];
  $('#strategy-blurb').textContent = obj.blurb;
  const mine = myCodes();

  const rank = (list) => [...list].filter((a) => a[obj.key] != null).sort((a, b) => b[obj.key] - a[obj.key]);
  const d = rank(driversOnly()), c = rank(constructorsOnly());

  $('#drivers-count').textContent = `${d.length} · by ${obj.label.toLowerCase()}`;
  $('#constructors-count').textContent = `${c.length} · by ${obj.label.toLowerCase()}`;

  dHost.append(assetTable(d.slice(0, 12), state.ui.objective, mine));
  cHost.append(assetTable(c, state.ui.objective, mine));

  chartHost.append(riskRewardChart(allAssets().filter((a) => a.avgPoints > 0), mine));
  chartHost.append(el('div', 'legend',
    `<span class="legend-item">● Driver</span>
     <span class="legend-item">■ Constructor</span>
     <span class="legend-item">Marker size = price</span>
     <span class="legend-item">Solid = in your team</span>
     <span class="legend-item">Upper-left = high return, low risk</span>`));
}


/* ── Track Record (walk-forward backtest) ─────────────────── */
function renderBacktest() {
  const bt = state.data.backtest;
  const host = $('#backtest-table');
  const chartHost = $('#backtest-chart');
  const caveatHost = $('#backtest-caveats');
  const excluded = $('#backtest-excluded');
  [host, chartHost, caveatHost, excluded].forEach((n) => n && (n.innerHTML = ''));
  if (!host) return;

  if (!bt?.totals) {
    host.append(el('div', 'empty', '<strong>No track record yet</strong>Needs at least four completed rounds.'));
    return;
  }

  $('#backtest-range').textContent =
    `Rounds ${bt.firstTestedRound}–${bt.lastTestedRound} · cap $${bt.cap.toFixed(1)}M`;

  const entries = Object.entries(bt.totals);
  const comparable = entries.filter(([, t]) => t.comparable).sort((a, b) => b[1].perRound - a[1].perRound);
  const notComparable = entries.filter(([, t]) => !t.comparable);
  const ceiling = bt.totals.oracle?.perRound ?? 1;

  const table = el('table');
  table.innerHTML = `<thead><tr><th>Strategy</th><th class="num">Pts / round</th>
    <th class="num">Squad cost</th><th>Share of ceiling</th><th class="num"></th></tr></thead>`;
  const tb = el('tbody');
  for (const [key, t] of comparable) {
    const isOptimiser = key === 'points' || key === 'sharpe';
    const isCeiling = key === 'oracle';
    const tr = el('tr', isOptimiser ? 'is-mine' : '');
    const pct = (t.perRound / ceiling) * 100;
    tr.innerHTML =
      `<td class="strong">${esc(bt.labels[key] ?? key)}</td>
       <td class="num strong">${t.perRound.toFixed(1)}</td>
       <td class="num">${t.cost != null ? `$${t.cost.toFixed(1)}M` : '—'}</td>
       <td><div class="bar-track" style="min-width:120px"><div class="bar-fill" style="width:${pct}%;
            --fill:${isCeiling ? 'var(--ink-3)' : isOptimiser ? 'var(--accent)' : 'var(--series-1)'}"></div></div></td>
       <td class="num">${t.shareOfCeiling?.toFixed(1) ?? '—'}%</td>`;
    tb.append(tr);
  }
  table.append(tb);
  host.append(scrollWrap(table));

  // Headline: how the optimiser did against the best comparable alternative.
  const opt = bt.totals.points;
  const rivals = comparable.filter(([k]) => k !== 'points' && k !== 'oracle');
  const bestRival = rivals[0];
  if (opt && bestRival) {
    const delta = opt.perRound - bestRival[1].perRound;
    const pct = (delta / bestRival[1].perRound) * 100;
    host.append(styled(el('div', `banner is-${delta > 0 ? 'good' : 'critical'}`,
      `<span class="banner-icon">${delta > 0 ? '✓' : '⛔'}</span>
       <div><div class="banner-title">Optimiser ${delta > 0 ? 'beats' : 'loses to'} the best comparable alternative by
         ${Math.abs(delta).toFixed(1)} pts per round (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)</div>
       <div class="banner-text">Measured against ${esc(bt.labels[bestRival[0]] ?? bestRival[0])}, over
         ${opt.rounds} rounds, choosing each round using only the rounds before it.</div></div>`),
      { marginTop: 'var(--s4)' }));
  }

  if (notComparable.length) {
    excluded.append(el('div', 'card-title', 'Excluded from the ranking'));
    for (const [key, t] of notComparable) {
      const over = ((t.cost / bt.cap) - 1) * 100;
      excluded.append(el('div', 'panel-item',
        `<div class="panel-item-head">
           <span class="pill is-warning">Not comparable</span>
           <span class="panel-item-title">${esc(bt.labels[key] ?? key)}</span></div>
         <div class="panel-item-body">
           Scored <strong>${t.perRound.toFixed(1)}</strong> pts per round, but that squad costs
           <strong>$${t.cost.toFixed(1)}M</strong> at current prices — <strong>${over.toFixed(0)}% above</strong>
           the $${bt.cap.toFixed(1)}M cap every other strategy had to respect.
           Historical prices are not published, and assets that performed well have grown more expensive
           since, so a past squad cannot be costed as it stood at the time. Ranking it against a
           budget-constrained strategy would not be a like-for-like test.
         </div>`));
    }
  }

  // Per-round comparison chart.
  const series = [
    { key: 'oracle', label: 'Perfect hindsight', color: 'var(--ink-3)', dash: '3 3' },
    { key: 'points', label: 'Optimiser · points', color: 'var(--accent)' },
    { key: 'expensive', label: 'Most expensive', color: 'var(--series-1)' },
    { key: 'field', label: 'Field average', color: 'var(--series-3)' },
  ].filter((s) => bt.perRound.some((r) => r.results[s.key]));
  chartHost.append(lineChart(bt.perRound, series));
  chartHost.append(el('div', 'legend', series.map((s) =>
    `<span class="legend-item"><span class="legend-swatch" style="--sw:${s.color}"></span>${esc(s.label)}</span>`).join('')));

  caveatHost.append(el('div', 'card-title', 'How to read this'));
  const ul = el('ul');
  for (const c of bt.caveats ?? []) ul.append(el('li', null, esc(c)));
  caveatHost.append(ul);
}

/** Multi-series line chart over rounds. */
function lineChart(rows, series) {
  const W = 760, H = 320, M = { t: 16, r: 18, b: 38, l: 46 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': 'Points per round by strategy' });
  if (!rows.length) return svg;

  const all = rows.flatMap((r) => series.map((s) => r.results[s.key]?.scored).filter((v) => v != null));
  const maxY = Math.max(...all, 1) * 1.08;
  const x = (i) => M.l + (rows.length === 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
  const y = (v) => M.t + ih - (v / maxY) * ih;

  for (let i = 0; i <= 4; i++) {
    const gy = M.t + (ih / 4) * i;
    svg.append(svgEl('line', { class: 'chart-grid', x1: M.l, x2: M.l + iw, y1: gy, y2: gy }));
    const t = svgEl('text', { class: 'chart-tick', x: M.l - 8, y: gy + 3.5, 'text-anchor': 'end' });
    t.textContent = (maxY - (maxY / 4) * i).toFixed(0);
    svg.append(t);
  }
  rows.forEach((r, i) => {
    const t = svgEl('text', { class: 'chart-tick', x: x(i), y: M.t + ih + 16, 'text-anchor': 'middle' });
    t.textContent = `R${r.round}`;
    svg.append(t);
  });
  svg.append(svgEl('line', { class: 'chart-axis', x1: M.l, x2: M.l, y1: M.t, y2: M.t + ih }));
  svg.append(svgEl('line', { class: 'chart-axis', x1: M.l, x2: M.l + iw, y1: M.t + ih, y2: M.t + ih }));

  for (const s of series) {
    const pts = rows.map((r, i) => [i, r.results[s.key]?.scored]).filter(([, v]) => v != null);
    if (!pts.length) continue;
    svg.append(svgEl('path', {
      class: 'spark-line', stroke: s.color, 'stroke-width': 2, 'stroke-dasharray': s.dash ?? null,
      d: pts.map(([i, v], n) => `${n ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '),
    }));
    for (const [i, v] of pts) {
      const c = svgEl('circle', { cx: x(i), cy: y(v), r: 3.4, fill: s.color,
                                  stroke: 'var(--surface-1)', 'stroke-width': 1.5 });
      const title = svgEl('title');
      title.textContent = `${s.label} · R${rows[i].round} · ${v} pts`;
      c.append(title);
      svg.append(c);
    }
  }
  return svg;
}

/* ── Markets ──────────────────────────────────────────────── */
function renderMarkets() {
  const m = state.data.markets;
  const host = $('#markets');
  const tabs = $('#market-tabs');
  host.innerHTML = '';
  if (!m?.available) {
    tabs.innerHTML = '';
    host.append(el('div', 'empty', '<strong>No market data</strong>No open market matched this round.'));
    return;
  }

  const available = [['winner', 'Race winner'], ['pole', 'Pole position'], ['fastestLap', 'Fastest lap']]
    .filter(([k]) => m[k]?.runners?.length);
  tabs.innerHTML = '';
  for (const [key, label] of available) {
    const b = el('button', null, esc(label));
    b.setAttribute('aria-selected', String(state.ui.market === key));
    b.addEventListener('click', () => { state.ui.market = key; renderMarkets(); });
    tabs.append(b);
  }

  const active = m[state.ui.market] ?? m.winner;
  if (!active) { host.append(el('div', 'empty', '<strong>Unavailable</strong>')); return; }

  const mine = myCodes();
  const byName = new Map((state.data.standings?.drivers ?? []).map((x) => [x.name, x.code]));
  const top = active.runners.filter((r) => r.probability >= 0.005).slice(0, 10);
  const max = Math.max(...top.map((r) => r.probability), 0.01);

  for (const r of top) {
    const code = byName.get(r.name) ?? r.name.split(' ').at(-1).slice(0, 3).toUpperCase();
    const isMine = mine.has(code);
    host.append(el('div', 'bar-row',
      `<div class="bar-label">${chipFor(code, isMine ? ' <span class="pill is-accent">yours</span>' : '')}</div>
       <div class="bar-track"><div class="bar-fill" style="width:${(r.probability / max) * 100}%;
            --fill:${isMine ? 'var(--accent)' : 'var(--series-1)'}"></div></div>
       <div class="bar-value">${(r.probability * 100).toFixed(1)}%</div>`));
  }
  host.append(el('p', 'note',
    `${esc(active.title)} · ${top.length} of ${active.runners.length} runners shown · ` +
    `$${Math.round(active.totalVolume).toLocaleString()} matched volume.`));
}

/* ── Things to Consider ───────────────────────────────────── */
function momentumPanel(list, host, mine) {
  host.innerHTML = '';
  const movers = [...list].filter((a) => a.momentum != null).sort((a, b) => b.momentum - a.momentum);
  if (!movers.length) { host.append(el('div', 'empty', '<strong>No data</strong>')); return; }
  const show = movers.length <= 4 ? movers : [...movers.slice(0, 3), ...movers.slice(-2).reverse()];
  for (const a of show) {
    const up = a.momentum >= 0;
    const item = el('div', 'panel-item');
    item.innerHTML =
      `<div class="panel-item-head">${chipFor(a.code, mine.has(a.code) ? ' <span class="pill is-accent">yours</span>' : '')}
         <span class="pill ${up ? 'is-good' : 'is-critical'}">${up ? '▲' : '▼'} ${Math.abs(a.momentum).toFixed(1)}</span></div>
       <div class="panel-item-body">
         Last two rounds averaged <strong>${a.last2Avg}</strong> against a season mean of
         <strong>${a.avgPoints.toFixed(1)}</strong>.
         ${up ? 'Trending up into this round.' : 'Cooling — recent form sits below their own baseline.'}
         ${a.negativeRounds > 0 ? ` ${a.negativeRounds} negative round${a.negativeRounds === 1 ? '' : 's'} this season.` : ''}
       </div>`;
    item.querySelector('.panel-item-head').append(sparkline(a.perRound, {
      w: 64, h: 18, stroke: up ? 'var(--good)' : 'var(--critical)',
    }));
    host.append(item);
  }
}

function valuePanel(list, host, mine) {
  host.innerHTML = '';
  const byValue = [...list].filter((a) => a.pointsPerMillion != null && a.avgPoints > 0)
    .sort((a, b) => b.pointsPerMillion - a.pointsPerMillion);
  if (!byValue.length) { host.append(el('div', 'empty', '<strong>No data</strong>')); return; }
  for (const a of byValue.slice(0, 4)) {
    host.append(el('div', 'panel-item',
      `<div class="panel-item-head">${chipFor(a.code, mine.has(a.code) ? ' <span class="pill is-accent">yours</span>' : '')}
         <span class="pill is-good">${a.pointsPerMillion.toFixed(2)} pts/$M</span></div>
       <div class="panel-item-body">$${a.price.toFixed(1)}M for ${a.avgPoints.toFixed(1)} pts per round.
         ${a.price < 10 ? 'Cheap enough to act as a budget enabler for a premium pick elsewhere.' : ''}</div>`));
  }
  const worst = [...byValue].reverse()[0];
  if (worst && byValue.length > 4) {
    host.append(el('div', 'panel-item',
      `<div class="panel-item-head">${chipFor(worst.code)}
         <span class="pill is-critical">${worst.pointsPerMillion.toFixed(2)} pts/$M</span></div>
       <div class="panel-item-body">Weakest efficiency in this group: $${worst.price.toFixed(1)}M for
         ${worst.avgPoints.toFixed(1)} pts per round.</div>`));
  }
}

function renderConsider() {
  const mine = myCodes();
  momentumPanel(driversOnly(), $('#consider-driver-form'), mine);
  momentumPanel(constructorsOnly(), $('#consider-constructor-form'), mine);
  valuePanel(driversOnly(), $('#consider-driver-value'), mine);
  valuePanel(constructorsOnly(), $('#consider-constructor-value'), mine);

  const strat = $('#consider-strategy');
  strat.innerHTML = '';
  const signals = [];
  const ctx = leagueContext();
  const wx = state.data.weather;
  const form = driverForm(3);

  if (ctx) {
    signals.push(ctx.gapAbove == null
      ? { level: 'good', title: `Protecting a ${ctx.gapBelow ?? 0}-point lead`,
          body: `You lead ${esc(ctx.below?.team ?? 'the field')}. With a lead, consistency beats ceiling — the Sharpe objective is the right lens, and mirroring their core picks caps how much they can gain on you. Hold chips until they are forced to gamble first.` }
      : { level: 'warning', title: `${ctx.gapAbove} points behind ${esc(ctx.above.team)}`,
          body: 'Matching the leader locks in the deficit. Switch to the Points objective and take controlled variance on a high-ceiling, low-ownership asset.' });
  }
  if (wx?.available) {
    signals.push(wx.scenario.wetProb >= 40
      ? { level: 'warning', title: `${wx.scenario.wetProb}% chance of a wet race`,
          body: 'Rain compresses the field and inflates positions-gained scoring. Favour drivers starting outside the top five with strong racecraft over pure qualifying pace.' }
      : { level: 'good', title: `Dry race likely (${wx.scenario.dryProb}%)`,
          body: 'Grid position should hold. Qualifying pace outweighs racecraft — weight toward front-row potential and stable constructors.' });
  }
  const mkt = state.data.markets?.winner;
  if (mkt?.runners?.length) {
    const fav = mkt.runners[0];
    const byName = new Map((state.data.standings?.drivers ?? []).map((d) => [d.name, d.code]));
    const favCode = byName.get(fav.name) ?? fav.name.split(' ').at(-1).slice(0, 3).toUpperCase();
    signals.push({
      level: mine.has(favCode) ? 'good' : 'warning',
      title: `Market favourite: ${fav.name} at ${(fav.probability * 100).toFixed(1)}%`,
      body: mine.has(favCode)
        ? 'You hold the market favourite. That protects your position but generates no differential — your edge has to come from elsewhere in the squad.'
        : `You do not hold the favourite. If rivals do, a ${fav.name} win costs you ground unless another pick outperforms.`,
    });
  }
  const risky = form.filter((d) => d.dnf > 0 && mine.has(d.code));
  if (risky.length) {
    signals.push({ level: 'critical',
      title: `Reliability risk in your squad: ${risky.map((d) => d.code).join(', ')}`,
      body: risky.map((d) => `${d.code} has ${d.dnf} non-finish${d.dnf === 1 ? '' : 'es'} in the last 3 races`).join(' · ') +
            '. A DNF on a boosted asset is the fastest way to lose a week.' });
  }
  const ft = state.data.fantasy?.freeTransfers;
  if (ft?.available > 0) {
    signals.push({ level: 'good', title: `${ft.available} free transfer${ft.available === 1 ? '' : 's'} available`,
      body: 'Free transfers do not compound indefinitely. If the Team Builder shows a gain inside your allowance, taking it costs nothing.' });
  }

  if (!signals.length) { strat.append(el('div', 'empty', '<strong>Not enough data</strong>')); return; }
  for (const s of signals) {
    strat.append(el('div', 'panel-item',
      `<div class="panel-item-head">
         <span class="pill is-${s.level}">${s.level === 'critical' ? 'Risk' : s.level === 'warning' ? 'Watch' : 'Edge'}</span>
         <span class="panel-item-title">${esc(s.title)}</span></div>
       <div class="panel-item-body">${s.body}</div>`));
  }
}

/* ── Decision signals (Overview) ──────────────────────────── */
function renderDecisions() {
  const host = $('#decisions');
  host.innerHTML = '';
  const race = state.data.season?.nextRace;
  const items = [];

  if (race) {
    const lock = countdownParts(race.lockUTC);
    items.push({
      level: lock && lock.d < 2 ? 'critical' : 'warning',
      title: lock ? `Lineup locks in ${fmtCountdown(lock)}` : 'Lineup is locked',
      text: lock
        ? `${SESSION_LABELS[race.sessions.sprintQualifying ? 'sprintQualifying' : 'qualifying']} starts ${fmtDateTime(race.lockUTC)}. All transfers and chip decisions must be in before then.`
        : `Qualifying has begun for ${race.name}. No further changes are possible.`,
    });
  }

  const result = allAssets().length ? optimiseTeam('points') : null;
  const assetIdx = new Map(allAssets().map((a) => [a.code, a]));
  const current = state.data.fantasy?.lineup ?? [];
  if (result && current.length) {
    const currentProjected = current.reduce((s, l) => s + (assetIdx.get(l.code)?.avgPoints ?? 0), 0);
    const gain = result.projectedPoints - currentProjected;
    items.push({
      level: gain > 8 ? 'warning' : 'good',
      title: gain > 1
        ? `Team Builder projects +${gain.toFixed(1)} pts per round available`
        : 'Your squad is close to optimal',
      text: gain > 1
        ? `The best legal squad within your $${result.cap.toFixed(1)}M cap projects ${result.projectedPoints.toFixed(1)} pts per round against your current ${currentProjected.toFixed(1)}. See the Team Builder tab for the specific moves.`
        : `Your current squad projects ${currentProjected.toFixed(1)} pts per round, within ${Math.abs(gain).toFixed(1)} of the theoretical optimum.`,
    });
  }

  const wx = state.data.weather;
  if (wx?.available) {
    items.push(wx.scenario.wetProb >= 40
      ? { level: 'warning', title: `${wx.scenario.wetProb}% chance of a wet race`,
          text: 'Rain compresses the field and rewards overtakers. Positions-gained becomes the dominant scoring lever.' }
      : { level: 'good', title: `Dry race likely (${wx.scenario.dryProb}%)`,
          text: 'Grid position should hold. Qualifying pace matters more than racecraft.' });
  }

  const ctx = leagueContext();
  if (ctx) {
    items.push(ctx.gapAbove == null
      ? { level: 'good', title: `Leading by ${ctx.gapBelow ?? 0} points`,
          text: `Protect the lead. Mirror ${ctx.below?.team ?? 'the chasing team'}'s core picks so their upside cannot outrun you, and save chips for a round where they must gamble first.` }
      : { level: 'warning', title: `${ctx.gapAbove} points behind ${ctx.above.team}`,
          text: 'You need differential picks. Matching the leader locks in the deficit — take controlled variance.' });
  }

  if (!items.length) { host.append(el('div', 'empty', '<strong>Not enough data</strong>')); return; }
  for (const i of items) {
    const card = el('div', `banner is-${i.level}`);
    card.style.marginTop = 'var(--s2)';
    card.innerHTML =
      `<span class="banner-icon">${i.level === 'critical' ? '⛔' : i.level === 'warning' ? '⚠' : '✓'}</span>
       <div><div class="banner-title">${esc(i.title)}</div><div class="banner-text">${esc(i.text)}</div></div>`;
    host.append(card);
  }
}

/* ── League ───────────────────────────────────────────────── */
function renderLeague() {
  const ctx = leagueContext();
  const host = $('#league');
  host.innerHTML = '';
  if (!ctx) { host.append(el('div', 'empty', '<strong>No league data</strong>Use “Update League” to add your standings.')); return; }
  const table = el('table');
  table.innerHTML = `<thead><tr><th>#</th><th>Team</th><th class="num">Points</th><th class="num">Gap</th></tr></thead>`;
  const tb = el('tbody');
  for (const t of ctx.sorted) {
    const d = t.points - ctx.me.points;
    const tr = el('tr', t.isMe ? 'is-me' : '');
    tr.innerHTML =
      `<td><span class="pos pos-${t.rank}">${t.rank}</span></td>
       <td class="strong">${esc(t.team)}</td>
       <td class="num">${t.points.toLocaleString()}</td>
       <td class="num ${d > 0 ? 'delta-down' : ''}">${t.isMe ? '—' : (d > 0 ? `+${d}` : d)}</td>`;
    tb.append(tr);
  }
  table.append(tb);
  host.append(scrollWrap(table));
}

function renderLineup() {
  const f = state.data.fantasy;
  const dHost = $('#lineup-drivers');
  const cHost = $('#lineup-constructors');
  const bHost = $('#lineup-budget');
  [dHost, cHost, bHost].forEach((n) => (n.innerHTML = ''));
  if (!f?.lineup?.length) { dHost.append(el('div', 'empty', '<strong>No squad set</strong>')); return; }

  const assetIdx = new Map(allAssets().map((a) => [a.code, a]));
  const drivers = f.lineup.filter((l) => l.role !== 'Constructor');
  const constructors = f.lineup.filter((l) => l.role === 'Constructor');

  $('#lineup-drivers-meta').textContent = `${drivers.length} of ${SQUAD.drivers}`;
  $('#lineup-constructors-meta').textContent = `${constructors.length} of ${SQUAD.constructors}`;

  const build = (list, host) => {
    const table = el('table');
    table.innerHTML = `<thead><tr><th>Asset</th><th>Role</th><th class="num">Price</th>
      <th class="num">Mean</th><th class="num">Sharpe</th><th>Form</th></tr></thead>`;
    const tb = el('tbody');
    for (const l of list) {
      const a = assetIdx.get(l.code);
      const tr = el('tr');
      tr.innerHTML =
        `<td><span class="team-chip ${cls(l.constructorId)}"><span class="team-bar"></span>
             <span class="strong">${esc(l.name)}</span></span></td>
         <td>${l.role.includes('DRS') ? `<span class="pill is-warning">${esc(l.role)}</span>`
              : l.role === 'Constructor' ? '<span class="pill">Constructor</span>' : 'Driver'}</td>
         <td class="num">$${(l.price ?? 0).toFixed(1)}M</td>
         <td class="num">${a ? a.avgPoints.toFixed(1) : '—'}</td>
         <td class="num">${a?.sharpe?.toFixed(2) ?? '—'}</td>
         <td></td>`;
      if (a) tr.lastElementChild.append(sparkline(a.perRound, {
        stroke: (a.momentum ?? 0) >= 0 ? 'var(--good)' : 'var(--critical)',
      }));
      tb.append(tr);
    }
    table.append(tb);
    host.append(scrollWrap(table));
  };
  build(drivers, dHost);
  build(constructors, cHost);

  const spend = f.lineup.reduce((s, l) => s + (l.price || 0), 0);
  const cap = f.budget?.cap ?? 100;
  const projected = f.lineup.reduce((s, l) => s + (assetIdx.get(l.code)?.avgPoints ?? 0), 0);
  bHost.append(styled(el('div', 'card',
    `<p class="note" style="margin:0">
       Committed <strong>$${spend.toFixed(1)}M</strong> of $${cap.toFixed(1)}M ·
       <span class="${spend > cap ? 'delta-down' : 'delta-up'}">$${(cap - spend).toFixed(1)}M ${spend > cap ? 'over cap' : 'free'}</span> ·
       projecting <strong>${projected.toFixed(1)}</strong> pts per round from season means.
     </p>`), { marginTop: 'var(--s4)' }));
}

function renderChips() {
  const f = state.data.fantasy;
  const host = $('#chips');
  host.innerHTML = '';
  if (!f?.chips) { host.append(el('div', 'empty', '<strong>No chip data</strong>')); return; }
  const row = el('div', 'chip-row');
  for (const c of f.chips.remaining ?? []) row.append(el('span', 'pill is-good', esc(c)));
  for (const c of f.chips.burned ?? []) row.append(el('span', 'pill is-burned', esc(c)));
  host.append(row);
  host.append(el('p', 'note',
    `<strong>${(f.chips.remaining ?? []).length} chips</strong> across <strong>${state.data.season?.roundsRemaining ?? 0} remaining rounds</strong>.`));

  const entries = Object.entries(f.rivalChips ?? {});
  if (entries.length) {
    const heading = el('div', 'card-title', 'Rival chip intelligence');
    heading.style.marginTop = 'var(--s5)';
    host.append(heading);
    for (const [team, c] of entries) {
      const r = el('div', 'chip-row');
      r.style.margin = 'var(--s2) 0';
      r.append(el('span', 'bar-label', `<strong>${esc(team)}</strong>`));
      for (const b of c.burned ?? []) r.append(el('span', 'pill is-burned', esc(b)));
      for (const b of c.remaining ?? []) r.append(el('span', 'pill', esc(b)));
      host.append(r);
    }
  }
}

/* ── Season ───────────────────────────────────────────────── */
function renderChampionship() {
  const st = state.data.standings;
  const host = $('#championship');
  host.innerHTML = '';
  if (!st?.drivers?.length) { host.append(el('div', 'empty', '<strong>Standings unavailable</strong>')); return; }
  const mine = myCodes();

  const build = (title, rows, isDriver) => {
    const card = el('div', 'card');
    card.append(el('div', 'card-head',
      `<div class="card-title">${title}</div><div class="card-meta">through R${st.throughRound}</div>`));
    const t = el('table');
    t.innerHTML = `<thead><tr><th>#</th><th>${isDriver ? 'Driver' : 'Team'}</th>
      ${isDriver ? '<th>Team</th>' : ''}<th class="num">Pts</th><th class="num">Wins</th></tr></thead>`;
    const tb = el('tbody');
    for (const r of rows) {
      const tr = el('tr', isDriver && mine.has(r.code) ? 'is-mine' : '');
      tr.innerHTML =
        `<td><span class="pos pos-${r.position}">${r.position}</span></td>
         <td><span class="team-chip ${cls(r.constructorId)}"><span class="team-bar"></span>
             <span class="${isDriver ? 'code' : 'strong'}">${esc(isDriver ? r.code : r.name)}</span></span>
             ${isDriver && mine.has(r.code) ? ' <span class="pill is-accent">yours</span>' : ''}</td>
         ${isDriver ? `<td>${esc(r.constructor ?? '—')}</td>` : ''}
         <td class="num strong">${r.points}</td><td class="num">${r.wins}</td>`;
      tb.append(tr);
    }
    t.append(tb);
    card.append(scrollWrap(t));
    return card;
  };
  host.append(build('Drivers', st.drivers.slice(0, 12), true));
  host.append(build('Constructors', st.constructors, false));
}

function renderCalendar() {
  const cal = state.data.calendar;
  const season = state.data.season;
  const host = $('#calendar');
  host.innerHTML = '';
  if (!cal?.races?.length) { host.append(el('div', 'empty', '<strong>Calendar unavailable</strong>')); return; }
  const table = el('table');
  table.innerHTML = `<thead><tr><th>R</th><th>Grand Prix</th><th>Circuit</th><th>Date</th><th>Status</th></tr></thead>`;
  const tb = el('tbody');
  for (const r of cal.races) {
    const done = r.round <= (season?.lastCompletedRound ?? 0);
    const isNext = r.round === season?.nextRound;
    const tr = el('tr', isNext ? 'is-me' : '');
    tr.innerHTML =
      `<td><span class="pos">${r.round}</span></td>
       <td class="strong">${esc(r.shortName)}${r.isSprint ? ' <span class="pill is-warning">Sprint</span>' : ''}</td>
       <td>${esc(r.locality)}, ${esc(r.country)}</td>
       <td>${esc(new Date(r.raceStartUTC).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</td>
       <td>${done ? '<span class="pill">Complete</span>' : isNext ? '<span class="pill is-accent">Next</span>' : '<span class="pill">Upcoming</span>'}</td>`;
    tb.append(tr);
  }
  table.append(tb);
  host.append(scrollWrap(table));
}

/* ── Data & automation ────────────────────────────────────── */
function renderProvenance() {
  const meta = state.data.meta;
  const host = $('#provenance');
  host.innerHTML = '';
  const S = meta?.sources ?? {};
  const rows = [
    ['Race calendar & sessions', 'Jolpica-F1', 'live', S.calendar],
    ['Championship standings', 'Jolpica-F1', 'live', S.standings],
    ['Race results & form', 'Jolpica-F1', 'live', S.results],
    ['Session weather', 'Open-Meteo', 'live', S.weather],
    ['Betting markets', 'Polymarket', 'live', S.markets],
    ['Fantasy prices & scoring', 'f1fantasytools.com', 'live', S.assets],
    ['League standings', 'Manual entry', 'manual', { fetchedAt: state.data.fantasy?.updatedAt, ok: true }],
    ['Squad & chips', 'Manual entry', 'manual', { fetchedAt: state.data.fantasy?.updatedAt, ok: true }],
  ];
  const table = el('table');
  table.innerHTML = `<thead><tr><th>Data</th><th>Source</th><th>Type</th><th>Status</th><th>Updated</th></tr></thead>`;
  const tb = el('tbody');
  for (const [what, src, type, s] of rows) {
    const ok = s?.ok !== false;
    const tr = el('tr');
    tr.innerHTML =
      `<td class="strong">${esc(what)}</td><td>${esc(src)}</td>
       <td><span class="prov is-${type}">${type === 'live' ? 'Automated' : 'Manual'}</span></td>
       <td>${ok ? '<span class="pill is-good">OK</span>' : '<span class="pill is-critical">Failed</span>'}</td>
       <td>${esc(relativeTime(s?.fetchedAt))}</td>`;
    tb.append(tr);
  }
  table.append(tb);
  host.append(scrollWrap(table));

  const cadence = $('#cadence');
  cadence.innerHTML = '';
  cadence.append(el('div', 'panel-list',
    `<div class="panel-item"><div class="panel-item-title">Race weekends</div>
       <div class="panel-item-body">Hourly, Thursday through Sunday. Odds and forecasts move quickly as a weekend approaches, and the lineup deadline falls inside that window.</div></div>
     <div class="panel-item"><div class="panel-item-title">Weekdays</div>
       <div class="panel-item-body">Once daily. Between rounds only prices and championship standings change.</div></div>
     <div class="panel-item"><div class="panel-item-title">On demand</div>
       <div class="panel-item-body">The pipeline can be triggered manually at any time, and runs automatically whenever its own code changes.</div></div>
     <div class="panel-item"><div class="panel-item-title">Failure handling</div>
       <div class="panel-item-body">Each source is fetched independently, so one failing never blocks the others. A failed run exits with an error rather than passing quietly, and the status column above reports which source is affected.</div></div>`));

  const method = $('#methodology');
  method.innerHTML = '';
  method.append(el('div', 'panel-list',
    `<div class="panel-item"><div class="panel-item-title">Mean &amp; σ</div>
       <div class="panel-item-body">Fantasy scoring is published per component per round. Summing the components gives a points-per-round series for every asset; mean and standard deviation follow from that series.</div></div>
     <div class="panel-item"><div class="panel-item-title">Sharpe</div>
       <div class="panel-item-body">Mean divided by standard deviation — reward per unit of risk. It separates assets that score consistently from those whose average rests on one outlier weekend.</div></div>
     <div class="panel-item"><div class="panel-item-title">Points per $M</div>
       <div class="panel-item-body">Mean points divided by price. Identifies budget enablers — cheap assets whose output frees cap space for a premium pick.</div></div>
     <div class="panel-item"><div class="panel-item-title">Momentum</div>
       <div class="panel-item-body">Last two rounds against the season mean, so form is measured against each asset's own baseline rather than the field.</div></div>
     <div class="panel-item"><div class="panel-item-title">Team Builder</div>
       <div class="panel-item-body">An exhaustive search over every legal combination of five drivers and two constructors inside the budget cap — the true optimum for the chosen objective, not a sampled approximation.</div></div>`));
}

// ── Update League panel ────────────────────────────────────
function openModal() {
  const f = state.data.fantasy ?? {};
  $('#modal-round').value = state.data.season?.lastCompletedRound ?? f.updatedThroughRound ?? 0;
  const host = $('#standings-editor');
  host.innerHTML = '';
  const rows = f.standings?.length ? f.standings
    : Array.from({ length: 8 }, (_, i) => ({ rank: i + 1, team: '', points: 0 }));
  rows.forEach((s, i) => {
    host.append(el('div', 'standings-row',
      `<div class="bar-label" style="text-align:center">${i + 1}</div>
       <input type="text" value="${esc(s.team)}" placeholder="Team name" data-k="team">
       <input type="number" value="${s.points ?? 0}" placeholder="Points" data-k="points">`));
  });
  $('#modal-backdrop').hidden = false;
}

function saveModal() {
  const standings = [...$('#standings-editor').children]
    .map((row) => {
      const get = (k) => $(`[data-k="${k}"]`, row)?.value ?? '';
      return { rank: 0, team: get('team').trim(), points: Number(get('points')) || 0, isMe: false };
    })
    .filter((s) => s.team);
  if (!standings.length) { toast('Add at least one team.'); return; }

  standings.sort((a, b) => b.points - a.points).forEach((s, i) => { s.rank = i + 1; });
  const myTeam = (state.data.fantasy?.me?.teamName ?? '').toLowerCase();
  (standings.find((s) => s.team.toLowerCase() === myTeam) ?? standings[0]).isMe = true;

  const round = Number($('#modal-round').value) || 0;
  const me = standings.find((x) => x.isMe);

  // Append a point-in-time snapshot of the squad. This is what makes the
  // Track Record possible: without a record of what was actually fielded,
  // there is nothing to measure the model against later.
  const history = [...(state.data.fantasy?.history ?? [])];
  const snapshot = {
    round,
    raceName: state.data.calendar?.races?.find((r) => r.round === round)?.name ?? null,
    recordedAt: new Date().toISOString(),
    points: me?.points ?? null,
    rank: me?.rank ?? null,
    source: 'update-panel',
    squad: (state.data.fantasy?.lineup ?? []).map((l) => ({
      code: l.code, name: l.name, role: l.role, price: l.price,
    })),
    chipsBurned: [...(state.data.fantasy?.chips?.burned ?? [])],
  };
  const existing = history.findIndex((h) => h.round === round);
  if (existing >= 0) history[existing] = snapshot; else history.push(snapshot);
  history.sort((a, b) => a.round - b.round);

  const payload = {
    ...state.data.fantasy, standings, history,
    updatedThroughRound: round,
    updatedAt: new Date().toISOString(),
  };
  localStorage.setItem(LS_KEY, JSON.stringify(payload));
  state.data.fantasy = { ...payload, _local: true };
  $('#modal-backdrop').hidden = true;
  renderAll();
  toast(`Saved. Round ${round} squad recorded — use “Copy JSON” to persist it.`);
}

function copyJSON() {
  const payload = { ...state.data.fantasy };
  delete payload._local;
  navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
    .then(() => toast('Copied. Paste into data/fantasy.json and commit to persist.'))
    .catch(() => toast('Copy failed — your browser blocked clipboard access.'));
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('is-visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('is-visible'), 4200);
}

// ── tab routing ────────────────────────────────────────────
function buildTabs() {
  const nav = $('#tabs');
  nav.innerHTML = '';
  for (const [key, label] of TABS) {
    const b = el('button', 'tab', esc(label));
    b.setAttribute('role', 'tab');
    b.dataset.tab = key;
    b.addEventListener('click', () => showTab(key));
    nav.append(b);
  }
}

function showTab(key, { push = true } = {}) {
  if (!TABS.some(([k]) => k === key)) key = 'overview';
  state.ui.tab = key;

  for (const [k] of TABS) {
    const view = document.getElementById(`view-${k}`);
    if (view) view.hidden = k !== key;
  }
  for (const b of document.querySelectorAll('.tab')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === key));
  }
  document.body.classList.remove('menu-open');
  $('#btn-menu').setAttribute('aria-expanded', 'false');
  if (push && location.hash !== `#${key}`) history.replaceState(null, '', `#${key}`);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// ── boot ───────────────────────────────────────────────────
function renderAll() {
  state.cache = {};
  // Each renderer is isolated so one failure cannot blank the page.
  const steps = [
    ['banners', renderBanners], ['hero', renderHero], ['decisions', renderDecisions],
    ['sessions', renderSessions], ['scenario', renderScenario], ['builder', renderBuilder],
    ['strategy', renderStrategy], ['backtest', renderBacktest], ['markets', renderMarkets], ['consider', renderConsider],
    ['league', renderLeague], ['lineup', renderLineup], ['chips', renderChips],
    ['championship', renderChampionship], ['calendar', renderCalendar], ['provenance', renderProvenance],
  ];
  for (const [name, fn] of steps) {
    try { fn(); } catch (err) { console.error(`[render:${name}]`, err); }
  }
}

async function boot() {
  const savedTheme = localStorage.getItem('f1mc.theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;

  buildTabs();
  await loadAll();
  renderAll();
  showTab((location.hash || '#overview').slice(1), { push: false });
  setInterval(tickCountdown, 1000);

  window.addEventListener('hashchange', () => showTab((location.hash || '#overview').slice(1), { push: false }));

  $('#btn-menu').addEventListener('click', () => {
    const open = document.body.classList.toggle('menu-open');
    $('#btn-menu').setAttribute('aria-expanded', String(open));
  });
  $('#btn-update').addEventListener('click', openModal);
  $('#btn-save').addEventListener('click', saveModal);
  $('#btn-copy').addEventListener('click', copyJSON);
  $('#btn-cancel').addEventListener('click', () => { $('#modal-backdrop').hidden = true; });
  $('#modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') $('#modal-backdrop').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#modal-backdrop').hidden = true;
      document.body.classList.remove('menu-open');
    }
  });
  $('#btn-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('f1mc.theme', next);
  });
}

boot();
