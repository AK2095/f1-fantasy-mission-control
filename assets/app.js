/* ============================================================
   F1 Mission Control · application layer
   ------------------------------------------------------------
   Contract: this file NEVER contains data. It loads /data/*.json,
   derives, and renders. v1 died because a snapshot got inlined into
   the page and silently diverged from the file the robots updated.
   If you find yourself pasting values here, stop — put them in /data.
   ============================================================ */

const DATA_FILES = ['season', 'calendar', 'standings', 'results', 'weather', 'markets', 'assets', 'fantasy', 'meta'];
const LS_KEY = 'f1mc.fantasy.override';
const HOUR = 36e5;

const state = {
  data: {},
  errors: [],
  ui: { objective: 'points', market: 'winner' },
};

// ── utilities ──────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

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

/** Wrap a wide table so it scrolls inside its own box, never the page. */
const scrollWrap = (node) => {
  const box = el('div', 'table-scroll');
  box.append(node);
  return box;
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function fmtDateTime(iso, opts = {}) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', ...opts,
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
    d: Math.floor(ms / 864e5),
    h: Math.floor((ms % 864e5) / 36e5),
    m: Math.floor((ms % 36e5) / 6e4),
    s: Math.floor((ms % 6e4) / 1000),
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

// ── derived intelligence ───────────────────────────────────

/** Codes of assets currently in my lineup. */
const myCodes = () => new Set((state.data.fantasy?.lineup ?? []).map((l) => l.code));

/** Map from asset code → constructorId, for identity colouring. */
function constructorIndex() {
  const map = new Map();
  for (const d of state.data.standings?.drivers ?? []) map.set(d.code, d.constructorId);
  for (const l of state.data.fantasy?.lineup ?? []) map.set(l.code, l.constructorId);
  // f1fantasytools ids look like "MER_ANT" / "MER" — use the prefix as a fallback.
  const alias = { MER: 'mercedes', FER: 'ferrari', MCL: 'mclaren', RED: 'red_bull', VRB: 'rb',
                  ALP: 'alpine', AST: 'aston_martin', WIL: 'williams', AUD: 'audi', HAA: 'haas', CAD: 'cadillac' };
  for (const a of state.data.assets?.assets ?? []) {
    if (!map.has(a.code)) map.set(a.code, alias[String(a.id).split('_')[0]] ?? 'unknown');
  }
  return map;
}

/** Rolling form from official race results (distinct from fantasy scoring). */
function driverForm(n = 3) {
  const rounds = state.data.results?.rounds ?? [];
  const acc = new Map();
  for (const rd of rounds.slice(-n)) {
    for (const r of rd.results) {
      const cur = acc.get(r.code) ?? {
        code: r.code, name: r.name, constructorId: r.constructorId,
        constructor: r.constructor, points: 0, gained: 0, dnf: 0, starts: 0,
      };
      cur.points += r.points;
      cur.gained += r.positionsGained;
      cur.starts += 1;
      if (!/^(Finished|\+\d+ Lap)/.test(r.status)) cur.dnf += 1;
      acc.set(r.code, cur);
    }
  }
  return [...acc.values()]
    .map((d) => ({
      ...d,
      avgPoints: d.starts ? d.points / d.starts : 0,
      trend: d.points / Math.max(1, d.starts) >= 12 ? 'hot' : d.points > 0 ? 'steady' : 'cold',
    }))
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

/** The three Strategy Analyzer objectives. */
const OBJECTIVES = {
  points: {
    label: 'Points',
    key: 'avgPoints',
    unit: 'pts/race',
    blurb: 'Ranked by raw mean fantasy points per round. Ignores both price and consistency — this is the ceiling-chasing view, correct when you are behind and need variance.',
    fmt: (a) => a.avgPoints?.toFixed(1) ?? '—',
  },
  budget: {
    label: 'Budget',
    key: 'pointsPerMillion',
    unit: 'pts per $M',
    blurb: 'Ranked by mean points per $M of price. This is the efficiency view — it surfaces the budget enablers that free up cap space for a premium pick elsewhere.',
    fmt: (a) => a.pointsPerMillion?.toFixed(2) ?? '—',
  },
  sharpe: {
    label: 'Sharpe',
    key: 'sharpe',
    unit: 'mean ÷ σ',
    blurb: 'Ranked by mean points divided by standard deviation — reward per unit of risk. Punishes assets whose average is propped up by one big weekend, and favours the ones that reliably deliver. Correct when you are protecting a lead.',
    fmt: (a) => a.sharpe?.toFixed(2) ?? '—',
  },
};

function stalenessReport() {
  const { meta, season, fantasy } = state.data;
  const issues = [];

  const autoAge = meta?.builtAt ? (Date.now() - new Date(meta.builtAt).getTime()) / HOUR : Infinity;
  if (autoAge > (meta?.staleAfterHours ?? 36)) {
    issues.push({
      level: 'critical',
      title: 'Automated data is stale',
      text: `Last successful build was ${relativeTime(meta?.builtAt)}. The refresh pipeline may be failing — check the Actions tab.`,
    });
  }

  for (const [name, s] of Object.entries(meta?.sources ?? {})) {
    if (!s.ok) {
      issues.push({
        level: 'warning',
        title: `Source unavailable: ${name}`,
        text: `${s.error || 'Unknown error.'} Other sections are unaffected; this one shows its last good values or an empty state.`,
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
      text: `Your league data is current through Round ${fRound}; Round ${lastRound} has been run. Open “Update League” to bring it current.`,
    });
  }

  for (const e of state.errors) issues.push({ level: 'critical', title: 'Data file missing', text: e });
  return issues;
}

// ── chart primitives ───────────────────────────────────────

/** Sparkline of a per-round series, with a zero baseline. */
function sparkline(series, { w = 104, h = 26, stroke = 'var(--series-1)' } = {}) {
  const svg = svgEl('svg', { class: 'spark', viewBox: `0 0 ${w} ${h}`, width: w, height: h,
                             preserveAspectRatio: 'none', role: 'img' });
  if (!series?.length) return svg;

  const min = Math.min(0, ...series);
  const max = Math.max(...series, 1);
  const span = max - min || 1;
  const x = (i) => (i / Math.max(1, series.length - 1)) * w;
  const y = (v) => h - ((v - min) / span) * h;

  if (min < 0) {
    svg.append(svgEl('line', { class: 'spark-zero', x1: 0, x2: w, y1: y(0), y2: y(0) }));
  }
  svg.append(svgEl('path', {
    class: 'spark-line', stroke,
    d: series.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '),
  }));
  svg.append(svgEl('circle', {
    cx: x(series.length - 1), cy: y(series.at(-1)), r: 2.2, fill: stroke,
  }));
  return svg;
}

/**
 * Risk / reward scatter: mean points (y) against standard deviation (x).
 * Up is better, left is safer. Marks carry a text code, so constructor
 * colour never has to carry identity on its own.
 */
function riskRewardChart(assets, mine) {
  const W = 720, H = 400;
  const M = { t: 18, r: 20, b: 44, l: 52 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;

  const svg = svgEl('svg', {
    class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': 'Risk versus reward scatter plot of fantasy assets',
  });
  if (!assets.length) return svg;

  const maxX = Math.max(...assets.map((a) => a.stdev), 1) * 1.08;
  const maxY = Math.max(...assets.map((a) => a.avgPoints), 1) * 1.08;
  const minY = Math.min(0, ...assets.map((a) => a.avgPoints));
  const x = (v) => M.l + (v / maxX) * iw;
  const y = (v) => M.t + ih - ((v - minY) / (maxY - minY || 1)) * ih;

  // gridlines + ticks
  for (let i = 0; i <= 4; i++) {
    const gy = M.t + (ih / 4) * i;
    const val = maxY - ((maxY - minY) / 4) * i;
    svg.append(svgEl('line', { class: 'chart-grid', x1: M.l, x2: M.l + iw, y1: gy, y2: gy }));
    const t = svgEl('text', { class: 'chart-tick', x: M.l - 8, y: gy + 3.5, 'text-anchor': 'end' });
    t.textContent = val.toFixed(0);
    svg.append(t);
  }
  for (let i = 0; i <= 4; i++) {
    const gx = M.l + (iw / 4) * i;
    const t = svgEl('text', { class: 'chart-tick', x: gx, y: M.t + ih + 16, 'text-anchor': 'middle' });
    t.textContent = ((maxX / 4) * i).toFixed(0);
    svg.append(t);
  }

  svg.append(svgEl('line', { class: 'chart-axis', x1: M.l, x2: M.l, y1: M.t, y2: M.t + ih }));
  svg.append(svgEl('line', { class: 'chart-axis', x1: M.l, x2: M.l + iw, y1: M.t + ih, y2: M.t + ih }));

  const xl = svgEl('text', { class: 'chart-label', x: M.l + iw / 2, y: H - 6, 'text-anchor': 'middle' });
  xl.textContent = 'Volatility  (σ of points per round)  →  riskier';
  svg.append(xl);

  const yl = svgEl('text', {
    class: 'chart-label', x: 12, y: M.t + ih / 2, 'text-anchor': 'middle',
    transform: `rotate(-90 12 ${M.t + ih / 2})`,
  });
  yl.textContent = 'Mean points per round  →  better';
  svg.append(yl);

  const maxPrice = Math.max(...assets.map((a) => a.price), 1);
  for (const a of assets) {
    const isMine = mine.has(a.code);
    const r = 4 + (a.price / maxPrice) * 8;
    const g = svgEl('g');
    const dot = svgEl('circle', {
      class: 'dot', cx: x(a.stdev), cy: y(a.avgPoints), r,
      fill: a.color || 'var(--ink-3)',
      opacity: isMine ? 1 : 0.42,
      'stroke-width': isMine ? 2.5 : 1.5,
    });
    const title = svgEl('title');
    title.textContent =
      `${a.code} · $${a.price}M · ${a.avgPoints} pts/race · σ ${a.stdev} · Sharpe ${a.sharpe ?? '—'}`;
    dot.append(title);
    g.append(dot);

    // Label only my assets and the strongest performers, to avoid a thicket.
    if (isMine || a.avgPoints > maxY * 0.55) {
      const lbl = svgEl('text', {
        class: 'dot-label', x: x(a.stdev), y: y(a.avgPoints) - r - 4, 'text-anchor': 'middle',
        opacity: isMine ? 1 : 0.7,
      });
      lbl.textContent = a.code;
      g.append(lbl);
    }
    svg.append(g);
  }
  return svg;
}

// ── renderers ──────────────────────────────────────────────

function renderBanners() {
  const host = $('#banners');
  host.innerHTML = '';
  const issues = stalenessReport();
  if (!issues.length) return; // quiet when healthy; provenance table carries detail

  for (const i of issues) {
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

  const stats = $('#hero-stats');
  stats.innerHTML = '';
  const mk = (label, value, note) => el('div', 'stat',
    `<div class="stat-label">${esc(label)}</div>
     <div class="stat-value">${value}</div>
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
  $('#countdown-val').textContent = fmtCountdown(lock ?? start);
  $('#countdown-lbl').textContent = lock ? 'until lineup lock' : start ? 'until lights out' : 'race underway';
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
      `<div>
         <div class="session-name">${esc(SESSION_LABELS[key] ?? key)}
           ${isLock ? '<span class="pill is-accent">LINEUP LOCK</span>' : ''}</div>
         <div class="session-time">${esc(fmtDateTime(iso))}</div>
       </div>
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
      `Derived from the hourly forecast at the session start time, not a whole-weekend average.`));
  }
}

/* ── Market Intelligence (Polymarket) ─────────────────────── */
function renderMarkets() {
  const m = state.data.markets;
  const host = $('#markets');
  const tabs = $('#market-tabs');
  host.innerHTML = '';

  if (!m?.available) {
    tabs.innerHTML = '';
    host.append(el('div', 'empty',
      '<strong>No market data</strong>No open Polymarket event matched this round.'));
    return;
  }

  const available = [
    ['winner', 'Race winner'],
    ['pole', 'Pole position'],
    ['fastestLap', 'Fastest lap'],
  ].filter(([k]) => m[k]?.runners?.length);

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
  const cidx = constructorIndex();
  const byCode = new Map((state.data.standings?.drivers ?? []).map((d) => [d.name, d.code]));

  const top = active.runners.filter((r) => r.probability >= 0.005).slice(0, 10);
  const max = Math.max(...top.map((r) => r.probability), 0.01);

  for (const r of top) {
    const code = byCode.get(r.name) ?? r.name.split(' ').at(-1).slice(0, 3).toUpperCase();
    const isMine = mine.has(code);
    const row = el('div', 'bar-row');
    row.innerHTML =
      `<div class="bar-label">
         <span class="team-chip ${cls(cidx.get(code))}"><span class="team-bar"></span>
         <span class="code">${esc(code)}</span></span>
         ${isMine ? '<span class="pill is-accent">yours</span>' : ''}
       </div>
       <div class="bar-track">
         <div class="bar-fill" style="width:${(r.probability / max) * 100}%;
              --fill:${isMine ? 'var(--accent)' : 'var(--series-1)'}"></div>
       </div>
       <div class="bar-value">${(r.probability * 100).toFixed(1)}%</div>`;
    host.append(row);
  }

  host.append(el('p', 'note',
    `${esc(active.title)} · ${top.length} of ${active.runners.length} runners shown · ` +
    `$${Math.round(active.totalVolume).toLocaleString()} matched volume. ` +
    `Prices are live Polymarket order-book probabilities, resolved to this round automatically from the calendar.`));
}

/* ── Strategy Analyzer ────────────────────────────────────── */
function renderStrategy() {
  const assets = state.data.assets?.assets ?? [];
  const host = $('#strategy');
  const tabs = $('#objective-tabs');
  const chartHost = $('#risk-chart');
  host.innerHTML = '';
  chartHost.innerHTML = '';

  if (!assets.length) {
    tabs.innerHTML = '';
    host.append(el('div', 'empty',
      '<strong>Asset model unavailable</strong>The f1fantasytools source failed on the last build. Other sections are unaffected.'));
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
  const mine = myCodes();
  const cidx = constructorIndex();

  const ranked = [...assets]
    .filter((a) => a[obj.key] != null)
    .sort((a, b) => b[obj.key] - a[obj.key]);

  $('#strategy-blurb').textContent = obj.blurb;

  const table = el('table');
  table.innerHTML =
    `<thead><tr>
       <th>#</th><th>Asset</th><th>Type</th>
       <th class="num">Price</th>
       <th class="num">${esc(obj.label)}</th>
       <th class="num">Mean</th><th class="num">σ</th><th class="num">Sharpe</th>
       <th>Form</th>
     </tr></thead>`;
  const tb = el('tbody');

  for (const [i, a] of ranked.slice(0, 15).entries()) {
    const tr = el('tr', mine.has(a.code) ? 'is-mine' : '');
    tr.innerHTML =
      `<td><span class="pos">${i + 1}</span></td>
       <td><span class="team-chip ${cls(cidx.get(a.code))}"><span class="team-bar"></span>
           <span class="code">${esc(a.code)}</span></span>
           ${mine.has(a.code) ? ' <span class="pill is-accent">yours</span>' : ''}</td>
       <td><span class="pill">${a.type === 'constructor' ? 'Constructor' : 'Driver'}</span></td>
       <td class="num">$${a.price.toFixed(1)}M</td>
       <td class="num strong">${esc(obj.fmt(a))}</td>
       <td class="num">${a.avgPoints.toFixed(1)}</td>
       <td class="num">${a.stdev.toFixed(1)}</td>
       <td class="num">${a.sharpe?.toFixed(2) ?? '—'}</td>
       <td></td>`;
    const sparkCell = tr.lastElementChild;
    const trend = (a.momentum ?? 0) >= 0 ? 'var(--good)' : 'var(--critical)';
    sparkCell.append(sparkline(a.perRound, { stroke: trend }));
    tb.append(tr);
  }
  table.append(tb);
  host.append(scrollWrap(table));
  host.append(el('p', 'note',
    `Ranked by <strong>${esc(obj.label.toLowerCase())}</strong> (${esc(obj.unit)}) across ` +
    `${state.data.assets.rounds} completed rounds. Prices are official F1 Fantasy values; ` +
    `mean, σ, Sharpe and points-per-$M are computed here from the per-round scoring breakdown.`));

  chartHost.append(riskRewardChart(assets.filter((a) => a.avgPoints > 0), mine));
  chartHost.append(el('div', 'legend',
    `<span class="legend-item"><span class="legend-swatch" style="--sw:var(--accent)"></span>Marker size = price</span>
     <span class="legend-item">Solid = in your lineup</span>
     <span class="legend-item">Upper-left = high return, low risk</span>`));
}

/* ── Things to Consider ───────────────────────────────────── */
function renderConsider() {
  const assets = state.data.assets?.assets ?? [];
  const mine = myCodes();
  const cidx = constructorIndex();
  const form = driverForm(3);
  const wx = state.data.weather;
  const ctx = leagueContext();

  const chip = (code) =>
    `<span class="team-chip ${cls(cidx.get(code))}"><span class="team-bar"></span><span class="code">${esc(code)}</span></span>`;

  // ── Momentum ──
  const momentum = $('#consider-form');
  momentum.innerHTML = '';
  const movers = [...assets].filter((a) => a.momentum != null).sort((a, b) => b.momentum - a.momentum);
  if (!movers.length) {
    momentum.append(el('div', 'empty', '<strong>No asset data</strong>'));
  } else {
    for (const a of [...movers.slice(0, 3), ...movers.slice(-2).reverse()]) {
      const up = a.momentum >= 0;
      const item = el('div', 'panel-item');
      item.innerHTML =
        `<div class="panel-item-head">${chip(a.code)}
           <span class="pill ${up ? 'is-good' : 'is-critical'}">${up ? '▲' : '▼'} ${Math.abs(a.momentum).toFixed(1)} vs season avg</span>
           ${mine.has(a.code) ? '<span class="pill is-accent">yours</span>' : ''}</div>
         <div class="panel-item-body">
           Last two rounds averaged <strong>${a.last2Avg}</strong> against a season mean of
           <strong>${a.avgPoints.toFixed(1)}</strong>.
           ${up ? 'Trending up into this round.' : 'Cooling — recent form is below their own baseline.'}
           ${a.negativeRounds > 0 ? ` ${a.negativeRounds} negative round${a.negativeRounds === 1 ? '' : 's'} this season.` : ''}
         </div>`;
      item.querySelector('.panel-item-head').append(sparkline(a.perRound, {
        w: 72, h: 20, stroke: up ? 'var(--good)' : 'var(--critical)',
      }));
      momentum.append(item);
    }
  }

  // ── Value ──
  const value = $('#consider-value');
  value.innerHTML = '';
  const byValue = [...assets].filter((a) => a.pointsPerMillion != null && a.avgPoints > 0)
    .sort((a, b) => b.pointsPerMillion - a.pointsPerMillion);
  if (!byValue.length) {
    value.append(el('div', 'empty', '<strong>No asset data</strong>'));
  } else {
    const budgetCap = state.data.fantasy?.budget?.cap ?? 100;
    const spend = (state.data.fantasy?.lineup ?? []).reduce((s, l) => s + (l.price || 0), 0);

    for (const a of byValue.slice(0, 4)) {
      value.append(el('div', 'panel-item',
        `<div class="panel-item-head">${chip(a.code)}
           <span class="pill is-good">${a.pointsPerMillion.toFixed(2)} pts/$M</span>
           ${mine.has(a.code) ? '<span class="pill is-accent">yours</span>' : ''}</div>
         <div class="panel-item-body">
           $${a.price.toFixed(1)}M for ${a.avgPoints.toFixed(1)} pts per round.
           ${a.type === 'constructor' ? 'Constructor slot.' : 'Driver slot.'}
           ${a.price < 10 ? ' Cheap enough to act as a budget enabler for a premium pick elsewhere.' : ''}
         </div>`));
    }
    const overpriced = [...byValue].reverse().find((a) => a.price > 20);
    if (overpriced) {
      value.append(el('div', 'panel-item',
        `<div class="panel-item-head">${chip(overpriced.code)}
           <span class="pill is-critical">${overpriced.pointsPerMillion.toFixed(2)} pts/$M</span></div>
         <div class="panel-item-body">
           Weakest efficiency among premium assets: $${overpriced.price.toFixed(1)}M for
           ${overpriced.avgPoints.toFixed(1)} pts per round. Freeing this slot buys the most cap space per point sacrificed.
         </div>`));
    }
    value.append(el('p', 'note',
      `Your lineup commits <strong>$${spend.toFixed(1)}M</strong> of the $${budgetCap.toFixed(1)}M cap.`));
  }

  // ── Strategy signals ──
  const strat = $('#consider-strategy');
  strat.innerHTML = '';
  const signals = [];

  if (ctx) {
    signals.push(ctx.gapAbove == null
      ? { level: 'good', title: `Protecting a ${ctx.gapBelow ?? 0}-point lead`,
          body: `You lead ${esc(ctx.below?.team ?? 'the field')}. With a lead, the Sharpe objective is the correct lens — mirroring their core picks caps their upside relative to you, and consistency beats ceiling. Hold chips until they are forced to gamble first.` }
      : { level: 'warning', title: `${ctx.gapAbove} points behind ${esc(ctx.above.team)}`,
          body: `Matching the leader locks in the deficit. Switch to the Points objective and take controlled variance on a high-ceiling, low-ownership asset.` });
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
        ? 'You hold the market favourite. That is the consensus pick, so it protects position but generates no differential — your edge has to come from elsewhere in the lineup.'
        : `You do not hold the favourite. If your rivals do, a ${fav.name} win costs you ground relative to the field unless another pick outperforms.`,
    });
  }

  const risky = form.filter((d) => d.dnf > 0 && mine.has(d.code));
  if (risky.length) {
    signals.push({
      level: 'critical',
      title: `Reliability risk in your lineup: ${risky.map((d) => d.code).join(', ')}`,
      body: risky.map((d) => `${d.code} has ${d.dnf} non-finish${d.dnf === 1 ? '' : 'es'} in the last 3 races`).join(' · ') +
            '. A DNF on a boosted asset is the fastest way to lose a week.',
    });
  }

  const ft = state.data.fantasy?.freeTransfers;
  if (ft && ft.available > 0) {
    signals.push({
      level: 'good', title: `${ft.available} free transfer${ft.available === 1 ? '' : 's'} available`,
      body: 'Unused free transfers do not compound indefinitely. If the Budget view shows a clear efficiency gain, taking it now costs nothing.',
    });
  }

  if (!signals.length) {
    strat.append(el('div', 'empty', '<strong>Not enough data</strong>'));
  } else {
    for (const s of signals) {
      strat.append(el('div', 'panel-item',
        `<div class="panel-item-head">
           <span class="pill is-${s.level}">${s.level === 'critical' ? 'Risk' : s.level === 'warning' ? 'Watch' : 'Edge'}</span>
           <span class="panel-item-title">${esc(s.title)}</span></div>
         <div class="panel-item-body">${s.body}</div>`));
    }
  }
}

function renderLeague() {
  const ctx = leagueContext();
  const host = $('#league');
  host.innerHTML = '';
  if (!ctx) {
    host.append(el('div', 'empty', '<strong>No league data</strong>Use “Update League” to add your standings.'));
    return;
  }
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
  const host = $('#lineup');
  host.innerHTML = '';
  if (!f?.lineup?.length) { host.append(el('div', 'empty', '<strong>No lineup set</strong>')); return; }

  const assetIdx = new Map((state.data.assets?.assets ?? []).map((a) => [a.code, a]));
  const spend = f.lineup.reduce((s, l) => s + (l.price || 0), 0);
  const cap = f.budget?.cap ?? 100;

  const table = el('table');
  table.innerHTML =
    `<thead><tr><th>Asset</th><th>Role</th><th class="num">Price</th>
     <th class="num">Mean</th><th class="num">Sharpe</th><th>Form</th></tr></thead>`;
  const tb = el('tbody');
  for (const l of f.lineup) {
    const a = assetIdx.get(l.code);
    const tr = el('tr');
    tr.innerHTML =
      `<td><span class="team-chip ${cls(l.constructorId)}"><span class="team-bar"></span>
           <span class="strong">${esc(l.name)}</span></span></td>
       <td>${l.role === 'Constructor' ? '<span class="pill">Constructor</span>'
            : l.role.includes('DRS') ? `<span class="pill is-warning">${esc(l.role)}</span>` : 'Driver'}</td>
       <td class="num">$${(l.price ?? 0).toFixed(1)}M</td>
       <td class="num">${a ? a.avgPoints.toFixed(1) : '—'}</td>
       <td class="num">${a?.sharpe?.toFixed(2) ?? '—'}</td>
       <td></td>`;
    if (a) tr.lastElementChild.append(sparkline(a.perRound, {
      w: 72, h: 20, stroke: (a.momentum ?? 0) >= 0 ? 'var(--good)' : 'var(--critical)',
    }));
    tb.append(tr);
  }
  table.append(tb);
  host.append(scrollWrap(table));
  host.append(el('p', 'note',
    `Committed <strong>$${spend.toFixed(1)}M</strong> of $${cap.toFixed(1)}M · ` +
    `<span class="${spend > cap ? 'delta-down' : 'delta-up'}">$${(cap - spend).toFixed(1)}M ${spend > cap ? 'over cap' : 'free'}</span>`));
}

function renderChips() {
  const f = state.data.fantasy;
  const host = $('#chips');
  host.innerHTML = '';
  if (!f?.chips) { host.append(el('div', 'empty', '<strong>No chip data</strong>')); return; }

  const remaining = state.data.season?.roundsRemaining ?? 0;
  const row = el('div', 'chip-row');
  for (const c of f.chips.remaining ?? []) row.append(el('span', 'pill is-good', esc(c)));
  for (const c of f.chips.burned ?? []) row.append(el('span', 'pill is-burned', esc(c)));
  host.append(row);
  host.append(el('p', 'note',
    `<strong>${(f.chips.remaining ?? []).length} chips</strong> across <strong>${remaining} remaining rounds</strong>.`));

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

function renderChampionship() {
  const st = state.data.standings;
  const host = $('#championship');
  host.innerHTML = '';
  if (!st?.drivers?.length) { host.append(el('div', 'empty', '<strong>Standings unavailable</strong>')); return; }
  const mine = myCodes();

  const build = (title, rows, isDriver) => {
    const card = el('div', 'card');
    card.append(el('div', 'card-head', `<div class="card-title">${title}</div>
      <div class="card-meta">through R${st.throughRound}</div>`));
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
         <td class="num strong">${r.points}</td>
         <td class="num">${r.wins}</td>`;
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
       <td>${done ? '<span class="pill">Complete</span>'
            : isNext ? '<span class="pill is-accent">Next</span>' : '<span class="pill">Upcoming</span>'}</td>`;
    tb.append(tr);
  }
  table.append(tb);
  host.append(scrollWrap(table));
}

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
    ['Lineup & chips', 'Manual entry', 'manual', { fetchedAt: state.data.fantasy?.updatedAt, ok: true }],
  ];

  const table = el('table');
  table.innerHTML = `<thead><tr><th>Data</th><th>Source</th><th>Type</th><th>Status</th><th>Updated</th></tr></thead>`;
  const tb = el('tbody');
  for (const [what, src, type, s] of rows) {
    const ok = s?.ok !== false;
    const tr = el('tr');
    tr.innerHTML =
      `<td class="strong">${esc(what)}</td>
       <td>${esc(src)}</td>
       <td><span class="prov is-${type}">${type === 'live' ? 'Automated' : 'Manual'}</span></td>
       <td>${ok ? '<span class="pill is-good">OK</span>' : '<span class="pill is-critical">Failed</span>'}</td>
       <td>${esc(relativeTime(s?.fetchedAt))}</td>`;
    tb.append(tr);
  }
  table.append(tb);
  host.append(scrollWrap(table));
  host.append(el('p', 'note',
    'Every figure on this page is either fetched from a named public source or entered by hand and labelled as such. ' +
    'Nothing is hardcoded into the page — that was the defect that froze the previous version. ' +
    'Derived metrics (σ, Sharpe, points-per-$M, momentum) are computed from source data, not published by it.'));
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

  // Re-rank from points so the order can never contradict the numbers.
  standings.sort((a, b) => b.points - a.points).forEach((s, i) => { s.rank = i + 1; });
  const myTeam = (state.data.fantasy?.me?.teamName ?? '').toLowerCase();
  (standings.find((s) => s.team.toLowerCase() === myTeam) ?? standings[0]).isMe = true;

  const payload = {
    ...state.data.fantasy,
    standings,
    updatedThroughRound: Number($('#modal-round').value) || 0,
    updatedAt: new Date().toISOString(),
  };
  localStorage.setItem(LS_KEY, JSON.stringify(payload));
  state.data.fantasy = { ...payload, _local: true };
  $('#modal-backdrop').hidden = true;
  renderAll();
  toast('League updated locally. Use “Copy JSON” to persist it across devices.');
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

// ── boot ───────────────────────────────────────────────────
function renderAll() {
  // Each renderer is isolated: one throwing must not abort the rest.
  // (v1's entire boot sequence died on a single silent exception.)
  const steps = [
    ['banners', renderBanners], ['hero', renderHero], ['sessions', renderSessions],
    ['scenario', renderScenario], ['markets', renderMarkets], ['strategy', renderStrategy],
    ['consider', renderConsider], ['league', renderLeague], ['lineup', renderLineup],
    ['chips', renderChips], ['championship', renderChampionship],
    ['calendar', renderCalendar], ['provenance', renderProvenance],
  ];
  for (const [name, fn] of steps) {
    try { fn(); } catch (err) { console.error(`[render:${name}]`, err); }
  }
}

async function boot() {
  const saved = localStorage.getItem('f1mc.theme');
  if (saved) document.documentElement.dataset.theme = saved;

  await loadAll();
  renderAll();
  setInterval(tickCountdown, 1000);

  $('#btn-update').addEventListener('click', openModal);
  $('#btn-save').addEventListener('click', saveModal);
  $('#btn-copy').addEventListener('click', copyJSON);
  $('#btn-cancel').addEventListener('click', () => { $('#modal-backdrop').hidden = true; });
  $('#modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') $('#modal-backdrop').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('#modal-backdrop').hidden = true;
  });
  $('#btn-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('f1mc.theme', next);
  });
}

boot();
