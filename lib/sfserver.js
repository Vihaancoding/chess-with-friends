// Stockfish 19 (lite, single thread, WebAssembly: the same files the browser uses, in public/stockfish/) running on the
// server for the fair-play check. Same result shape as lib/fairplay.js scanGame, but judged by a far stronger engine.
// Searches run one at a time; the engine is created on first use and reused.
const path = require('path');
const Chess = require('../public/chess.js');
const Fair = require('./fairplay');

const FILE = path.join(__dirname, '..', 'public', 'stockfish', 'stockfish-19-lite-single.js');
const DEPTH = +process.env.FAIR_SF_DEPTH || 12;
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
function wait(until, _ok, cmd, ms = 20000) {
  return new Promise((resolve, reject) => {
    lines = [];
    const timer = setTimeout(() => { waiter = null; reject(new Error('stockfish timed out')); }, ms);
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
    const out = await wait(/^bestmove/, null, `go depth ${DEPTH}${extra || ''}`);
    return scoreOf(out);
  }).then(res, rej).catch(() => {});
});

// One game, one side (as scanGame). hist: [{ from, to, promo }], mt: ms per ply. Only the last moves when opts.from is set.
async function scanGame(hist, color, mt, opts = {}) {
  let st = Chess.initial();
  const uci = [];
  let n = 0, hits = 0, loss = 0;
  const times = [];
  for (let i = 0; i < hist.length; i++) {
    const legal = Chess.legalMoves(st), h = hist[i];
    const m = legal.find((x) => x.from === h.from && x.to === h.to && (x.promo || null) === (h.promo || null));
    if (!m) break;
    const u = uciOf(m);
    if (st.turn === color && i >= Fair.SKIP_PLIES && i >= (opts.from || 0) && legal.length > 1) {
      const best = await search(uci);                                         // the engine's choice and its score (for the side to move)
      if (best.cp !== null && Math.abs(best.cp) < DECIDED) {
        n++;
        let lost = 0;
        if (best.best === u) hits++;
        else {
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
module.exports = { scanGame, bestMove: (moves) => search(moves).then((r) => r.best), DEPTH };
