// LIVE TUNE-IN: how exciting is a live game, from Stockfish evaluations sent in by browsers.
// The server never runs an engine. A browser that is watching a public game analyses it with its own Stockfish and sends
// one evaluation per position (White's point of view, centipawns). This file checks those numbers and turns them into a
// 0-100 score, events and a ranking. Pure functions: nothing here reads or writes the store (lib/app.js does that).
// The score uses only the game itself: evaluation swings, comebacks, sacrifices, meaningful blunders, close and attacking
// positions, time scrambles and sustained intensity. Ratings and viewer counts are never inputs.
const Chess = require('../public/chess.js');

const MATE_CP = 10000;          // every forced mate is stored as this (the sign says who mates)
const MATE_FLOOR = 90000;       // engines report mates as 100000 - plies: anything this big is a mate
const MAX_CP = 100000;          // larger numbers are not evaluations
const MAX_JUMP = 1500;          // one move never moves the evaluation this much unless a mate is involved
const MAX_CLK = 86400e3;        // a clock reading above a day is not a clock
const MAX_PLIES = 400;          // longer games keep their first MAX_PLIES positions: enough to judge the game
const FRESH_MS = 60e3;          // an analysis older than this is stale: shown as paused, never ranked
const LEASE_MS = 45e3;          // one browser at a time per game; the lease must be renewed by each batch
const EVENT_GAP = 8;            // plies between two events of the same kind in one game
const EVENT_COOLDOWN_MS = 90e3; // and the same, in time
const KEEP_EVENTS = 12;
const VAL = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
const SCRAMBLE_MS = 10e3, SCRAMBLE_PLIES = 8, SWING_MIN = 300;

const sq = (i) => 'abcdefgh'[i & 7] + (8 - (i >> 3));
const uciOf = (h) => sq(h.from) + sq(h.to) + (h.promo ? String(h.promo).toLowerCase() : '');
const isMate = (cp) => Math.abs(cp) === MATE_CP;

// An engine score (side to move's view, mates on the 100000 scale) as stored: White's view, mates as MATE_CP.
// Returns null when the number is not an evaluation at all.
function normalise(cp, sideToMove) {
  if (!Number.isInteger(cp) || Math.abs(cp) > MAX_CP) return null;
  const white = sideToMove === 'b' ? -cp : cp;
  if (Math.abs(white) >= MATE_FLOOR) return Math.sign(white) * MATE_CP;
  return white;
}

// Accept the longest prefix of a batch that looks like real evaluations, starting after `prev` (the last stored one).
// Returns { ok: [values], rejected: count of values after the first implausible one }.
function checkBatch(prev, values) {
  const ok = [];
  let last = prev;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isInteger(v) || Math.abs(v) > MATE_CP) return { ok, rejected: values.length - i };
    if (last != null && Math.abs(v - last) > MAX_JUMP && !isMate(v) && !isMate(last)) return { ok, rejected: values.length - i };
    ok.push(v); last = v;
  }
  return { ok, rejected: 0 };
}

const material = (st, side) => {
  let m = 0;
  for (const p of st.board) if (p && p[0] === side) m += VAL[p[1]] || 0;
  return m;
};

const balance = (st, side) => material(st, side) - material(st, side === 'w' ? 'b' : 'w');

// The game's states: states[i] is the position after i moves. Null if a move in the list is not legal.
function replay(hist) {
  const states = [Chess.initial()];
  for (const h of hist) {
    const st = states[states.length - 1];
    const m = Chess.legalMoves(st).find((x) => x.from === h.from && x.to === h.to && (x.promo || null) === (h.promo || null));
    if (!m) return null;
    states.push(Chess.apply(st, m));
  }
  return states;
}

