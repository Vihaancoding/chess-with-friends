// REELS: the remarkable moments of finished games, for the vertical highlight feed. Pure functions.
// Engine-based moments (brilliant, forced mate, comeback, tactic) come from the evaluations browsers computed for the game
// (the move-stats queue, or the Reels backfill queue: browser Stockfish, see public/sfengine.js) and must be confirmed by a
// second, independent browser before they are shown (verifyPlan / verifyCheck). Record-based moments (upset, streak breaker,
// time scramble) come from the server's own game record and need no engine. Nothing is invented: a moment that cannot be
// stated from these facts is not made.
const Excite = require('../public/excite.js');
const Dmg = require('./damage');

const KINDS = ['brilliant', 'mate', 'comeback', 'tactic', 'upset', 'streak', 'scramble'];
const ENGINE = new Set(['brilliant', 'mate', 'comeback', 'tactic']);
const CAT = { brilliant: 'BRILLIANT', mate: 'CHECKMATE', comeback: 'COMEBACK', tactic: 'TACTICAL MASTERPIECE', upset: 'UPSET', streak: 'STREAK BREAKER', scramble: 'TIME SCRAMBLE' };
const FILTER = { brilliants: ['brilliant', 'tactic'], checkmates: ['mate'], upsets: ['upset'], streaks: ['streak'], comebacks: ['comeback'] };
const MIN_PLIES = 10, UPSET_DIFF = 200, COMEBACK_WP = 0.12, TACTIC_SWING = 0.35, SCRAMBLE_MS = 10000;
const pawns = (cp) => (Excite.isMate(cp) ? (cp > 0 ? 'M' : '-M') : (cp > 0 ? '+' : '') + (Math.round(cp / 10) / 10).toFixed(1).replace(/\.0$/, ''));
const moveNo = (i) => Math.ceil(i / 2);
const other = (c) => (c === 'w' ? 'b' : 'w');
const UCI = (h) => 'abcdefgh'[h.from & 7] + (8 - (h.from >> 3)) + 'abcdefgh'[h.to & 7] + (8 - (h.to >> 3)) + (h.promo ? String(h.promo).toLowerCase() : '');

// Can this game appear in Reels at all? Public (not a private room, not local), finished decisively or drawn, long enough.
const publicGame = (g) => !!(g && g.id && !g.lounge && !g.local && g.players && g.players.w && g.players.b && g.players.w.name !== g.players.b.name
  && Array.isArray(g.hist) && g.hist.length >= MIN_PLIES && ['w', 'b', 'draw'].includes(g.result) && g.reason !== 'aborted' && g.reason !== 'fair play forfeit');

const ratingsAt = (g) => ({ w: g.ratings && g.ratings.w ? g.ratings.w.before : g.players.w.elo || null, b: g.ratings && g.ratings.b ? g.ratings.b.before : g.players.b.elo || null });

// The base of every highlight: the game facts it needs to be shown and replayed.
function base(g, kind, ply, seq) {
  const r = ratingsAt(g);
  return {
    id: g.id + ':' + kind, g: g.id, code: g.code, k: kind, cat: CAT[kind], at: g.endedAt || g.saved || null, ply, seq,
    w: { name: g.players.w.name, elo: r.w }, b: { name: g.players.b.name, elo: r.b }, result: g.result, reason: g.reason || null,
    moves: g.hist.map(UCI).join(' '), tc: g.tc || null,
  };
}

