/* ============================================================
   F1 Mission Control · application layer
   ------------------------------------------------------------
   Contract: this file NEVER contains data. It loads /data/*.json,
   derives, and renders. v1 died because a snapshot got inlined into
   the page and silently diverged from the file the robots updated.
   If you find yourself pasting values here, stop — put them in /data.
   ============================================================ */

const DATA_FILES = ['season', 'calendar', 'standings', 'results', 'weather', 'fantasy', 'meta'];
const LS_KEY = 'f1mc.fantasy.override';

const state = { data: {}, errors: [] };

// ── utilities ──────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const cls = (id) => `c-${(id || 'unknown').replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
const HOUR = 36e5;

/** Wrap a wide table so it scrolls inside its own box, never the page. */
const scrollWrap = (node) => {
  const box = el('div', 'table-scroll');
  box.append(node);
  return box;
};

function fmtDateTime(iso, opts = {}) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    ...opts,
  });
}

function relativeTime(iso) {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 6e4);
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
  const d = Math.floor(ms / 864e5);
  const h = Math.floor((ms % 864e5) / 36e5);
  const m = Math.floor((ms % 36e5) / 6e4);
  const s = Math.floor((ms % 6e4) / 1000);
  return { d, h, m, s, ms };
}

function fmtCountdown(t) {
  if (!t) return 'LOCKED';
  if (t.d > 0) return `${t.d}d ${String(t.h).padStart(2, '0')}h ${String(t.m).padStart(2, '0')}m`;
  return `${String(t.h).padStart(2, '0')}h ${String(t.m).padStart(2, '0')}m ${String(t.s).padStart(2, '0')}s`;
}

const SESSION_LABELS = {
  fp1: 'Practice 1', fp2: 'Practice 2', fp3: 'Practice 3',
  sprintQualifying: 'Sprint Qualifying', sprint: 'Sprint',
  qualifying: 'Qualifying', race: 'Race',
};

// WMO weather codes → short human label
function wxLabel(code, precipProb) {
  if (code == null) return '—';
  if (code >= 95) return '⛈ Storm';
  if (code >= 80) return '🌧 Showers';
  if (code >= 61) return '🌧 Rain';
  if (code >= 51) return '🌦 Drizzle';
  if (code >= 45) return '🌫 Fog';
  if (code >= 3) return '☁️ Cloud';
  if (code >= 1) return '⛅ Part sun';
  return precipProb > 40 ? '🌦 Mixed' : '☀️ Clear';
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

  // Local edits from the Update League panel override the committed file.
  try {
    const override = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (override && override.updatedAt) {
      state.data.fantasy = { ...state.data.fantasy, ...override, _local: true };
    }
  } catch { /* ignore malformed local data */ }
}

// ── derived intelligence ───────────────────────────────────

/** Rolling form over the last N races: avg points, places gained, DNFs. */
function driverForm(n = 3) {
  const rounds = state.data.results?.rounds ?? [];
  const recent = rounds.slice(-n);
  const acc = new Map();

  for (const rd of recent) {
    for (const r of rd.results) {
      const cur = acc.get(r.code) ?? {
        code: r.code, name: r.name, constructorId: r.constructorId,
        constructor: r.constructor, points: 0, gained: 0, dnf: 0, starts: 0, best: 99,
      };
      cur.points += r.points;
      cur.gained += r.positionsGained;
      cur.starts += 1;
      cur.best = Math.min(cur.best, r.position);
      if (!/^(Finished|\+\d+ Lap)/.test(r.status)) cur.dnf += 1;
      acc.set(r.code, cur);
    }
  }

  return [...acc.values()]
    .map((d) => ({
      ...d,
      avgPoints: d.starts ? d.points / d.starts : 0,
      dnfRate: d.starts ? d.dnf / d.starts : 0,
      trend: d.points / Math.max(1, d.starts) >= 12 ? 'hot' : d.points > 0 ? 'steady' : 'cold',
    }))
    .sort((a, b) => b.avgPoints - a.avgPoints);
}

