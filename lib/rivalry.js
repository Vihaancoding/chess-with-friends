// Rivalries: head-to-head records, tiers, streaks, moments and seasons between two players.
// Everything is derived from the server's own game archive ("games:<name>" rows, written when a game ends), so a
// record can't be invented or edited from a browser. Pure functions, so they can be tested without a server.
//
// What counts
//   completed  a finished game in the archive where both players moved, not ended by an admin
//   meaningful a completed game of at least MEANINGFUL_PLIES half-moves; at most DAILY_CAP of them count per day.
//              Tiers, streak moments and milestones use these, so a pile of instant resignations earns nothing.
const MEANINGFUL_PLIES = 12, DAILY_CAP = 3, ACTIVE_DAYS = 45, DAY = 86400e3;
const TIERS = [
  { key: 'acq', label: 'Acquaintances' },
  { key: 'riv', label: 'Rivals', games: 5, days: 2, minWins: 0 },
  { key: 'nem', label: 'Nemeses', games: 15, days: 4, minWins: 3 },
  { key: 'leg', label: 'Legendary Rivals', games: 40, days: 10, minWins: 10 },
];
const R = { w: 'win', l: 'loss', d: 'draw' };
const short = (r) => (r === 'win' ? 'w' : r === 'loss' ? 'l' : 'd');
const dayOf = (t) => Math.floor(t / DAY);

// my archive rows -> completed games per opponent (lowercase key), oldest first, no duplicates
function byOpponent(rows) {
  const seen = new Set(), out = new Map();
  for (const x of rows || []) {
    if (!x || !x.opp || !x.at || !R[short(x.result)]) continue;
    if (x.reason === 'ended by an admin' || (x.moves != null && x.moves < 2)) continue;   // aborted, or nobody really played
    const key = x.id || `${x.code}:${x.at}`;                                              // older rows have no id
    if (seen.has(key)) continue;
    seen.add(key);
    const k = x.opp.toLowerCase();
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(x);
  }
  for (const list of out.values()) list.sort((a, b) => a.at - b.at);
  return out;
}

// which games count towards tiers: long enough, and at most DAILY_CAP a day
function meaningful(games) {
  const perDay = new Map(), out = [];
  for (const g of games) {
    if ((g.moves || 0) < MEANINGFUL_PLIES) continue;
    const d = dayOf(g.at), n = perDay.get(d) || 0;
    if (n >= DAILY_CAP) continue;
    perDay.set(d, n + 1); out.push(g);
  }
  return out;
}

function tierOf(games) {
  const m = meaningful(games), days = new Set(m.map((g) => dayOf(g.at))).size;
  const w = m.filter((g) => g.result === 'win').length, l = m.filter((g) => g.result === 'loss').length;
  let i = 0;
  for (let k = 1; k < TIERS.length; k++) { const t = TIERS[k]; if (m.length >= t.games && days >= t.days && Math.min(w, l) >= t.minWins) i = k; }
  const cur = TIERS[i], next = TIERS[i + 1];
  let need = null;
  if (next) {
    const bits = [];
    if (m.length < next.games) bits.push(`${next.games - m.length} more full game${next.games - m.length === 1 ? '' : 's'}`);
    if (days < next.days) bits.push(`games on ${next.days - days} more day${next.days - days === 1 ? '' : 's'}`);
    if (Math.min(w, l) < next.minWins) bits.push(`at least ${next.minWins} wins each`);
    need = { label: next.label, text: bits.join(', '), progress: Math.min(1, m.length / next.games) };
  }
  return { key: cur.key, label: cur.label, level: i, next: need, meaningful: m.length, days };
}

// streak at the end (from my point of view): { who: 'me' | 'them', n }
function streakOf(games) {
  let who = null, n = 0;
  for (let i = games.length - 1; i >= 0; i--) {
    const r = games[i].result;
    if (r === 'draw') break;
    const w = r === 'win' ? 'me' : 'them';
    if (who && w !== who) break;
    who = w; n++;
  }
  return n ? { who, n } : null;
}
function longestRuns(games) {
  let me = 0, them = 0, a = 0, b = 0;
  for (const g of games) {
    if (g.result === 'win') { a++; b = 0; } else if (g.result === 'loss') { b++; a = 0; } else { a = 0; b = 0; }
    me = Math.max(me, a); them = Math.max(them, b);
  }
  return { me, them };
}
const tally = (games) => ({ w: games.filter((g) => g.result === 'win').length, l: games.filter((g) => g.result === 'loss').length, d: games.filter((g) => g.result === 'draw').length });