// Moments that need no engine: from the record (ratings at the time, clocks, the verified streak break).
function fromRecord(g, { streak } = {}) {
  if (!publicGame(g)) return [];
  const out = [], n = g.hist.length, win = g.result === 'w' || g.result === 'b' ? g.result : null;
  if (win) {
    const r = ratingsAt(g), lo = r[win], hi = r[other(win)];
    if (lo && hi && hi - lo >= UPSET_DIFF) {
      const h = base(g, 'upset', n, [Math.max(0, n - 6), n]);
      out.push({ ...h, head: `THE ${hi} JUST FELL.`, text: `${g.players[win].name} (${lo}) beat ${g.players[other(win)].name} (${hi}), ${hi - lo} rating points higher, by ${g.reason}.`, sc: Math.min(92, 45 + Math.round((hi - lo - UPSET_DIFF) / 10)), ver: 'record' });
    }
    if (g.tc && Array.isArray(g.ck) && g.ck.length === n && g.reason !== 'timeout') {
      const last = (() => { for (let i = n - 1; i >= 0; i--) if (i % 2 === (win === 'w' ? 0 : 1)) return i; return -1; })();
      const left = last >= 0 ? g.ck[last] : null;
      if (left != null && left > 0 && left <= SCRAMBLE_MS) {
        const s = Math.max(1, Math.ceil(left / 1000));
        out.push({ ...base(g, 'scramble', last + 1, [Math.max(0, last - 5), last + 1]), head: `${s} SECOND${s === 1 ? '' : 'S'} LEFT. STILL WON.`, text: `${g.players[win].name} won by ${g.reason} with ${s} second${s === 1 ? '' : 's'} on the clock.`, sc: 45 + (10 - s) * 3, ver: 'record' });
      }
    }
  }
  if (streak && streak.len >= 3 && win) {
    out.push({ ...base(g, 'streak', n, [Math.max(0, n - 6), n]), head: `${streak.len} WINS. ONE DEFEAT.`, text: `${streak.breaker} ended ${streak.victim}'s ${streak.len}-game win streak.`, sc: Math.min(95, 40 + 3 * streak.len), ver: 'record', len: streak.len });
  }
  return out;
}

// Moments the engine shows, from a complete set of evaluations (White's side, one per position: ev.length === hist.length + 1).
function fromEngine(g, ev) {
  if (!publicGame(g) || !Array.isArray(ev) || ev.length !== g.hist.length + 1 || ev.some((x) => x == null)) return [];
  const rep = Excite.replay(g.hist), drep = Dmg.replay(g.hist); if (!rep || !drep) return [];
  const n = g.hist.length, win = g.result === 'w' || g.result === 'b' ? g.result : null, out = [], wpw = (i) => Excite.wp(ev[i]);
  const sideWp = (c, i) => (c === 'w' ? wpw(i) : 1 - wpw(i));
  // BRILLIANT: the existing move-stats rule (a sound sacrifice that is also Stockfish's best move), by the winner (or in a draw)
  const ms = Dmg.moveStats(drep, ev);
  const bril = ms.list.filter((x) => x.kind === 'brilliant' && (!win || x.c === win)).map((x) => ({ x, s: Excite.sacAt(rep, ev, x.i) })).filter((y) => y.s);
  if (bril.length) {
    const { x, s } = bril.sort((a, b) => b.s.lost - a.s.lost)[0], who = g.players[x.c].name;
    out.push({ ...base(g, 'brilliant', x.i, [Math.max(0, x.i - 4), Math.min(n, x.i + 4)]), head: `THE ${s.name} SACRIFICE CHANGED EVERYTHING.`,
      text: `${who} gave up the ${s.name.toLowerCase()} with ${moveNo(x.i)}${x.i % 2 ? '.' : '...'} ${s.san}, and Stockfish says it was the best move.`, sc: Math.min(96, 72 + 3 * s.lost), ver: 'pending', check: [x.i - 1, x.i, Math.min(n, x.i + 1)] });
  }
  // FORCED MATE: the winner had a forced mate (engine mate score) for at least 2 of their moves before mating
  if (win && g.reason === 'checkmate') {
    let k = n; while (k - 1 >= 0 && Excite.isMate(ev[k - 1]) && Math.sign(ev[k - 1]) === (win === 'w' ? 1 : -1)) k--;
    const len = Math.ceil((n - k) / 2);
    if (len >= 2) out.push({ ...base(g, 'mate', k, [k, n]), head: len >= 4 ? `NO WAY OUT. MATE IN ${len}.` : `NO WAY OUT. FORCED MATE IN ${len}.`, text: `From move ${moveNo(k + 1)}, ${g.players[win].name} had a forced mate in ${len}, and played it to the end.`, sc: Math.min(92, 46 + 8 * len), ver: 'pending', check: [k] });
  }
  // COMEBACK: the winner was clearly lost (<= 12% by Stockfish) and won
  if (win) {
    let worst = 1, at = 0;
    for (let i = 8; i < n; i++) { const p = sideWp(win, i); if (p < worst) { worst = p; at = i; } }
    if (worst <= COMEBACK_WP) {
      const from = (win === 'w' ? 1 : -1) * ev[at];
      out.push({ ...base(g, 'comeback', at, [Math.max(0, at - 2), Math.min(n, at + 8)]), head: `FROM ${pawns(from)} TO VICTORY.`, text: `${g.players[win].name} was ${Excite.isMate(from) ? 'getting mated' : `${pawns(-from).replace('+', '')} pawns down`} by Stockfish after move ${moveNo(at)} and still won by ${g.reason}.`, sc: Math.min(94, 50 + Math.round((COMEBACK_WP - worst) * 300)), ver: 'pending', check: [at], from });
    }
  }
  // TACTIC: one move by the winner turned a balanced game into a winning one, and stayed winning
  if (win) {
    let best = null;
    for (let i = 1; i <= n; i++) {
      if (drep.plies[i - 1].color !== win) continue;
      const before = sideWp(win, i - 1), after = sideWp(win, i), later = sideWp(win, Math.min(n, i + 4));
      if (before >= 0.3 && before <= 0.7 && after - before >= TACTIC_SWING && later >= after - 0.1 && (!best || after - before > best.d)) best = { i, d: after - before };
    }
    if (best && !out.some((h) => h.k === 'brilliant' && Math.abs(h.ply - best.i) <= 2)) {
      const p = drep.plies[best.i - 1];
      out.push({ ...base(g, 'tactic', best.i, [Math.max(0, best.i - 3), Math.min(n, best.i + 5)]), head: 'ONE MOVE TURNED IT.', text: `${moveNo(best.i)}${best.i % 2 ? '.' : '...'} ${p.san} took Stockfish from ${pawns((win === 'w' ? 1 : -1) * ev[best.i - 1])} to ${pawns((win === 'w' ? 1 : -1) * ev[best.i])} for ${g.players[win].name}.`, sc: Math.min(88, 50 + Math.round(best.d * 60)), ver: 'pending', check: [best.i - 1, best.i] });
    }
  }
  return out;
}

