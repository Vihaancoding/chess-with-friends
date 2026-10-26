// Chess bot: alpha-beta search over the shared engine (chess.js) for the computer opponents, and the analysis engine
// (engine.js) for everything that grades or scores positions.
// Runs as a Web Worker in the browser and as a plain module in Node (for tests).
let C, Style, E;
if (typeof importScripts === 'function') { importScripts('chess.js', 'style.js', 'engine.js'); C = self.Chess; Style = self.Style; E = self.Engine; }
else { C = require('./chess.js'); Style = require('./style.js'); E = require('./engine.js'); }

const VAL = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };
// Piece-square tables from White's point of view (index = row*8+col, row 0 = rank 8).
const T = {
  P: [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5, 0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
  N: [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30, -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
  B: [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10, -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
  R: [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
  Q: [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5, 0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
  K: [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10, 20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20],
  E: [-50,-40,-30,-20,-20,-30,-40,-50, -30,-20,-10,0,0,-10,-20,-30, -30,-10,20,30,30,20,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,20,30,30,20,-10,-30, -30,-30,0,0,0,0,-30,-30, -50,-30,-30,-30,-30,-30,-30,-50],
};

const INF = 1e6, MATE = 100000;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const STOP = { stop: true };
let nodes = 0, deadline = 0;

// Score from the side-to-move's point of view (centipawns).
function evaluate(st) {
  const b = st.board;
  let score = 0, nonPawn = 0, wm = 0, bm = 0, wk = -1, bk = -1;
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (!p) continue;
    const c = p[0], t = p[1];
    if (t === 'K') { if (c === 'w') wk = i; else bk = i; continue; }
    const v = VAL[t] + T[t][c === 'w' ? i : i ^ 56];
    if (c === 'w') { score += v; wm += VAL[t]; } else { score -= v; bm += VAL[t]; }
    if (t !== 'P') nonPawn += VAL[t];
  }
  const endgame = nonPawn <= 2400;
  const kt = endgame ? T.E : T.K;
  if (wk >= 0) score += kt[wk];
  if (bk >= 0) score -= kt[bk ^ 56];
  if (endgame && wk >= 0 && bk >= 0 && Math.abs(wm - bm) >= 300) {
    // Mop-up: with a big lead, drive the enemy king to the edge and bring our king closer.
    const win = wm > bm ? 1 : -1, lk = win > 0 ? bk : wk;
    const cd = Math.max(3 - (lk >> 3), (lk >> 3) - 4) + Math.max(3 - (lk & 7), (lk & 7) - 4);
    const dist = Math.abs((wk >> 3) - (bk >> 3)) + Math.abs((wk & 7) - (bk & 7));
    score += win * (cd * 10 + (14 - dist) * 4);
  }
  return st.turn === 'w' ? score : -score;
}

function order(st, moves) {
  const b = st.board;
  for (const m of moves) {
    let s = 0;
    const v = b[m.to] || (m.enPassant ? 'xP' : null);
    if (v) s = 1000 + 10 * VAL[v[1]] - VAL[b[m.from][1]] / 10;
    if (m.promo) s += 800 + VAL[m.promo];
    m._s = s;
  }
  moves.sort((x, y) => y._s - x._s);
}

function quiesce(st, alpha, beta, depth) {
  if ((++nodes & 255) === 0 && now() > deadline) throw STOP;
  const stand = evaluate(st);
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;
  if (depth <= 0) return alpha;
  const moves = C.legalMoves(st).filter((m) => st.board[m.to] || m.enPassant || m.promo);
  order(st, moves);
  for (const m of moves) {
    const sc = -quiesce(C.apply(st, m), -beta, -alpha, depth - 1);
    if (sc >= beta) return beta;
    if (sc > alpha) alpha = sc;
  }
  return alpha;
}

function negamax(st, depth, alpha, beta, ply) {
  if ((++nodes & 255) === 0 && now() > deadline) throw STOP;
  const moves = C.legalMoves(st);
  if (!moves.length) return C.inCheck(st, st.turn) ? -MATE + ply : 0;
  if (st.half >= 100) return 0;
  if (depth <= 0) {
    if (ply < 14 && C.inCheck(st, st.turn)) depth = 1;       // don't stop the search in the middle of a check
    else return quiesce(st, alpha, beta, 4);
  }
  order(st, moves);
  let best = -INF;
  for (const m of moves) {
    const sc = -negamax(C.apply(st, m), depth - 1, -beta, -alpha, ply + 1);
    if (sc > best) { best = sc; if (sc > alpha) { alpha = sc; if (alpha >= beta) break; } }
  }
  return best;
}

// level: { depth, ms, full (score every root move), margin (cp), random (chance of a plain random move) }
const LEVELS = {
  1: { depth: 1, ms: 600, full: true, margin: 200, random: 0.2 },
  2: { depth: 2, ms: 1200, full: true, margin: 50, random: 0.04 },
  3: { depth: 5, ms: 1800, full: false, margin: 0, random: 0 },
  4: { depth: 7, ms: 3000, full: false, margin: 0, random: 0 },
};
const plain = (m) => (m.promo ? { from: m.from, to: m.to, promo: m.promo } : { from: m.from, to: m.to });

function chooseMove(state, level, seen, msScale) {
  const cfg = typeof level === 'object' && level ? level : LEVELS[level] || LEVELS[2];   // an object is a custom strength (the adaptive coach)
  const moves = C.legalMoves(state);
  if (!moves.length) return null;
  nodes = 0;
  deadline = now() + cfg.ms * (msScale || 1);
  if (moves.length === 1) return { move: plain(moves[0]), depth: 0, nodes: 0 };
  if (cfg.random && Math.random() < cfg.random) return { move: plain(moves[Math.floor(Math.random() * moves.length)]), depth: 0, nodes: 0 };
  order(state, moves);

  // avoid walking into a threefold repetition when ahead; steer toward one when losing
  const adjust = (m, sc) => {
    if (!seen) return sc;
    const n = seen[C.key(C.apply(state, m))] || 0;
    if (n >= 2) return sc > 30 ? sc - 250 : sc < -150 ? sc + 250 : sc;
    return sc;
  };

  if (cfg.full) {
    let scored;
    try { scored = moves.map((m) => ({ m, s: adjust(m, -negamax(C.apply(state, m), cfg.depth - 1, -INF, INF, 1)) })); }
    catch (e) { if (e !== STOP) throw e; return { move: plain(moves[0]), depth: 0, nodes }; }
    const top = Math.max(...scored.map((x) => x.s));
    const pool = scored.filter((x) => x.s >= top - cfg.margin);
    return { move: plain(pool[Math.floor(Math.random() * pool.length)].m), depth: cfg.depth, nodes, score: top };
  }

  // iterative deepening with the previous best move searched first
  let best = moves[0], bestScore = 0, done = 0, list = moves.slice();
  for (let d = 1; d <= cfg.depth; d++) {
    try {
      let alpha = -INF, curBest = null, curScore = -INF;
      for (const m of list) {
        const sc = adjust(m, -negamax(C.apply(state, m), d - 1, -INF, -alpha, 1));
        if (sc > curScore) { curScore = sc; curBest = m; if (sc > alpha) alpha = sc; }
      }
      best = curBest; bestScore = curScore; done = d;
      list = [best].concat(list.filter((m) => m !== best));
      if (Math.abs(bestScore) > MATE - 100) break;            // forced mate found
    } catch (e) { if (e !== STOP) throw e; break; }
  }
  return { move: plain(best), depth: done, nodes, score: bestScore };
}

// ---------- game review: score the legal moves in a position (time-limited depth; depth 1 always completes) ----------
// opts (see engine.js): exact = false scores only the best two moves and opts.focus exactly (much deeper in the same time);
// history = earlier positions of the game, so lines that repeat one of them count as draws
function analyzePosition(state, ms, maxDepth = 24, opts) {
  const r = E.analyze(state, ms, maxDepth, opts, anT0);
  if (r.terminal) return r;
  return { best: plain(r.best), score: r.score, scores: r.scores.map((x) => ({ ...plain(x.m), s: x.s })), depth: r.depth, legal: r.legal, layers: r.layers };
}
var anT0 = 0;

// ---------- play against a style (the playstyle logic is in style.js; this file supplies the engine scores) ----------
const uciOf = (m) => C.sqName(m.from) + C.sqName(m.to) + (m.promo ? m.promo.toLowerCase() : '');
// every legal move with its score, for profiles and comparisons; layers: { uci: score } after search depths 1, 2, 3…
// (how the position looks to a player who sees one move ahead, two, three)
function scoreAll(state, ms, depth) {
  anT0 = now();
  const r = analyzePosition(state, ms, depth);
  if (r.terminal) return { bestScore: r.score, best: null, legal: 0, scores: [], layers: [] };
  const layers = r.layers.map((L) => { const o = {}; for (const x of L) o[uciOf(x.m)] = x.s; return o; });
  return { bestScore: r.score, best: uciOf(r.best), legal: r.legal, scores: r.scores.map((x) => ({ uci: uciOf(x), s: x.s })), layers };
}
// a profile from archived games; ms per position (0 = skip the engine: no move model, no mistakes)
function buildProfile(name, games, ms, onProgress) {
  return Style.profile(name, games, ms ? (st) => scoreAll(st, ms, Style.DEPTH) : null, onProgress);
}
// the clone's move: engine scores at depths 1-3, then the player's learned model picks one (and says how long to think)
function styledMove(state, P, opts = {}) {
  const a = scoreAll(state, Style.engineMs(P, opts.diff) * (opts.msScale || 1), Style.DEPTH);
  if (!a.legal) return null;
  if (opts.seen) {                                    // like the other bots: avoid a repetition draw when ahead, aim for one when losing
    const legal = C.legalMoves(state);
    for (const m of legal) {
      if ((opts.seen[C.key(C.apply(state, m))] || 0) < 2) continue;
      for (const L of a.layers) { const u = uciOf(m), x = L[u]; if (x != null) L[u] = x > 30 ? x - 250 : x < -150 ? x + 250 : x; }
    }
  }
  const c = Style.choose(state, a, P, opts);
  return c && { move: plain(c.move), why: c.why, think: c.think };
}
// after a clone game: score every position, and for the human's moves also what the profiled player would have played
function compareGame(states, hist, side, P, ms, onPly) {
  for (let i = 0; i < hist.length; i++) {
    // grading uses a deeper search; the prediction uses the profile's own search budget, like the model was trained on
    const a = scoreAll(states[i], ms, 4), h = hist[i], u = uciOf(h), played = a.scores.find((x) => x.uci === u);
    const out = { i, best: a.best, bestScore: a.bestScore, played: played ? played.s : null, legal: a.legal };
    if (states[i].turn === side && a.legal) {
      const p = Style.predict(states[i], scoreAll(states[i], Style.PROFILE_MS, Style.DEPTH), P, { ply: i, lastTo: i ? hist[i - 1].to : null, ownTo: i > 1 ? hist[i - 2].to : null });
      out.pred = p.move; out.top = p.top; out.predScore = (a.scores.find((x) => x.uci === p.move) || {}).s;
    }
    onPly(out);
  }
}

if (typeof importScripts === 'function') {
  self.onmessage = (e) => {
    if (e.data.type === 'analyze') {
      const { id, states, hist, ms, skipFinal } = e.data;
      // positions to analyze, in this order (default: the whole game from the start)
      const order = e.data.order || Array.from({ length: hist.length + (skipFinal ? 0 : 1) }, (_, i) => i);
      for (const i of order) {
        anT0 = now();
        const h = hist[i];
        // only the played move and the best two need exact scores, unless the caller wants every move (the coach)
        const r = analyzePosition(states[i], ms, 24, { exact: !!e.data.scores, focus: h ? [h] : [], history: states.slice(Math.max(0, i - 100), i) });
        const played = h && r.scores.find((x) => x.from === h.from && x.to === h.to && (x.promo || undefined) === (h.promo || undefined));
        self.postMessage({ id, i, n: hist.length, best: r.best, bestScore: r.terminal ? r.score : r.score, second: r.scores[1] ? r.scores[1].s : null,
          played: played ? played.s : null, legal: r.legal || 0, depth: r.depth, terminal: !!r.terminal, scores: e.data.scores ? r.scores : undefined });
      }
      self.postMessage({ id, done: true });
      return;
    }
    if (e.data.type === 'profile') {
      const { id, name, games, ms } = e.data;
      const P = buildProfile(name, games, ms, (done, total) => self.postMessage({ id, progress: [done, total] }));
      self.postMessage({ id, profile: P });
      return;
    }
    if (e.data.type === 'styled') {
      const { id, state, profile, opts } = e.data, t0 = now();
      const r = styledMove(state, profile, opts);
      self.postMessage({ id, move: r && r.move, why: r && r.why, think: r && r.think, ms: Math.round(now() - t0) });
      return;
    }
    if (e.data.type === 'compare') {
      const { id, states, hist, side, profile, ms } = e.data;
      compareGame(states, hist, side, profile, ms, (out) => self.postMessage({ id, ply: out, n: hist.length }));
      self.postMessage({ id, done: true });
      return;
    }
    const { id, state, level, seen } = e.data;
    const t0 = now();
    const r = chooseMove(state, level, seen);
    self.postMessage({ id, move: r && r.move, depth: r && r.depth, ms: Math.round(now() - t0) });
  };
} else {
  module.exports = { chooseMove, evaluate, LEVELS, analyzePosition, setT0: (t) => { anT0 = t; }, buildProfile, styledMove, compareGame, scoreAll };
}
