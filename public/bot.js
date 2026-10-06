// Chess bot: alpha-beta search over the shared engine (chess.js).
// Runs as a Web Worker in the browser and as a plain module in Node (for tests).
let C;
if (typeof importScripts === 'function') { importScripts('chess.js'); C = self.Chess; }
else C = require('./chess.js');

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
  const cfg = LEVELS[level] || LEVELS[2];
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

// ---------- game review: score every legal move in a position (exact root scores, time-limited depth) ----------
function analyzePosition(state, ms) {
  const moves = C.legalMoves(state);
  if (!moves.length) return { terminal: true, best: null, scores: [], depth: 0, score: C.inCheck(state, state.turn) ? -MATE : 0 };
  order(state, moves);
  let scored = null, depth = 0;
  for (let d = 1; d <= 12; d++) {
    nodes = 0;
    deadline = d === 1 ? Infinity : anT0 + ms;             // depth 1 always completes
    try {
      const sc = moves.map((m) => ({ m, s: -negamax(C.apply(state, m), d - 1, -INF, INF, 1) }));
      sc.sort((a, b) => b.s - a.s);
      scored = sc; depth = d;
      moves.sort((a, b) => sc.findIndex((x) => x.m === a) - sc.findIndex((x) => x.m === b));
      if (Math.abs(sc[0].s) > MATE - 1000) break;          // forced mate found
    } catch (e) { if (e !== STOP) throw e; break; }
  }
  return { best: plain(scored[0].m), score: scored[0].s, scores: scored.map((x) => ({ ...plain(x.m), s: x.s })), depth, legal: moves.length };
}
var anT0 = 0;

if (typeof importScripts === 'function') {
  self.onmessage = (e) => {
    if (e.data.type === 'analyze') {
      const { id, states, hist, ms, skipFinal } = e.data;
      for (let i = 0; i <= hist.length - (skipFinal ? 1 : 0); i++) {
        anT0 = now();
        const r = analyzePosition(states[i], ms);
        const h = hist[i];
        const played = h && r.scores.find((x) => x.from === h.from && x.to === h.to && (x.promo || undefined) === (h.promo || undefined));
        self.postMessage({ id, i, n: hist.length, best: r.best, bestScore: r.terminal ? r.score : r.score, second: r.scores[1] ? r.scores[1].s : null,
          played: played ? played.s : null, legal: r.legal || 0, depth: r.depth, terminal: !!r.terminal });
      }
      self.postMessage({ id, done: true });
      return;
    }
    const { id, state, level, seen } = e.data;
    const t0 = now();
    const r = chooseMove(state, level, seen);
    self.postMessage({ id, move: r && r.move, depth: r && r.depth, ms: Math.round(now() - t0) });
  };
} else {
  module.exports = { chooseMove, evaluate, LEVELS, analyzePosition, setT0: (t) => { anT0 = t; } };
}