// Verification: a different browser re-searches the positions a highlight rests on; it is shown only if they agree.
const agree = (a, b) => {
  if (a == null || b == null) return false;
  if (Excite.isMate(a) || Excite.isMate(b)) return Excite.isMate(a) && Excite.isMate(b) && Math.sign(a) === Math.sign(b);
  return Math.abs(Excite.wp(a) - Excite.wp(b)) <= 0.12;
};
function verifyCheck(h, ev, got) {
  // got: { ply: White-side cp } from the verifying browser
  return (h.check || []).every((i) => agree(ev[i], got[i]));
}

// Feed order. Quality first; engagement (fires) only adds a little; recency only matters for "newest" and "trending".
const DAY = 86400e3;
function rank(list, sort, now, fires = {}) {
  const f = (h) => (fires[h.id] || 0);
  if (sort === 'newest') return list.sort((a, b) => (b.at || 0) - (a.at || 0) || b.sc - a.sc);
  if (sort === 'trending') return list.sort((a, b) => trend(b) - trend(a));
  return list.sort((a, b) => b.sc + Math.min(6, f(b)) - (a.sc + Math.min(6, f(a))) || (b.at || 0) - (a.at || 0));   // best of all time
  function trend(h) { const age = Math.max(0, (now - (h.t || h.at || 0)) / DAY); return h.sc + 4 * Math.log2(1 + f(h)) - 6 * Math.log2(1 + age); }
}
// one moment per game in a row of the feed: never the same game twice in a row, best moment of each game first
function diversify(list) {
  const out = [], held = [];
  for (const h of list) { if (out.length && out[out.length - 1].g === h.g) held.push(h); else out.push(h); }
  for (const h of held) { const i = out.findIndex((x, j) => x.g !== h.g && (!out[j + 1] || out[j + 1].g !== h.g)); if (i >= 0) out.splice(i + 1, 0, h); else out.push(h); }
  return out;
}

module.exports = { KINDS, ENGINE, CAT, FILTER, publicGame, ratingsAt, fromRecord, fromEngine, verifyCheck, agree, rank, diversify, UCI };
