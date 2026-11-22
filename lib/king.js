// KING OF THE SERVER. Pure: the server keeps the candidates (every player whose active win streak is at least MIN, with the time of the
// win that brought it to its current length) and the crown; after each game `decide` says who holds the crown and what happened.
// The crown goes to the longest active streak; a tie goes to whoever reached that length first (the earlier `ts`).
const MIN = 5;
const FRENZY_MS = 2 * 60e3;
const lc = (s) => String(s || '').toLowerCase();

// cands: { [lowercase name]: { name, cur, ts } }
function pick(cands) {
  const list = Object.values(cands || {}).filter((c) => c && c.cur >= MIN);
  list.sort((a, b) => b.cur - a.cur || (a.ts || 0) - (b.ts || 0) || (lc(a.name) < lc(b.name) ? -1 : 1));
  return list[0] || null;
}

// prev: the crown before the game ({ name, streak, since } or null). game: { id, code, winner, loser, draw: [names] | null, winnerPrevCur }.
// Returns { king, ev }: ev.type is 'fall' (the king lost: the cinematic), 'kingslayer' (the king lost to someone with no active streak),
// 'ended' (the king drew: the crown moves on quietly), 'steal' (someone passed the king's streak), 'crowned' (an empty throne filled), or null.
function decide(prev, cands, game, now = Date.now()) {
  const top = pick(cands);
  const king = top ? { name: top.name, streak: top.cur, since: prev && top && lc(prev.name) === lc(top.name) ? prev.since : now } : null;
  const same = prev && king && lc(prev.name) === lc(king.name);
  if (same) return { king: { ...king, since: prev.since || now }, ev: null };
  if (prev && game && lc(game.loser) === lc(prev.name)) {
    const slayer = (game.winnerPrevCur || 0) === 0;
    return { king, ev: { type: slayer ? 'kingslayer' : 'fall', game: game.id, code: game.code || null, fallen: prev.name, streak: prev.streak, by: game.winner, heir: king ? king.name : null, heirStreak: king ? king.streak : 0, at: now } };
  }
  if (prev && game && (game.draw || []).some((n) => lc(n) === lc(prev.name))) return { king, ev: { type: 'ended', game: game.id, fallen: prev.name, streak: prev.streak, heir: king ? king.name : null, at: now } };
  if (!king) return { king: null, ev: prev ? { type: 'ended', fallen: prev.name, streak: prev.streak, heir: null, at: now } : null };
  return { king, ev: { type: prev ? 'steal' : 'crowned', game: game ? game.id : null, fallen: prev ? prev.name : null, streak: prev ? prev.streak : 0, heir: king.name, heirStreak: king.streak, at: now } };
}

const cinematic = (ev) => !!ev && (ev.type === 'fall' || ev.type === 'kingslayer');

module.exports = { MIN, FRENZY_MS, pick, decide, cinematic };