// Everything the score is made of, for one game. evals[k] = White's evaluation after k moves (k = 0..n).
// moveClk[i-1] = the mover's remaining ms after move i, from the server's own clock record (room.ck), or null for untimed games.
// Returns { raw, parts, swings, comebacks, sacrifices, blunders, scrambles, attacks, close, sustain, events, reasons }.
function analyse(hist, evals, moveClk) {
  const n = Math.min(hist.length, evals.length - 1);
  const states = replay(hist.slice(0, n));
  const out = { raw: 0, parts: {}, swings: 0, comebacks: 0, sacrifices: 0, blunders: 0, scrambles: 0, attacks: 0, close: 0, sustain: 0, hot: [], events: [], reasons: [] };
  if (!states || n < 1) return out;
  const ev = (kind, ply, why, side, extra) => out.events.push({ kind, ply, why, side: side || null, ...(extra || {}) });
  const hotAt = new Array(n + 1).fill(false);
  const checks = new Array(n + 1).fill(false);
  let scrambleRun = 0, mateSeen = false;
  const down = { w: false, b: false }, turned = { w: false, b: false }, low = { w: 0, b: 0 };   // low: the worst each side's view got

  for (let i = 1; i <= n; i++) {
    const before = states[i - 1], after = states[i], h = hist[i - 1], mover = before.turn, pov = mover === 'w' ? 1 : -1;
    const e0 = evals[i - 1], e1 = evals[i], d = pov * (e1 - e0), mate = isMate(e0) || isMate(e1);
    if (isMate(e1)) mateSeen = true;
    checks[i] = Chess.inCheck(after, after.turn);
    const captured = before.board[h.to];
    const big = Math.abs(e1 - e0) >= 80;
    hotAt[i] = big || checks[i] || (!!captured && Math.abs(e1 - e0) >= 40);

    // a major evaluation swing (not a mate flip)
    if (Math.abs(e1 - e0) >= 150 && !mate) { out.swings++; }
    // a swing this big in one move is a highlight on its own (magnitude in centipawns)
    if (Math.abs(e1 - e0) >= SWING_MIN && !mate) ev('swing', i, `the evaluation moved ${Math.round(Math.abs(e1 - e0) / 100)} pawns`, mover, { mag: Math.abs(e1 - e0) });
    // a meaningful blunder: the mover was not already lost, and gave up 200+ centipawns
    if (d <= -200 && pov * e0 >= -100 && !mate) {
      out.blunders++;
      ev('blunder', i, `a move that gave away ${Math.round(-d / 100)} pawns`, mover);
    }
    // a sacrifice: after the reply and the mover's next move (so a plain recapture is not one), the mover is still 3+ points
    // down in material and the evaluation has not fallen: the compensation is real
    // shortcut: only a piece taken right after it moved counts (the usual shape of a sacrifice); other sacrifices are missed
    const j = Math.min(i + 2, n), taken = i < n && hist[i].to === h.to;
    if (taken && j > i && !mate && !isMate(evals[j])) {
      const lost = balance(before, mover) - balance(states[j], mover);   // net of what was taken back: a trade is not a sacrifice
      if (lost >= 3 && pov * evals[j] >= pov * e0 - 100) {
        out.sacrifices++;
        ev('sacrifice', i, `gave up ${lost} points of material and kept the position`, mover, { piece: before.board[h.from] ? before.board[h.from][1] : null });
      }
    }
    // time scramble: both sides short on the clock, for several moves in a row
    // time scramble: the mover had under 10 s left after the move, for 8 moves in a row. Colours alternate, so both players are short.
    const c = moveClk && Number.isFinite(moveClk[i - 1]) ? moveClk[i - 1] : null;
    if (c != null && c < SCRAMBLE_MS) {
      scrambleRun++;
      if (scrambleRun === SCRAMBLE_PLIES) { out.scrambles++; ev('time', i, `both players under ${SCRAMBLE_MS / 1000}s for ${SCRAMBLE_PLIES} moves`, mover); }
    } else scrambleRun = 0;
  }

  // comebacks: a side that was at -3 or worse (from its own view) later stands at +1 or better
  for (let k = 0; k <= n; k++) {
    for (const s of ['w', 'b']) {
      const p = s === 'w' ? 1 : -1, v = p * evals[k];
      if (v < low[s]) low[s] = v;
      if (!down[s] && v <= -300 && !isMate(evals[k])) down[s] = true;
      else if (down[s] && !turned[s] && v >= 100) {
        turned[s] = true; out.comebacks++;
        if (k > 0) ev('comeback', k, `came back from a deficit of 3 pawns or more to level or better`, s, { low: low[s] });
      }
    }
  }

  // closeness and attacks: positions where the evaluation is even after the opening, and runs of checks while it stays even
  let close = 0, post = 0;
  for (let k = 12; k <= n; k++) { post++; if (Math.abs(evals[k]) <= 60 && !isMate(evals[k])) close++; }
  out.close = post ? close / post : 0;
  for (let k = 8; k <= n; k++) {
    let c2 = 0;
    for (let j = k - 7; j <= k; j++) if (checks[j]) c2++;
    if (c2 >= 3 && Math.abs(evals[k]) <= 150 && !isMate(evals[k])) out.attacks++;
  }

  // sustained intensity: how many of the last 30 positions were hot (big swings, checks, captures that matter)
  const recent = hotAt.slice(Math.max(1, n - 29));
  out.hot = recent;
  const hotFrac = recent.length ? recent.filter(Boolean).length / recent.length : 0;

  const p = out.parts = {
    swings: Math.min(20, 5 * out.swings),
    comeback: Math.min(20, 20 * Math.min(1, out.comebacks)),
    sacrifices: Math.min(15, 8 * out.sacrifices),
    blunders: Math.min(15, 5 * out.blunders),
    closeAttacks: Math.min(15, Math.round(10 * out.close) + Math.min(5, 2 * out.attacks)),
    time: Math.min(10, 5 * out.scrambles),
    mate: mateSeen ? 10 : 0,
    sustained: Math.min(15, Math.round(15 * hotFrac)),
  };
  out.raw = Math.max(0, Math.min(100, Object.values(p).reduce((a, b) => a + b, 0)));
  out.sustain = Math.round(hotFrac * 100);
  // the reasons a viewer reads: the biggest parts first, in plain words
  const order = Object.entries(p).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const words = {
    swings: `${out.swings} major swing${out.swings === 1 ? '' : 's'}`,
    comeback: out.comebacks ? 'a comeback' : null,
    sacrifices: out.sacrifices ? `${out.sacrifices} sacrifice${out.sacrifices === 1 ? '' : 's'}` : null,
    blunders: out.blunders ? `${out.blunders} big blunder${out.blunders === 1 ? '' : 's'}` : null,
    closeAttacks: out.attacks ? 'a king attack' : out.close > 0.5 ? 'a close fight' : null,
    time: out.scrambles ? 'a time scramble' : null,
    mate: 'a forced mate on the board',
    sustained: 'sustained tension',
  };
  out.reasons = order.map((k) => words[k]).filter(Boolean).slice(0, 3);
  return out;
}

