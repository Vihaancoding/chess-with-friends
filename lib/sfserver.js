// Stockfish 19 (lite, single thread, WebAssembly: the same files the browser uses, in public/stockfish/) running on the
// server for the fair-play check. Same result shape as lib/fairplay.js scanGame, but judged by a far stronger engine.
// Searches run one at a time; the engine is created on first use and reused.
const path = require('path');
const Chess = require('../public/chess.js');
const Fair = require('./fairplay');

const FILE = path.join(__dirname, '..', 'public', 'stockfish', 'stockfish-19-lite-single.js');
const DEPTH = +process.env.FAIR_SF_DEPTH || 14;
// The wasm engine runs on the server's only thread: while it searches, no other request is answered. Cap each search's
// work and each scan's total time so a check never stalls the server or runs past the function's time limit.
const NODES = +process.env.FAIR_SF_NODES || 60000;
const BUDGET = +process.env.FAIR_SF_BUDGET_MS || 3000;
const breathe = () => new Promise((r) => setImmediate(r));
const DECIDED = 600, MAX_LOSS = 500;
let eng = null, ready = null, lines = [], waiter = null, chain = Promise.resolve();

function boot() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    try {
      // the engine's Node shim sets the global fetch to null, which would break every other request: keep ours
      const realFetch = globalThis.fetch;
      if (realFetch) Object.defineProperty(globalThis, 'fetch', { get: () => realFetch, set: () => {}, configurable: true, enumerable: true });
      eng = require(FILE)();
      eng.listener = (l) => { l = String(l); lines.push(l); if (waiter && waiter.test(l)) { const w = waiter; waiter = null; w.done(); } };
      send('uci'); send('setoption name Threads value 1'); send('setoption name Hash value 16');
      wait(/^readyok/, null, 'isready').then(() => resolve(), reject);
    } catch (e) { reject(e); }
  });
  ready.catch(() => { ready = null; eng = null; });
  return ready;
}
const send = (c) => eng.processCommand(c);
// send a command, then resolve when a line matching `until` arrives (with a time limit)
function wait(until, _ok, cmd, ms = +process.env.FAIR_SF_TIMEOUT_MS || 20000) {
  return new Promise((resolve, reject) => {
    lines = [];
    const timer = setTimeout(() => { waiter = null; try { send('stop'); } catch (e) { /* the engine is gone */ } reject(new Error('stockfish timed out')); }, ms);
    waiter = { test: (l) => until.test(l), done: () => { clearTimeout(timer); resolve(lines.slice()); } };
    send(cmd);
  });
}
const uciOf = (m) => 'abcdefgh'[m.from & 7] + (8 - (m.from >> 3)) + 'abcdefgh'[m.to & 7] + (8 - (m.to >> 3)) + (m.promo ? m.promo.toLowerCase() : '');
function scoreOf(ls) {
  let cp = null;
  for (const l of ls) { const m = /score (cp|mate) (-?\d+)/.exec(l); if (m && /^info depth/.test(l)) cp = m[1] === 'cp' ? +m[2] : (+m[2] > 0 ? 10000 : -10000); }
  const b = ls.find((l) => l.startsWith('bestmove'));
  return { cp, best: b ? b.split(' ')[1] : null };
}
const search = (moves, extra) => new Promise((res, rej) => {
  chain = chain.then(async () => {
    await boot();
    send('ucinewgame');
    send(`position startpos${moves.length ? ' moves ' + moves.join(' ') : ''}`);
    const out = await wait(/^bestmove/, null, `go depth ${DEPTH} nodes ${NODES}${extra || ''}`);
    return scoreOf(out);
  }).then(res, rej).catch(() => {});
});

// ---------- MultiPV analysis (the detector's raw material) ----------
// One search with several principal variations: the engine's top choices and their scores for the side to move, and
// optionally the score of one specific move (searched on its own when it is not among the top choices).
const MULTIPV = +process.env.FAIR_SF_MULTIPV || 3;
const ANALYSIS_DEPTH = +process.env.FAIR_AN_DEPTH || 12;        // MultiPV search costs far more per ply than a single line: depth 12 is about 0.12 s a position
function linesOf(ls) {
  const by = {};
  for (const l of ls) {
    const m = /^info depth (\d+) .*?multipv (\d+) score (cp|mate) (-?\d+).* pv (\S+)/.exec(l);
    if (m) by[m[2]] = { move: m[5], cp: m[3] === 'cp' ? +m[4] : (+m[4] > 0 ? 10000 - +m[4] : -10000 - +m[4]), depth: +m[1] };
  }
  return Object.keys(by).sort((a, b) => a - b).map((k) => by[k]);
}
function runAnalysis(moves, { depth = ANALYSIS_DEPTH, multipv = MULTIPV, only = null, fresh = false } = {}) {
  return new Promise((res, rej) => {
    chain = chain.then(async () => {
      await boot();
      if (fresh) send('ucinewgame');
      send(`setoption name MultiPV value ${only ? 1 : multipv}`);
      send(`position startpos${moves.length ? ' moves ' + moves.join(' ') : ''}`);
      const out = await wait(/^bestmove/, null, `go depth ${depth}${only ? ' searchmoves ' + only : ''}`);
      return linesOf(out);
    }).then(res, rej).catch(() => {});
  });
}
// the analysis of one position: lines (best first), the played move's rank among them (0 = outside) and its score
async function analysePosition(moves, played, opts = {}) {
  const lines = await runAnalysis(moves, opts);
  if (!lines.length) return null;
  let idx = lines.findIndex((l) => l.move === played);
  let cp;
  if (idx >= 0) cp = lines[idx].cp;
  else { const one = await runAnalysis(moves, { ...opts, only: played }); cp = one.length ? one[0].cp : lines[lines.length - 1].cp; }
  return { lines, rank: idx + 1, playedCp: cp };
}