// the card: everything the list needs, nothing more
function summary(oppName, games, now = Date.now()) {
  const t = tally(games), last = games[games.length - 1], cats = {};
  for (const g of games) if (g.cat) cats[g.cat] = (cats[g.cat] || 0) + 1;
  const cat = Object.keys(cats).sort((a, b) => cats[b] - cats[a])[0] || (last && last.cat) || 'blitz';
  // did the latest game change who leads?
  const before = tally(games.slice(0, -1)), lead = Math.sign(t.w - t.l), was = Math.sign(before.w - before.l);
  return {
    name: oppName, games: games.length, ...t, lead: t.w - t.l,
    leadChange: games.length >= 4 && lead !== 0 && lead !== was ? (lead > 0 ? 'me' : 'them') : null,
    strip: games.slice(-8).map((g) => short(g.result)),
    streak: streakOf(games), tier: tierOf(games), cat,
    first: games[0].at,
    last: { at: last.at, result: last.result, id: last.id || null, tc: last.tc || null, cat: last.cat || null, color: last.color },
    active: now - last.at < ACTIVE_DAYS * DAY,
  };
}

// ---- the detail page ----
const pct = (t) => (t.w + t.l + t.d ? Math.round(((t.w + t.d / 2) / (t.w + t.l + t.d)) * 100) : 0);
function stats(games) {
  const t = tally(games), runs = longestRuns(games);
  const durs = games.map((g) => g.dur).filter((d) => d > 0 && d < 12 * 3600e3);
  const colors = { w: 0, b: 0 };
  for (const g of games) if (colors[g.color] != null) colors[g.color]++;
  const ops = {};
  for (const g of games) if (g.op) ops[g.op] = (ops[g.op] || 0) + 1;
  const topOp = Object.keys(ops).sort((a, b) => ops[b] - ops[a])[0];
  // biggest upset: the lower-rated player won, by the widest rating gap (needs both ratings)
  let upset = null;
  for (const g of games) {
    if (g.result === 'draw' || g.before == null || g.oppRating == null) continue;
    const gap = g.result === 'win' ? g.oppRating - g.before : g.before - g.oppRating;
    if (gap >= 50 && (!upset || gap > upset.gap)) upset = { gap: Math.round(gap), who: g.result === 'win' ? 'me' : 'them', id: g.id || null, at: g.at };
  }
  return {
    games: games.length, ...t, pct: pct(t), streak: streakOf(games), longest: runs,
    avgDur: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null,
    colors, colorPlays: colors.w === colors.b ? null : colors.w > colors.b ? 'w' : 'b',
    opening: topOp ? { name: topOp, n: ops[topOp] } : null, openingsKnown: Object.values(ops).reduce((a, b) => a + b, 0),
    upset,
  };
}

