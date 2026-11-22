// STREAK HUNT: ending someone's win streak is an event. Pure functions over the same archive rows as lib/streaks.js
// (id, at, result, opp, moves, reason, priv), so a break is found from the canonical, server-stored result, the same way for
// live games and historical backfills, and a duplicate result event finds the same break (keyed by the game id).
const Streaks = require('./streaks');

const MIN = 3;                        // a streak this long is worth announcing and counts for the breaker
const MIN_PLIES = 10;                 // a game shorter than this ends a streak but proves nothing: not announced, not counted
const MIN_OPPS = 3;                   // a streak built against fewer different opponents may be farmed: its end is not announced
const PAIR_WINDOW = 30 * 86400e3;     // the same breaker ending the same player's streak again within this counts once
const NO_REASONS = new Set(['fair play forfeit', 'ended by an admin']);
const ACH = [
  { key: 'first', label: 'First Blood', need: 'Break your first streak', ok: (s) => s.total >= 1 },
  { key: 'giant', label: 'Giant Slayer', need: 'End a 10+ game streak', ok: (s) => s.biggest >= 10 },
  { key: 'legend', label: 'Legend Hunter', need: 'End a 15+ game streak', ok: (s) => s.biggest >= 15 },
  { key: 'exec', label: 'Streak Executioner', need: 'End a 20+ game streak', ok: (s) => s.biggest >= 20 },
];

// The loser's archive (it already holds this game). Returns the streak this game ended, or null.
// { len, opps: different opponents beaten during it, since: when it started, plies, reason }
function breakOf(loserRows, gameId) {
  const all = Streaks.chrono(loserRows), i = all.findIndex((r) => r.id === gameId);
  if (i < 0 || all[i].result !== 'loss') return null;
  let len = 0;
  const opps = new Set();
  for (let j = i - 1; j >= 0 && all[j].result === 'win'; j--) { len++; if (all[j].opp) opps.add(String(all[j].opp).toLowerCase()); }
  if (len < MIN) return null;
  const g = all[i];
  return { len, opps: opps.size, since: all[i - len].at || null, plies: g.moves || 0, reason: g.reason || null, priv: !!g.priv, at: g.at || null, breaker: g.opp || null };
}

// Every break in one player's archive, in one pass (historical backfill): the same answer as breakOf for each loss.
function breaksIn(rows) {
  const all = Streaks.chrono(rows), out = [];
  let len = 0, opps = new Set(), since = null;
  for (const g of all) {
    if (g.result === 'win') { if (!len) since = g.at || null; len++; if (g.opp) opps.add(String(g.opp).toLowerCase()); continue; }
    if (g.result === 'loss' && len >= MIN) out.push({ id: g.id, code: g.code || null, len, opps: opps.size, since, plies: g.moves || 0, reason: g.reason || null, priv: !!g.priv, at: g.at || null, breaker: g.opp || null });
    len = 0; opps = new Set(); since = null;
  }
  return out;
}

// Is this break a public event? Private-room games, self-play, very short games, forfeits for cheating and streaks
// farmed off one or two accounts are not.
function qualifies(b, victim) {
  if (!b || !b.breaker || !victim) return false;
  if (String(b.breaker).toLowerCase() === String(victim).toLowerCase()) return false;
  if (b.priv || NO_REASONS.has(b.reason) || b.plies < MIN_PLIES) return false;
  return b.opps >= Math.min(MIN_OPPS, b.len);
}

const level = (len) => (len >= 20 ? 4 : len >= 15 ? 3 : len >= 10 ? 2 : len >= 5 ? 1 : 0);
const HEADS = [
  ['STREAK TERMINATED.', 'THE HUNT IS OVER.'],
  ['A NEW STREAK BREAKER HAS EMERGED.', 'THE RUN IS OVER.'],
  ['THE GIANT HAS FALLEN.', '{n} WINS. ONE DEFEAT.'],
  ['{n} WINS. ONE DEFEAT.', 'THE GIANT HAS FALLEN.'],
  ['THE KING HAS FALLEN.', '{n} WINS. ONE DEFEAT.'],
];
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
// The announcement: more dramatic the longer the streak. Every line is true of the numbers.
function announce({ id, victim, breaker, len, line }) {
  const lv = level(len), pick = HEADS[lv][Math.abs(hash(id)) % 2];
  const head = line ? 'IT WAS ON THE LINE. IT IS GONE.' : pick.replace('{n}', len);
  const body = `${victim}'s ${len}-game win streak has been ENDED.`;
  const tail = lv >= 2 ? `${len} consecutive victories. One defeat. History rewritten.` : lv === 1 ? `${len} in a row, and ${breaker} said no more.` : `${len} straight wins, snapped.`;
  return { head, body, tail, level: lv };
}

// A breaker's record from their list of breaks (newest first or any order). Each { id, victim, len, at }.
// The same victim within PAIR_WINDOW counts once, so two friends can't farm achievements off each other.
function breakerStats(list) {
  const seen = new Map(), counted = [];
  for (const e of [...(list || [])].filter((x) => x && x.id).sort((a, b) => (a.at || 0) - (b.at || 0))) {
    const k = String(e.victim).toLowerCase(), last = seen.get(k);
    if (last != null && (e.at || 0) - last < PAIR_WINDOW) continue;
    seen.set(k, e.at || 0); counted.push(e);
  }
  const s = { total: counted.length, biggest: 0, biggestOf: null, recent: null };
  for (const e of counted) if (e.len > s.biggest) { s.biggest = e.len; s.biggestOf = { victim: e.victim, at: e.at, id: e.id }; }
  if (counted.length) { const r = counted[counted.length - 1]; s.recent = { victim: r.victim, len: r.len, at: r.at, id: r.id }; }
  s.ach = ACH.filter((a) => a.ok(s)).map((a) => a.key);
  const top = ACH.filter((a) => a.ok(s)).pop();
  s.title = top ? top.label : null;
  return s;
}

// The hunted: players on a meaningful streak, longest first.
function hunted(docs) {
  return docs.filter((d) => d && d.cur >= MIN).sort((a, b) => b.cur - a.cur || (a.lastTs || 0) - (b.lastTs || 0) || (a.name < b.name ? -1 : 1));   // a tie goes to whoever got there first, as for the crown (lib/king.js)
}

// ON THE LINE: the streak it was set on is still the current one while no loss or draw has happened since.
const lineKeyOf = (doc) => (doc ? (doc.l || 0) + (doc.d || 0) : 0);
const lineLive = (line, doc) => !!(line && doc && doc.cur >= MIN && line.nw === lineKeyOf(doc));

module.exports = { breaksIn, MIN, MIN_PLIES, MIN_OPPS, PAIR_WINDOW, ACH, breakOf, qualifies, announce, level, breakerStats, hunted, lineKeyOf, lineLive };
