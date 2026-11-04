// Engine analysis for The Damage Report: the evaluation of every position of a finished game, as the white side sees
// it (centipawns, mate scores as +-(100000 - plies to mate)). It runs in slices that fit a serverless time limit; the
// caller keeps the partial result and calls again, so a game is never analysed twice and a slow or failed run only
// delays the final score. The same engine as the in-browser game review (public/engine.js).
const Engine = require('../public/engine.js');

const DEPTH = +process.env.DAMAGE_DEPTH || 5, PER_MOVE_MS = +process.env.DAMAGE_MOVE_MS || 300;

// state: { ev: [], best: [] } so far; positions: the position after 0, 1, 2… moves. Returns the same, plus done.
async function analyseSlice(positions, state, budgetMs, hooks = {}) {
  const t0 = Date.now(), ev = (state && state.ev ? state.ev.slice() : []), best = (state && state.best ? state.best.slice() : []);
  if (!ev.length) Engine.clear();
  const C = require('../public/chess.js');
  while (ev.length < positions.length) {
    if (ev.length && Date.now() - t0 > budgetMs) break;                   // always make some progress
    const i = ev.length, st = positions[i];
    if (hooks && hooks.beforeMove) await hooks.beforeMove(i);              // a hook for tests: failures and slowness
    await new Promise((r) => setImmediate(r));                            // let other requests through between positions
    const r = Engine.analyze(st, PER_MOVE_MS, DEPTH);
    const sc = r.score * (st.turn === 'w' ? 1 : -1);
    ev.push(sc);
    best.push(r.best ? C.sqName(r.best.from) + C.sqName(r.best.to) + (r.best.promo ? r.best.promo.toLowerCase() : '') : '');
  }
  return { ev, best, done: ev.length >= positions.length };
}

module.exports = { analyseSlice, DEPTH };