// shared history: what happened, in order, each linked to its game. Written from the viewer's side ("You").
function moments(games, oppName) {
  const out = [], name = (who) => (who === 'me' ? 'You' : oppName), obj = (who) => (who === 'me' ? 'you' : oppName);
  const push = (g, type, text, extra) => out.push({ type, at: g.at, id: g.id || null, text, ...extra });
  if (!games.length) return out;
  const g0 = games[0];
  push(g0, 'first', g0.result === 'draw' ? 'First game: a draw' : `First game: ${g0.result === 'win' ? 'you won' : `${oppName} won`}`);
  const won = { me: false, them: false };
  if (g0.result === 'win') won.me = true; else if (g0.result === 'loss') won.them = true;
  const mset = new Set(meaningful(games));
  let w = 0, l = 0, run = { who: null, n: 0 }, leader = 0, mcount = 0, tierLevel = 0;
  const seen = [];
  for (let i = 0; i < games.length; i++) {
    const g = games[i], who = g.result === 'win' ? 'me' : g.result === 'loss' ? 'them' : null;
    if (i > 0 && who && !won[who]) { won[who] = true; push(g, 'firstwin', who === 'me' ? `Your first win against ${oppName}` : `${oppName}'s first win against you`, { who }); }
    if (who === 'me') w++; else if (who === 'them') l++;
    seen.push(g);
    if (mset.has(g)) {
      mcount++;
      // streaks: ending a long one, and reaching 3, 5, 10 in a row
      if (who && run.who && run.who !== who && run.n >= 3) push(g, 'ended', `${name(who)} ended ${who === 'me' ? `${oppName}'s` : 'your'} ${run.n}-game winning streak`, { who });
      if (who) run = run.who === who ? { who, n: run.n + 1 } : { who, n: 1 }; else run = { who: null, n: 0 };
      if (who && [3, 5, 10].includes(run.n)) push(g, 'streak', `${name(who)} won ${run.n} in a row`, { who });
      if ([10, 25, 50, 100, 250, 500].includes(mcount)) push(g, 'milestone', `Game ${mcount} between you`, { accent: true });
      const lv = tierOf(seen).level;
      if (lv > tierLevel) { tierLevel = lv; push(g, 'tier', `You became ${TIERS[lv].label}`, { accent: true }); }
    }
    // the lifetime lead changing hands (only once there's a real record)
    const nowLead = Math.sign(w - l);
    if (i >= 3 && nowLead !== 0 && nowLead !== leader) push(g, 'lead', `${nowLead > 0 ? 'You' : oppName} took the lifetime lead (${Math.max(w, l)}–${Math.min(w, l)})`, { who: nowLead > 0 ? 'me' : 'them' });
    if (nowLead !== 0) leader = nowLead;
  }
  const st = stats(games);
  if (st.upset && st.upset.gap >= 100) {
    const g = games.find((x) => (x.id || null) === st.upset.id && x.at === st.upset.at) || g0;
    push(g, 'upset', `Biggest upset: ${name(st.upset.who)} beat ${obj(st.upset.who === 'me' ? 'them' : 'me')} from ${st.upset.gap} points below`, { who: st.upset.who, accent: true });
  }
  const longest = games.reduce((a, b) => ((b.moves || 0) > (a.moves || 0) ? b : a), g0);
  if ((longest.moves || 0) >= 80) push(longest, 'longest', `Longest game: ${Math.ceil(longest.moves / 2)} moves`);
  return out.sort((a, b) => a.at - b.at);
}

// ---- seasons: a window of time; results are counted from the same games, lifetime is never touched ----
const SEASON_DAYS = [7, 14, 30];
function seasonView(s, games, now = Date.now()) {
  const end = s.end, list = games.filter((g) => g.at >= s.start && g.at < end), t = tally(list);
  const done = now >= end;
  return {
    no: s.no, start: s.start, end, done, by: s.by, games: list.length, ...t,
    strip: list.slice(-8).map((g) => short(g.result)),
    winner: done ? (t.w > t.l ? 'me' : t.l > t.w ? 'them' : list.length ? 'tie' : null) : null,
    first: list[0] ? list[0].at : null,
  };
}

// ---- insights for the top of the page: only from enough games to mean something ----
function insights(sums) {
  const out = [], pctOf = (s) => pct(s), withN = (n) => sums.filter((s) => s.games >= n);
  const most = withN(5).sort((a, b) => b.games - a.games)[0];
  if (most) out.push({ key: 'most', label: 'Most played', name: most.name, text: `${most.games} games` });
  const tough = withN(6).filter((s) => pctOf(s) < 45).sort((a, b) => pctOf(a) - pctOf(b))[0];
  if (tough) out.push({ key: 'tough', label: 'Toughest opponent', name: tough.name, text: `you score ${pctOf(tough)}%` });
  const nem = withN(6).filter((s) => s.l - s.w >= 3 && (!tough || s.name !== tough.name)).sort((a, b) => (b.l - b.w) - (a.l - a.w))[0];
  if (nem) out.push({ key: 'nemesis', label: 'Biggest nemesis', name: nem.name, text: `${nem.l} losses, ${nem.w} wins` });
  const best = withN(6).filter((s) => pctOf(s) > 55).sort((a, b) => pctOf(b) - pctOf(a) || b.games - a.games)[0];
  if (best) out.push({ key: 'best', label: 'Best record', name: best.name, text: `${best.w}–${best.l}${best.d ? `, ${best.d} drawn` : ''}` });
  const imp = withN(10).map((s) => ({ s, gain: s.firstHalf != null ? s.lastHalf - s.firstHalf : 0 })).filter((x) => x.gain >= 25).sort((a, b) => b.gain - a.gain)[0];
  if (imp) out.push({ key: 'improved', label: 'Most improved', name: imp.s.name, text: `${imp.s.firstHalf}% → ${imp.s.lastHalf}% in your games` });
  return out;
}
// first half vs second half score, for "most improved"
function halves(games) {
  if (games.length < 10) return { firstHalf: null, lastHalf: null };
  const m = Math.floor(games.length / 2);
  return { firstHalf: pct(tally(games.slice(0, m))), lastHalf: pct(tally(games.slice(m))) };
}

module.exports = { MEANINGFUL_PLIES, DAILY_CAP, ACTIVE_DAYS, TIERS, SEASON_DAYS, byOpponent, meaningful, tierOf, streakOf, summary, stats, moments, seasonView, insights, halves, tally, pct };