// Score smoothing with hysteresis. prev = { ema, shown } from the stored record (or null on the first analysis).
// The number on screen moves only by 3+ points, so it does not flicker from move to move.
function smooth(prev, raw) {
  const ema = prev && prev.ema != null ? Math.round(0.7 * prev.ema + 0.3 * raw) : raw;
  const shown = prev && prev.shown != null && Math.abs(ema - prev.shown) < 3 ? prev.shown : ema;
  return { ema, shown };
}

// Which events are new and may be announced: not already known, not too close to the last of the same kind (plies or time).
const ANNOUNCED = new Set(['sacrifice', 'comeback', 'time']);   // the events people are told about; the rest only feed the score
function fresh(events, known, last, now) {
  const seen = new Set(known.map((e) => e.id)), out = [];
  for (const e of [...events].sort((a, b) => a.ply - b.ply)) {
    if (!ANNOUNCED.has(e.kind)) continue;
    const id = e.kind + ':' + e.ply;
    if (seen.has(id)) continue;
    const l = last[e.kind];
    if (l && (e.ply - l.ply < EVENT_GAP || now - l.at < EVENT_COOLDOWN_MS)) continue;
    seen.add(id); last[e.kind] = { ply: e.ply, at: now };
    out.push({ id, kind: e.kind, ply: e.ply, why: e.why, at: now });
  }
  return out.slice(-KEEP_EVENTS);
}

// Which live game a browser should analyse next: no analysis yet, or a stale one, never a game it plays in, never a game
// someone else is analysing right now. Oldest analysis first; games nobody has analysed come before stale ones.
function pickGame(live, docs, leases, now, me) {
  let best = null, bestKey = Infinity;
  live.forEach((g, i) => {
    if (!g || !g.code || !g.w || !g.b) return;
    if (g.w.name === me || g.b.name === me) return;
    const l = leases[i];
    if (l && l.by !== me && now - l.at < LEASE_MS) return;
    const d = docs[i];
    const key = d && d.at ? d.at : -1;     // -1: never analysed, so it comes first
    if (d && d.over && d.ply >= (g.moves || 0)) return;                  // a finished game, fully analysed: nothing left to do
    if (d && now - d.at < FRESH_MS && d.ply >= (g.moves || 0)) return;   // fresh and up to date: someone already has it
    if (key < bestKey) { best = i; bestKey = key; }
  });
  return best;
}

// Ranked for LIVE TUNE-IN: fresh analyses only, highest shown score first; ties go to the more sustained game.
function rank(entries) {
  return entries.filter((e) => e.fresh).sort((a, b) => b.score - a.score || b.sustain - a.sustain || (a.code < b.code ? -1 : 1));
}

// MATCH OF THE MOMENT: the game with the most sustained excitement. Needs a fresh analysis and enough moves to judge.
// Sustained = the average of its recent score samples, so one spike does not win.
function featured(entries) {
  let best = null;
  for (const e of entries) {
    if (!e.fresh || e.ply < 12 || !e.samples || e.samples.length < 3) continue;
    const avg = e.samples.reduce((a, b) => a + b, 0) / e.samples.length;
    if (!best || avg > best.avg) best = { ...e, avg: Math.round(avg) };
  }
  return best;
}

const status = (doc, now) => (!doc || !doc.at ? 'unavailable' : now - doc.at < FRESH_MS ? 'live' : 'stale');

module.exports = {
  MATE_CP, MATE_FLOOR, MAX_CLK, MAX_PLIES, FRESH_MS, LEASE_MS, EVENT_GAP, EVENT_COOLDOWN_MS, SCRAMBLE_MS, SCRAMBLE_PLIES,
  uciOf, normalise, checkBatch, replay, analyse, smooth, fresh, pickGame, rank, featured, status,
};
