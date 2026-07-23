/* ============================================================
   Squad optimiser — shared by the live Team Builder (browser)
   and the backtest (pipeline), so the two can never drift apart.

   Exact, not heuristic. Enumerates every legal 5-driver
   combination once, records the best score achievable at each
   exact cost, then tests all constructor pairs against that
   table. C(22,5) = 26,334 combinations, which is small enough
   to solve outright rather than approximate.
   ============================================================ */

export const SQUAD = { drivers: 5, constructors: 2 };

/** Costs in tenths of a $M so budget comparisons stay integer-exact. */
const tenths = (v) => Math.round(v * 10);

/**
 * @param {object}   opts
 * @param {object[]} opts.drivers       assets with { price }
 * @param {object[]} opts.constructors  assets with { price }
 * @param {number}   opts.cap           budget cap in $M
 * @param {(a:object)=>number} opts.score  value being maximised
 * @returns {{drivers:object[], constructors:object[], total:number, cost:number}|null}
 */
export function optimiseSquad({ drivers, constructors, cap, score }) {
  const D = drivers.filter((d) => d.price > 0);
  const C = constructors.filter((c) => c.price > 0);
  if (D.length < SQUAD.drivers || C.length < SQUAD.constructors) return null;

  const capT = tenths(cap);

  // bestAtCost[c] = best driver-quintet score achievable at exactly cost c
  const bestAtCost = new Float64Array(capT + 1).fill(-Infinity);
  const pickAtCost = new Array(capT + 1).fill(null);

  const chosen = [];
  (function search(start, count, costT, total) {
    if (count === SQUAD.drivers) {
      if (total > bestAtCost[costT]) {
        bestAtCost[costT] = total;
        pickAtCost[costT] = chosen.slice();
      }
      return;
    }
    const need = SQUAD.drivers - count;
    for (let i = start; i <= D.length - need; i++) {
      const nc = costT + tenths(D[i].price);
      if (nc > capT) continue;          // cannot afford this driver here
      chosen.push(D[i]);
      search(i + 1, count + 1, nc, total + score(D[i]));
      chosen.pop();
    }
  })(0, 0, 0, 0);

  // Prefix maximum: best quintet at cost ≤ c, carrying its picks forward.
  const prefBest = new Float64Array(capT + 1).fill(-Infinity);
  const prefPick = new Array(capT + 1).fill(null);
  let run = -Infinity, runPick = null;
  for (let c = 0; c <= capT; c++) {
    if (bestAtCost[c] > run) { run = bestAtCost[c]; runPick = pickAtCost[c]; }
    prefBest[c] = run;
    prefPick[c] = runPick;
  }

  let best = null;
  for (let i = 0; i < C.length; i++) {
    for (let j = i + 1; j < C.length; j++) {
      const pairCost = tenths(C[i].price) + tenths(C[j].price);
      const remain = capT - pairCost;
      if (remain < 0 || !prefPick[remain]) continue;
      const total = prefBest[remain] + score(C[i]) + score(C[j]);
      if (!best || total > best.total) {
        best = { total, drivers: prefPick[remain], constructors: [C[i], C[j]] };
      }
    }
  }
  if (!best) return null;

  const squad = [...best.drivers, ...best.constructors];
  return {
    ...best,
    squad,
    cost: squad.reduce((s, a) => s + a.price, 0),
  };
}

/** Sum an arbitrary per-asset value across a squad. */
export const squadSum = (squad, valueOf) => squad.reduce((s, a) => s + (valueOf(a) || 0), 0);
