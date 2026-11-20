// Move stats (brilliant moves, blunders, accuracy...) for EVERY finished game, judged by Stockfish.
// evalGame() gives the engine's evaluation of each position of a game (centipawns from White's side, mates on the Damage
// Report's scale), in slices that fit a time limit and resume where they stopped. Dmg.moveStats() turns those evaluations
// into one rating per move; lib/app.js adds them to the players' totals and keeps the notable moves so a number can be opened.
// Every position is searched at DEPTH. A move that looks like a mistake or a blunder is then checked again, deeper (VERIFY_DEPTH):
// a shallow search often misses the tactic that makes a "blunder" fine, and a wrong blunder count is worse than a slow one.
// The engine runs only where the fair-play worker runs (api/fairplay.js on Vercel, the same process locally).
const Chess = require('../public/chess.js');
const Sf = require('./sfserver');
const Dmg = require('./damage');

const DEPTH = +process.env.STATS_SF_DEPTH || 12, VERIFY_DEPTH = +process.env.STATS_SF_VERIFY_DEPTH || 16, VERIFY_MAX = 4;
const uciOf = (h) => 'abcdefgh'[h.from & 7] + (8 - (h.from >> 3)) + 'abcdefgh'[h.to & 7] + (8 - (h.to >> 3)) + (h.promo ? String(h.promo).toLowerCase() : '');

// the White-side score of the position after `i` moves
async function scoreAt(uci, i, st, depth, deps, fresh) {
  const over = Chess.status(st);
  if (over.over) return over.reason === 'checkmate' ? (over.result === 'w' ? Dmg.MATE : -Dmg.MATE) : 0;
  if (i === 0) return 20;
  const lines = await (deps.analyse || Sf.runAnalysis)(uci.slice(0, i), { depth, multipv: 1, fresh });
  if (!lines || !lines.length) throw new Error('no engine answer');
  const cp = lines[0].cp, mate = Math.abs(cp) >= 9000, side = st.turn === 'w' ? 1 : -1;
  return side * (mate ? Math.sign(cp) * (Dmg.MATE - (10000 - Math.abs(cp))) : cp);
}

// state: { ev: [], ref: [] } so far. Returns { ev, ref, done }.
async function evalGame(hist, state, budgetMs, deps = {}) {
  const ev = ((state && state.ev) || []).slice(), ref = ((state && state.ref) || []).slice(), t0 = Date.now(), uci = hist.map(uciOf);
  const out = () => Date.now() - t0 > budgetMs && budgetMs;
  const states = [Chess.initial()];
  for (let k = 0; k < hist.length; k++) states.push(Chess.apply(states[k], Chess.findUci(states[k], uci[k])));
  // 1. every position
  while (ev.length <= hist.length) {
    if (ev.length && out()) return { ev, ref, done: false };                       // always make some progress
    const i = ev.length;
    await new Promise((r) => setImmediate(r));
    ev.push(await scoreAt(uci, i, states[i], deps.depth || DEPTH, deps, i === 1));
  }
  // 2. the moves that look like mistakes or blunders, again at a greater depth (the ones near them were already searched)
  const rep = Dmg.replay(hist);
  for (let round = 0; round < VERIFY_MAX; round++) {
    const bad = Dmg.moveStats(rep, ev).list.filter((x) => (x.kind === 'mistake' || x.kind === 'blunder') && !(ref.includes(x.i - 1) && ref.includes(x.i))).sort((a, b) => b.loss - a.loss)[0];
    if (!bad) break;
    for (const j of [bad.i - 1, bad.i]) {
      if (ref.includes(j)) continue;
      if (out()) return { ev, ref, done: false };
      ev[j] = await scoreAt(uci, j, states[j], deps.verifyDepth || VERIFY_DEPTH, deps, false);
      ref.push(j);
    }
  }
  return { ev, ref, done: true };
}

// What a game still needs, for counting done outside the server (in a player's browser). state: { ev, ref, rounds } so far, with null for
// positions not searched yet. Returns { ev, ref, rounds, need: [position numbers to search], verify (search them deeper), done }.
function plan(hist, state) {
  const ev = Array.from({ length: hist.length + 1 }, (_, i) => (state && state.ev && state.ev[i] != null ? state.ev[i] : null)), ref = ((state && state.ref) || []).slice(), rounds = (state && state.rounds) || 0;
  const uci = hist.map(uciOf), states = [Chess.initial()];
  for (let k = 0; k < hist.length; k++) states.push(Chess.apply(states[k], Chess.findUci(states[k], uci[k])));
  for (let i = 0; i <= hist.length; i++) {
    if (ev[i] != null) continue;
    if (i === 0) ev[i] = 20;
    else { const over = Chess.status(states[i]); if (over.over) ev[i] = over.reason === 'checkmate' ? (over.result === 'w' ? Dmg.MATE : -Dmg.MATE) : 0; }
  }
  const need = []; for (let i = 0; i <= hist.length; i++) if (ev[i] == null) need.push(i);
  if (need.length) return { ev, ref, rounds, need, verify: false, done: false };
  if (rounds < VERIFY_MAX) {
    const bad = Dmg.moveStats(Dmg.replay(hist), ev).list.filter((x) => (x.kind === 'mistake' || x.kind === 'blunder') && !(ref.includes(x.i - 1) && ref.includes(x.i))).sort((a, b) => b.loss - a.loss)[0];
    if (bad) return { ev, ref, rounds, need: [bad.i - 1, bad.i].filter((j) => !ref.includes(j)), verify: true, done: false };
  }
  return { ev, ref, rounds, need: [], verify: false, done: true };
}

module.exports = { evalGame, plan, DEPTH, VERIFY_DEPTH, VERIFY_MAX, uciOf };
