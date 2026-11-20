// Win streaks, from each player's very first completed game. Pure and deterministic: the stats are always rebuilt from the player's
// archive rows (id, at, result 'win' | 'loss' | 'draw', moves), oldest first, so a game can never be counted twice, backfill and live
// updates give the same answer, and a duplicate result event changes nothing. Rows without a valid result, or abandoned
// (fewer than 2 moves, aborted, no id), do not count.
const MILESTONES = [3, 5, 10, 15, 20, 50];
const TIERS = [[3, 'Heating up'], [5, 'On fire'], [7, 'Rampage'], [10, 'Unstoppable'], [15, 'Ridiculous'], [20, 'Hostile takeover'], [50, 'Legend']];
const tierOf = (n) => { let t = ''; for (const [m, name] of TIERS) if (n >= m) t = name; return t; };
const nextMilestone = (n) => MILESTONES.find((m) => m > n) || null;
const MIN_RATE_GAMES = 10;                       // the win-rate board needs at least this many completed games

const valid = (r) => !!(r && r.id && ['win', 'loss', 'draw'].includes(r.result) && (r.moves || 0) >= 2 && r.reason !== 'aborted' && !r.local);
const chrono = (rows) => [...new Map(rows.filter(valid).map((r) => [r.id, r])).values()].sort((a, b) => (a.at || 0) - (b.at || 0) || (a.id < b.id ? -1 : 1));

// stats after the games in `rows`; up to (not including) the game `stopAt`. Milestones are awarded the first time a streak reaches them.
function build(rows, stopAt = null) {
  const s = { cur: 0, best: 0, bestAt: null, bestTs: null, w: 0, l: 0, d: 0, n: 0, ms: {}, last: null, lastTs: null };
  for (const r of chrono(rows)) {
    if (r.id === stopAt) break;
    s.n++; s.last = r.id; s.lastTs = r.at || null;
    if (r.result === 'win') {
      s.w++; s.cur++;
      if (s.cur > s.best) { s.best = s.cur; s.bestAt = r.id; s.bestTs = r.at || null; }
      for (const m of MILESTONES) if (s.cur === m && !s.ms[m]) s.ms[m] = { g: r.id, at: r.at || null };
    } else { if (r.result === 'loss') s.l++; else s.d++; s.cur = 0; }
  }
  s.rate = s.n ? s.w / s.n : 0;
  return s;
}

// the facts about one game for its owner: before and after
function report(rows, gameId) {
  const all = chrono(rows), i = all.findIndex((r) => r.id === gameId);
  if (i < 0) return null;
  const before = build(all, gameId), after = build(all.slice(0, i + 1)), g = all[i];
  const hit = Object.entries(after.ms).filter(([, v]) => v.g === gameId).map(([m]) => +m);
  const f = { result: g.result, cur: after.cur, best: after.best, prevBest: before.best, prevCur: before.cur, rate: after.rate, w: after.w, l: after.l, d: after.d, n: after.n, milestones: hit, newBest: g.result === 'win' && after.best > before.best && after.best >= 3, first: before.n === 0 };
  f.headline = headline(f);
  return f;
}

const MS_LINES = { 3: '3 WINS IN A ROW. THE HEAT IS RISING.', 5: '5 WINS IN A ROW. SOMEONE STOP THIS.', 10: '10 CONSECUTIVE WINS. THIS IS GETTING RIDICULOUS.', 15: '15 STRAIGHT. THE OPPOSITION HAS RUN OUT OF ANSWERS.', 20: '20 STRAIGHT WINS. THIS IS A HOSTILE TAKEOVER.', 50: '50 CONSECUTIVE WINS. HISTORY IS BEING WRITTEN.' };
// playful, but every line states something that is true of the numbers
function headline(f) {
  if (f.result === 'win') {
    if (f.milestones.length) return MS_LINES[Math.max(...f.milestones)];
    if (f.newBest) return 'A NEW PERSONAL RECORD.';
    if (f.n >= 10 && f.rate >= 0.8) return 'ABSOLUTE DOMINATION.';
    if (f.first) return 'A WINNING START. THE RECORD BEGINS.';
    if (f.cur >= 4) return 'THE WIN STREAK CONTINUES.';
    return 'ANOTHER VICTORY ADDED TO THE RECORD.';
  }
  if (f.result === 'loss') return f.prevCur >= 3 ? 'THE STREAK HAS FALLEN.' : f.prevCur >= 1 ? 'THE RUN ENDS HERE.' : 'BACK TO THE DRAWING BOARD.';
  return f.prevCur >= 1 ? 'A DRAW. THE STREAK ENDS WITHOUT A LOSS.' : 'HONOURS EVEN.';
}

// ranking: ties are broken by the other numbers so the order is stable
const BOARDS = {
  cur: (a, b) => b.cur - a.cur || b.best - a.best || b.w - a.w,
  best: (a, b) => b.best - a.best || b.cur - a.cur || b.w - a.w,
  rate: (a, b) => b.rate - a.rate || b.n - a.n,
  wins: (a, b) => b.w - a.w || b.rate - a.rate,
  games: (a, b) => b.n - a.n || b.w - a.w,
};
function rank(rows, board) {
  const list = rows.filter((r) => r.n > 0 && (board !== 'rate' || r.n >= MIN_RATE_GAMES) && (board !== 'cur' || r.cur > 0));
  return list.sort((a, b) => BOARDS[board](a, b) || (a.name < b.name ? -1 : 1));
}

module.exports = { TIERS, tierOf, nextMilestone, MILESTONES, MIN_RATE_GAMES, valid, chrono, build, report, headline, rank, BOARDS };