/** League gaps above and below me. */
function leagueContext() {
  const f = state.data.fantasy;
  if (!f?.standings?.length) return null;
  const sorted = [...f.standings].sort((a, b) => a.rank - b.rank);
  const meIdx = sorted.findIndex((s) => s.isMe);
  if (meIdx === -1) return null;
  const me = sorted[meIdx];
  return {
    me,
    above: meIdx > 0 ? sorted[meIdx - 1] : null,
    below: meIdx < sorted.length - 1 ? sorted[meIdx + 1] : null,
    gapAbove: meIdx > 0 ? sorted[meIdx - 1].points - me.points : null,
    gapBelow: meIdx < sorted.length - 1 ? me.points - sorted[meIdx + 1].points : null,
    total: sorted.length,
    sorted,
  };
}

/** Staleness: the check v1 never had. */
function stalenessReport() {
  const meta = state.data.meta;
  const season = state.data.season;
  const fantasy = state.data.fantasy;
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
    if (!s.ok) issues.push({ level: 'critical', title: `Source failed: ${name}`, text: s.error || 'Unknown error.' });
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

// ── renderers ──────────────────────────────────────────────

function renderBanners() {
  const host = $('#banners');
  host.innerHTML = '';
  const issues = stalenessReport();

  if (!issues.length) {
    const meta = state.data.meta;
    host.append(
      el('div', 'banner is-good',
        `<span class="banner-icon">✓</span><div class="banner-body">
           <div class="banner-title">All data current</div>
           <div class="banner-text">Automated sources refreshed ${esc(relativeTime(meta?.builtAt))}. League standings up to date.</div>
         </div>`)
    );
    return;
  }

  for (const i of issues) {
    host.append(
      el('div', `banner is-${i.level}`,
        `<span class="banner-icon">${i.level === 'critical' ? '⛔' : '⚠️'}</span>
         <div class="banner-body">
           <div class="banner-title">${esc(i.title)}</div>
           <div class="banner-text">${esc(i.text)}</div>
         </div>`)
    );
  }
}

function renderHero() {
  const season = state.data.season;
  const race = season?.nextRace;
  const ctx = leagueContext();

  if (!race) {
    $('#hero').innerHTML = '<div class="empty">Season complete — no upcoming race.</div>';
    return;
  }

  const flagSprint = race.isSprint ? ' · Sprint Weekend' : '';
  $('#hero-label').textContent = `Round ${race.round} of ${state.data.calendar?.races?.length ?? 22}`;
  $('#hero-race').textContent = race.name;
  $('#hero-sub').textContent =
    `${race.circuit} · ${race.locality}, ${race.country}${flagSprint}`;

  const stats = $('#hero-stats');
  stats.innerHTML = '';

  const mk = (label, value, note, noteClass = '') =>
    el('div', 'stat',
      `<div class="stat-label">${esc(label)}</div>
       <div class="stat-value">${value}</div>
       ${note ? `<div class="stat-note ${noteClass}">${note}</div>` : ''}`);

  if (ctx) {
    stats.append(mk('League Rank', `P${ctx.me.rank}`, `of ${ctx.total} teams`));
    stats.append(mk('Points', ctx.me.points.toLocaleString(), state.data.fantasy?._local ? 'locally edited' : `through R${state.data.fantasy.updatedThroughRound}`));
    stats.append(mk(
      'Gap Above',
      ctx.gapAbove == null ? '—' : `+${ctx.gapAbove}`,
      ctx.above ? esc(ctx.above.team) : 'league leader',
      ctx.gapAbove == null ? 'delta-up' : ''
    ));
    stats.append(mk('Gap Below', ctx.gapBelow == null ? '—' : `${ctx.gapBelow}`, ctx.below ? esc(ctx.below.team) : '—'));
  } else {
    stats.append(el('div', 'stat', '<div class="empty">No league data — use “Update League”.</div>'));
  }

  const chips = state.data.fantasy?.chips;
  if (chips) {
    stats.append(mk('Chips Left', String(chips.remaining?.length ?? 0), (chips.remaining ?? []).slice(0, 2).join(', ')));
  }

  const ft = state.data.fantasy?.freeTransfers;
  if (ft) {
    stats.append(mk('Free Transfers', `${ft.available}/${ft.of}`, ft.available === 0 ? 'points penalty applies' : 'no penalty'));
  }

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
  if (!race) { host.append(el('div', 'empty', 'No upcoming race.')); return; }

  const lockKey = race.sessions.sprintQualifying ? 'sprintQualifying' : 'qualifying';

  for (const [key, iso] of Object.entries(race.sessions)) {
    const w = wx?.sessions?.[key];
    const isLock = key === lockKey;
    const node = el('div', `session${isLock ? ' is-lock' : ''}`);
    node.innerHTML =
      `<div>
         <div class="session-name">${esc(SESSION_LABELS[key] ?? key)}${isLock ? ' <span class="pill is-critical">🔒 LOCK</span>' : ''}</div>
         <div class="session-time">${esc(fmtDateTime(iso))}</div>
       </div>
       <div class="wx">${w ? `${wxLabel(w.weatherCode, w.precipProbability)}` : '—'}</div>
       <div class="wx">${w ? `${Math.round(w.tempC)}°C · ${w.precipProbability}% 💧` : ''}</div>`;
    host.append(node);
  }
}

function renderScenario() {
  const wx = state.data.weather;
  const host = $('#scenario');
  host.innerHTML = '';
  if (!wx?.available) { host.append(el('div', 'empty', 'No forecast available.')); return; }

  const s = wx.scenario;
  const rows = [
    { label: 'Dry race', value: s.dryProb, fill: 'var(--series-4)' },
    { label: 'Wet race', value: s.wetProb, fill: 'var(--series-1)' },
    { label: 'Stoppage risk', value: s.haltProb, fill: 'var(--critical)' },
  ];

  for (const r of rows) {
    const row = el('div', 'bar-row');
    row.innerHTML =
      `<div class="bar-label">${esc(r.label)}</div>
       <div class="bar-track"><div class="bar-fill" style="width:${r.value}%; --fill:${r.fill}"></div></div>
       <div class="bar-value">${r.value}%</div>`;
    host.append(row);
  }

  const raceWx = wx.sessions?.race;
  if (raceWx) {
    host.append(el('p', 'bar-label',
      `Race-hour forecast at ${esc(wx.circuit)}: ${wxLabel(raceWx.weatherCode, raceWx.precipProbability)}, ` +
      `${Math.round(raceWx.tempC)}°C, ${raceWx.precipProbability}% chance of precipitation, wind ${Math.round(raceWx.windKph)} km/h.`));
  }
}

function renderLeague() {
  const ctx = leagueContext();
  const host = $('#league');
  host.innerHTML = '';
  if (!ctx) { host.append(el('div', 'empty', 'No league data yet — open “Update League” to add it.')); return; }

  const table = el('table');
  table.innerHTML =
    `<thead><tr><th>#</th><th>Team</th><th class="num">Points</th><th class="num">Gap to me</th></tr></thead>`;
  const tb = el('tbody');
  for (const t of ctx.sorted) {
    const gap = t.isMe ? '—' : (t.points - ctx.me.points > 0 ? `+${t.points - ctx.me.points}` : `${t.points - ctx.me.points}`);
    const tr = el('tr', t.isMe ? 'is-me' : '');
    tr.innerHTML =
      `<td><span class="pos pos-${t.rank}">${t.rank}</span></td>
       <td><strong>${esc(t.team)}</strong></td>
       <td class="num">${t.points.toLocaleString()}</td>
       <td class="num ${!t.isMe && t.points > ctx.me.points ? 'delta-down' : ''}">${gap}</td>`;
    tb.append(tr);
  }
  table.append(tb);
  host.append(table);
}

function renderChampionship() {
  const st = state.data.standings;
  const host = $('#championship');
  host.innerHTML = '';
  if (!st?.drivers?.length) { host.append(el('div', 'empty', 'Standings unavailable.')); return; }

  const mine = new Set((state.data.fantasy?.lineup ?? []).map((l) => l.code));

  const dWrap = el('div');
  dWrap.append(el('h3', 'bar-label', `<strong>Drivers</strong> · through Round ${st.throughRound}`));
  const dt = el('table');
  dt.innerHTML = `<thead><tr><th>#</th><th>Driver</th><th>Team</th><th class="num">Pts</th><th class="num">Wins</th></tr></thead>`;
  const dtb = el('tbody');
  for (const d of st.drivers.slice(0, 12)) {
    const tr = el('tr', mine.has(d.code) ? 'is-mine-driver' : '');
    tr.innerHTML =
      `<td><span class="pos pos-${d.position}">${d.position}</span></td>
       <td><span class="team-chip ${cls(d.constructorId)}"><span class="team-dot"></span><strong>${esc(d.code || d.surname)}</strong> ${esc(d.surname)}${mine.has(d.code) ? ' <span class="pill">yours</span>' : ''}</span></td>
       <td>${esc(d.constructor || '—')}</td>
       <td class="num"><strong>${d.points}</strong></td>
       <td class="num">${d.wins}</td>`;
    dtb.append(tr);
  }
  dt.append(dtb);
  dWrap.append(scrollWrap(dt));

  const cWrap = el('div');
  cWrap.append(el('h3', 'bar-label', `<strong>Constructors</strong> · through Round ${st.throughRound}`));
  const ct = el('table');
  ct.innerHTML = `<thead><tr><th>#</th><th>Team</th><th class="num">Pts</th><th class="num">Wins</th></tr></thead>`;
  const ctb = el('tbody');
  for (const c of st.constructors) {
    const tr = el('tr');
    tr.innerHTML =
      `<td><span class="pos pos-${c.position}">${c.position}</span></td>
       <td><span class="team-chip ${cls(c.constructorId)}"><span class="team-dot"></span>${esc(c.name)}</span></td>
       <td class="num"><strong>${c.points}</strong></td>
       <td class="num">${c.wins}</td>`;
    ctb.append(tr);
  }
  ct.append(ctb);
  cWrap.append(scrollWrap(ct));

  host.append(dWrap, cWrap);
}

function renderForm() {
  const form = driverForm(3);
  const host = $('#form');
  host.innerHTML = '';
  if (!form.length) { host.append(el('div', 'empty', 'Not enough completed rounds yet.')); return; }

  const mine = new Set((state.data.fantasy?.lineup ?? []).map((l) => l.code));
  const max = Math.max(...form.map((f) => f.avgPoints), 1);

  const table = el('table');
  table.innerHTML =
    `<thead><tr><th>Driver</th><th>Team</th><th class="num">Avg pts</th><th>Last 3</th><th class="num">Places ±</th><th class="num">DNF</th></tr></thead>`;
  const tb = el('tbody');
  for (const d of form.slice(0, 14)) {
    const tr = el('tr', mine.has(d.code) ? 'is-mine-driver' : '');
    const pct = Math.round((d.avgPoints / max) * 100);
    const trendPill =
      d.trend === 'hot' ? '<span class="pill is-good">🔥 Hot</span>'
      : d.trend === 'cold' ? '<span class="pill is-critical">❄️ Cold</span>'
      : '<span class="pill is-warning">➖ Steady</span>';
    tr.innerHTML =
      `<td><span class="team-chip ${cls(d.constructorId)}"><span class="team-dot"></span><strong>${esc(d.code)}</strong>${mine.has(d.code) ? ' <span class="pill">yours</span>' : ''}</span></td>
       <td>${esc(d.constructor)}</td>
       <td class="num"><strong>${d.avgPoints.toFixed(1)}</strong></td>
       <td><div class="bar-track" style="width:96px"><div class="bar-fill" style="width:${pct}%; --fill:var(--series-3)"></div></div></td>
       <td class="num ${d.gained > 0 ? 'delta-up' : d.gained < 0 ? 'delta-down' : ''}">${d.gained > 0 ? '+' : ''}${d.gained}</td>
       <td class="num">${d.dnf}</td>`;
    tb.append(tr);
  }
  table.append(tb);
  host.append(scrollWrap(table));
  host.append(el('p', 'bar-label',
    'Computed from the last three completed races. “Places ±” is grid position minus finishing position — the fantasy scoring lever most people ignore.'));
}

function renderLineup() {
  const f = state.data.fantasy;
  const host = $('#lineup');
  host.innerHTML = '';
  if (!f?.lineup?.length) { host.append(el('div', 'empty', 'No lineup set.')); return; }

  const spend = f.lineup.reduce((s, l) => s + (l.price || 0), 0);
  const form = new Map(driverForm(3).map((d) => [d.code, d]));

  const table = el('table');
  table.innerHTML = `<thead><tr><th>Slot</th><th>Role</th><th class="num">Price</th><th class="num">Avg pts (L3)</th></tr></thead>`;
  const tb = el('tbody');
  for (const l of f.lineup) {
    const fm = form.get(l.code);
    const tr = el('tr');
    tr.innerHTML =
      `<td><span class="team-chip ${cls(l.constructorId)}"><span class="team-dot"></span><strong>${esc(l.name)}</strong></span></td>
       <td>${l.role === 'Constructor' ? '<span class="pill">Constructor</span>' : l.role.includes('DRS') ? `<span class="pill is-warning">⚡ ${esc(l.role)}</span>` : 'Driver'}</td>
       <td class="num">$${(l.price ?? 0).toFixed(1)}M</td>
       <td class="num">${fm ? fm.avgPoints.toFixed(1) : '—'}</td>`;
    tb.append(tr);
  }
  table.append(tb);
  host.append(scrollWrap(table));

  const cap = f.budget?.cap ?? 100;
  host.append(el('p', 'bar-label',
    `Committed: <strong>$${spend.toFixed(1)}M</strong> of $${cap.toFixed(1)}M cap · ` +
    `<span class="${spend > cap ? 'delta-down' : 'delta-up'}">$${(cap - spend).toFixed(1)}M ${spend > cap ? 'over' : 'free'}</span>`));
}

function renderChips() {
  const f = state.data.fantasy;
  const host = $('#chips');
  host.innerHTML = '';
  if (!f?.chips) { host.append(el('div', 'empty', 'No chip data.')); return; }

  const remaining = state.data.season?.roundsRemaining ?? 0;
  const wrap = el('div');
  wrap.append(el('div', 'bar-label', '<strong>Your chips</strong>'));
  const row = el('div', '', '');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:7px;margin:8px 0 16px';
  for (const c of f.chips.remaining ?? []) row.append(el('span', 'pill is-good', `✓ ${esc(c)}`));
  for (const c of f.chips.burned ?? []) row.append(el('span', 'pill is-burned', `${esc(c)}`));
  wrap.append(row);

  wrap.append(el('div', 'bar-label',
    `<strong>${(f.chips.remaining ?? []).length} chips</strong> across <strong>${remaining} remaining rounds</strong>.`));

  const rivalWrap = el('div');
  rivalWrap.style.marginTop = '18px';
  rivalWrap.append(el('div', 'bar-label', '<strong>Rival chip intelligence</strong>'));
  const entries = Object.entries(f.rivalChips ?? {});
  if (!entries.length) {
    rivalWrap.append(el('div', 'empty', 'No rival chip data recorded.'));
  } else {
    for (const [team, c] of entries) {
      const r = el('div', '', '');
      r.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:9px';
      r.append(el('strong', 'bar-label', esc(team)));
      for (const b of c.burned ?? []) r.append(el('span', 'pill is-burned', esc(b)));
      for (const b of c.remaining ?? []) r.append(el('span', 'pill', esc(b)));
      rivalWrap.append(r);
    }
  }
  wrap.append(rivalWrap);
  host.append(wrap);
}

function renderDecisions() {
  const host = $('#decisions');
  host.innerHTML = '';
  const race = state.data.season?.nextRace;
  const wx = state.data.weather;
  const ctx = leagueContext();
  const form = driverForm(3);
  const items = [];

  if (race) {
    const lock = countdownParts(race.lockUTC);
    items.push({
      level: lock && lock.d < 2 ? 'critical' : 'warning',
      title: lock ? `Lineup locks in ${fmtCountdown(lock)}` : 'Lineup is locked',
      text: lock
        ? `${SESSION_LABELS[race.sessions.sprintQualifying ? 'sprintQualifying' : 'qualifying']} starts ${fmtDateTime(race.lockUTC)}. All transfers and chip decisions must be in before then.`
        : `Qualifying has begun for ${race.name}. No further changes possible.`,
    });
  }

  if (wx?.available && wx.scenario.wetProb >= 40) {
    items.push({
      level: 'warning',
      title: `${wx.scenario.wetProb}% chance of a wet race`,
      text: 'Wet races compress the field and reward overtakers and wet specialists. Positions-gained scoring becomes the dominant lever — favour drivers starting outside the top five with strong racecraft.',
    });
  } else if (wx?.available) {
    items.push({
      level: 'good',
      title: `Dry race likely (${wx.scenario.dryProb}%)`,
      text: 'Grid position should hold. Qualifying pace matters more than racecraft — weight the lineup toward front-row potential.',
    });
  }

  if (ctx?.gapAbove != null) {
    items.push({
      level: 'warning',
      title: `${ctx.gapAbove} points behind ${ctx.above.team}`,
      text: 'You need differential picks, not consensus ones. Matching the leader\'s lineup locks in the deficit — take controlled variance on a low-ownership driver.',
    });
  } else if (ctx) {
    items.push({
      level: 'good',
      title: `Leading by ${ctx.gapBelow ?? 0} points`,
      text: `Protect the lead. Mirror ${ctx.below?.team ?? 'the chasing team'}'s core picks so their upside can't outrun you, and save chips for a round where they must gamble first.`,
    });
  }

  const hot = form.filter((d) => d.trend === 'hot').slice(0, 3);
  if (hot.length) {
    items.push({
      level: 'good',
      title: `In form: ${hot.map((d) => d.code).join(', ')}`,
      text: hot.map((d) => `${d.code} averaging ${d.avgPoints.toFixed(1)} pts over the last 3 races`).join(' · ') + '.',
    });
  }

  const risky = form.filter((d) => d.dnf > 0).slice(0, 3);
  if (risky.length) {
    items.push({
      level: 'critical',
      title: `Reliability risk: ${risky.map((d) => d.code).join(', ')}`,
      text: risky.map((d) => `${d.code} has ${d.dnf} non-finish${d.dnf === 1 ? '' : 'es'} in the last 3`).join(' · ') +
            '. A DNF on a boosted driver is the single fastest way to lose a week.',
    });
  }

  if (!items.length) { host.append(el('div', 'empty', 'Not enough data to generate decisions.')); return; }

  for (const i of items) {
    const card = el('div', `banner is-${i.level}`);
    card.style.marginTop = '10px';
    card.innerHTML =
      `<span class="banner-icon">${i.level === 'critical' ? '⛔' : i.level === 'warning' ? '⚠️' : '✓'}</span>
       <div class="banner-body"><div class="banner-title">${esc(i.title)}</div><div class="banner-text">${esc(i.text)}</div></div>`;
    host.append(card);
  }
}

function renderCalendar() {
  const cal = state.data.calendar;
  const season = state.data.season;
  const host = $('#calendar');
  host.innerHTML = '';
  if (!cal?.races?.length) { host.append(el('div', 'empty', 'Calendar unavailable.')); return; }

  const table = el('table');
  table.innerHTML = `<thead><tr><th>R</th><th>Grand Prix</th><th>Circuit</th><th>Date</th><th>Status</th></tr></thead>`;
  const tb = el('tbody');
  for (const r of cal.races) {
    const done = r.round <= (season?.lastCompletedRound ?? 0);
    const isNext = r.round === season?.nextRound;
    const tr = el('tr', isNext ? 'is-me' : '');
    tr.innerHTML =
      `<td><span class="pos">${r.round}</span></td>
       <td><strong>${esc(r.shortName)}</strong>${r.isSprint ? ' <span class="pill is-warning">Sprint</span>' : ''}</td>
       <td>${esc(r.locality)}, ${esc(r.country)}</td>
       <td>${esc(new Date(r.raceStartUTC).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</td>
       <td>${done ? '<span class="pill">✓ Complete</span>' : isNext ? '<span class="pill is-critical">▶ Next</span>' : '<span class="pill">Upcoming</span>'}</td>`;
    tb.append(tr);
  }
  table.append(tb);
  host.append(scrollWrap(table));
}

function renderProvenance() {
  const meta = state.data.meta;
  const host = $('#provenance');
  host.innerHTML = '';

  const rows = [
    ['Race calendar & sessions', 'Jolpica-F1 API', 'live', meta?.sources?.calendar?.fetchedAt],
    ['Championship standings', 'Jolpica-F1 API', 'live', meta?.sources?.standings?.fetchedAt],
    ['Race results & form', 'Jolpica-F1 API', 'live', meta?.sources?.results?.fetchedAt],
    ['Session weather', 'Open-Meteo', 'live', meta?.sources?.weather?.fetchedAt],
    ['Fantasy league standings', 'Manual entry (no public API)', 'manual', state.data.fantasy?.updatedAt],
    ['Lineup & chips', 'Manual entry', 'manual', state.data.fantasy?.updatedAt],
  ];

  const table = el('table');
  table.innerHTML = `<thead><tr><th>Data</th><th>Source</th><th>Type</th><th>Last updated</th></tr></thead>`;
  const tb = el('tbody');
  for (const [what, src, type, at] of rows) {
    const tr = el('tr');
    tr.innerHTML =
      `<td><strong>${esc(what)}</strong></td>
       <td>${esc(src)}</td>
       <td><span class="prov is-${type}">${type === 'live' ? '🟢 Automated' : '🟡 Manual'}</span></td>
       <td>${esc(relativeTime(at))}</td>`;
    tb.append(tr);
  }
  table.append(tb);
  host.append(scrollWrap(table));
  host.append(el('p', 'bar-label',
    'Every figure on this page is either fetched from a named public API or entered by hand and labelled as such. ' +
    'Nothing is hardcoded into the page itself — that was the defect that froze the previous version.'));
}

// ── Update League panel ────────────────────────────────────
function openModal() {
  const f = state.data.fantasy ?? {};
  const season = state.data.season;
  $('#modal-round').value = season?.lastCompletedRound ?? f.updatedThroughRound ?? 0;

  const host = $('#standings-editor');
  host.innerHTML = '';
  const rows = f.standings?.length ? f.standings : Array.from({ length: 8 }, (_, i) => ({ rank: i + 1, team: '', points: 0, isMe: false }));

  rows.forEach((s, i) => {
    const row = el('div', 'standings-row');
    row.innerHTML =
      `<div class="bar-label" style="text-align:center">${i + 1}</div>
       <input type="text" value="${esc(s.team)}" placeholder="Team name" data-k="team">
       <input type="number" value="${s.points ?? 0}" placeholder="Pts" data-k="points">`;
    host.append(row);
  });

  $('#modal-backdrop').hidden = false;
}

function saveModal() {
  const rows = [...$('#standings-editor').children];
  const standings = rows
    .map((row, i) => {
      const get = (k) => $(`[data-k="${k}"]`, row)?.value ?? '';
      return { rank: i + 1, team: get('team').trim(), points: Number(get('points')) || 0, isMe: false };
    })
    .filter((s) => s.team);

  if (!standings.length) { alert('Add at least one team.'); return; }

  // Re-rank by points so the ranking can never contradict the numbers.
  standings.sort((a, b) => b.points - a.points).forEach((s, i) => { s.rank = i + 1; });

  const myTeam = (state.data.fantasy?.me?.teamName ?? '').toLowerCase();
  const meRow = standings.find((s) => s.team.toLowerCase() === myTeam) ?? standings[0];
  meRow.isMe = true;

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
  toast('League updated locally. Use “Copy JSON” to make it permanent.');
}

function copyJSON() {
  const payload = { ...state.data.fantasy };
  delete payload._local;
  navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
    .then(() => toast('Copied. Paste into data/fantasy.json and commit to persist across devices.'))
    .catch(() => toast('Copy failed — select the JSON manually.'));
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.cssText =
    'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:200;' +
    'background:var(--surface-3);color:var(--ink);padding:11px 17px;border-radius:10px;' +
    'border:1px solid var(--hairline);box-shadow:var(--shadow);font-size:.86rem;max-width:min(460px,92vw)';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.style.cssText = 'display:none'; }, 4200);
}

// ── boot ───────────────────────────────────────────────────
function renderAll() {
  // Each renderer is isolated: one throwing must not abort the rest.
  // (v1's entire boot sequence died on a single silent exception.)
  const steps = [
    ['banners', renderBanners], ['hero', renderHero], ['sessions', renderSessions],
    ['scenario', renderScenario], ['league', renderLeague], ['championship', renderChampionship],
    ['form', renderForm], ['lineup', renderLineup], ['chips', renderChips],
    ['decisions', renderDecisions], ['calendar', renderCalendar], ['provenance', renderProvenance],
  ];
  for (const [name, fn] of steps) {
    try { fn(); }
    catch (err) { console.error(`[render:${name}]`, err); }
  }
}

async function boot() {
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
  $('#btn-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('f1mc.theme', next);
  });

  const saved = localStorage.getItem('f1mc.theme');
  if (saved) document.documentElement.dataset.theme = saved;
}

boot();