// One game, every position for the sides asked: [{ i, c, u, ev, rank, loss, gap, nl, tact, t }] with the engine's view.
// cache: { [ply]: row } filled as it goes, so a repeat call (or one that was cut short) never analyses a position twice.
// budgetMs stops early; the rows done so far are kept in the cache and the call returns { rows, done }.
async function analyseGame(hist, { mt = null, from = 0, colors = ['w', 'b'], depth = ANALYSIS_DEPTH, multipv = MULTIPV, cache = {}, budgetMs = 0, skip = Fair.SKIP_PLIES } = {}) {
  let st = Chess.initial();
  const uci = [], t0 = Date.now(), rows = [];
  let done = true, first = true;
  for (let i = 0; i < hist.length; i++) {
    const legal = Chess.legalMoves(st), h = hist[i];
    const m = legal.find((x) => x.from === h.from && x.to === h.to && (x.promo || null) === (h.promo || null));
    if (!m) break;
    const u = uciOf(m);
    if (i >= skip && i >= from && colors.includes(st.turn) && legal.length > 1) {
      let row = cache[i];
      if (!row || row.d < depth) {
        if (budgetMs && Date.now() - t0 > budgetMs) { done = false; break; }
        const a = await analysePosition(uci, u, { depth, multipv, fresh: first });
        first = false;
        if (!a) { uci.push(u); st = Chess.apply(st, m); continue; }
        const best = a.lines[0], second = a.lines[1];
        const tgt = st.board[m.to], bm = legal.find((x) => uciOf(x) === best.move);
        const tact = !!((bm && (st.board[bm.to] || bm.promo)) || (second && best.cp - second.cp >= 150) || (i > 0 && row === undefined && false));
        row = { i, c: st.turn, u, ev: best.cp, rank: a.rank, loss: Math.max(0, Math.min(1000, best.cp - a.playedCp)), gap: second ? Math.min(500, Math.max(0, best.cp - second.cp)) : 500, nl: legal.length, tact, d: depth };
        cache[i] = row;
      }
      rows.push({ ...row, t: mt && mt[i] > 0 ? mt[i] : null });
    }
    uci.push(u);
    st = Chess.apply(st, m);
  }
  return { rows, done };
}

// One game, one side (as scanGame). hist: [{ from, to, promo }], mt: ms per ply. Only the last moves when opts.from is set.
async function scanGame(hist, color, mt, opts = {}) {
  let st = Chess.initial();
  const uci = [];
  let n = 0, hits = 0, loss = 0;
  const times = [];
  const t0 = Date.now();
  for (let i = 0; i < hist.length; i++) {
    if (Date.now() - t0 > BUDGET) break;                                     // out of time: judge what was checked
    const legal = Chess.legalMoves(st), h = hist[i];
    const m = legal.find((x) => x.from === h.from && x.to === h.to && (x.promo || null) === (h.promo || null));
    if (!m) break;
    const u = uciOf(m);
    if (st.turn === color && i >= Fair.SKIP_PLIES && i >= (opts.from || 0) && legal.length > 1) {
      await breathe();                                                        // let waiting requests through between searches
      const best = await search(uci);                                         // the engine's choice and its score (for the side to move)
      if (best.cp !== null && Math.abs(best.cp) < DECIDED) {
        n++;
        let lost = 0;
        if (best.best === u) hits++;
        else {
          await breathe();
          const mine = await search(uci, ` searchmoves ${u}`);
          lost = Math.max(0, best.cp - (mine.cp === null ? best.cp : mine.cp));
          if (lost <= 5) hits++;                                              // an equal move counts as the engine's choice
        }
        loss += Math.min(MAX_LOSS, lost);
        if (mt && mt[i] > 0) times.push(mt[i]);
      }
    }
    uci.push(u);
    st = Chess.apply(st, m);
  }
  if (n < 8) return null;
  let cv = null;
  if (times.length >= 8) {
    const avg = times.reduce((s, x) => s + x, 0) / times.length;
    const sd = Math.sqrt(times.reduce((s, x) => s + (x - avg) ** 2, 0) / times.length);
    cv = avg ? Math.round((sd / avg) * 100) / 100 : null;
  }
  return { n, match: Math.round((hits / n) * 100), acpl: Math.round(loss / n), cv, engine: 'stockfish' };
}
module.exports = { scanGame, analyseGame, analysePosition, runAnalysis, uciOf, bestMove: (moves) => search(moves).then((r) => r.best), DEPTH, ANALYSIS_DEPTH, MULTIPV };
