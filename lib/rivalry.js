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

const levelOf = (n, days, w, l) => { let i = 0; for (let k = 1; k < TIERS.length; k++) { const t = TIERS[k]; if (n >= t.games && days >= t.days && Math.min(w, l) >= t.minWins) i = k; } return i; };
function tierOf(games) {
  const m = meaningful(games), days = new Set(m.map((g) => dayOf(g.at))).size;
  const w = m.filter((g) => g.result === 'win').length, l = m.filter((g) => g.result === 'loss').length;
  const i = levelOf(m.length, days, w, l);
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
    last: { at: last.at, result: last.result, id: last.id || null, tc: 'tc' in last ? last.tc : undefined, cat: last.cat || null, color: last.color },
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
function moments(games, oppName, meName) {
  const out = [];
  const name = (who) => (who === 'me' ? meName || 'You' : oppName), obj = (who) => (who === 'me' ? meName || 'you' : oppName);
  const poss = (who) => (who === 'me' ? (meName ? meName + "'s" : 'your') : oppName + "'s"), both = meName ? 'them' : 'you';
  const push = (g, type, text, extra) => out.push({ type, at: g.at, id: g.id || null, text, ...extra });
  if (!games.length) return out;
  const g0 = games[0];
  push(g0, 'first', g0.result === 'draw' ? 'First game: a draw' : `First game: ${g0.result === 'win' ? (meName ? `${meName} won` : 'you won') : `${oppName} won`}`);
  const won = { me: false, them: false };
  if (g0.result === 'win') won.me = true; else if (g0.result === 'loss') won.them = true;
  const mset = new Set(meaningful(games));
  let w = 0, l = 0, run = { who: null, n: 0 }, leader = 0, mcount = 0, tierLevel = 0, mw = 0, ml = 0;
  const mdays = new Set();
  for (let i = 0; i < games.length; i++) {
    const g = games[i], who = g.result === 'win' ? 'me' : g.result === 'loss' ? 'them' : null;
    if (i > 0 && who && !won[who]) { won[who] = true; push(g, 'firstwin', `${who === 'me' ? (meName ? meName + "'s" : 'Your') : oppName + "'s"} first win against ${obj(who === 'me' ? 'them' : 'me')}`, { who }); }
    if (who === 'me') w++; else if (who === 'them') l++;
    if (mset.has(g)) {
      mcount++; mdays.add(dayOf(g.at)); if (who === 'me') mw++; else if (who === 'them') ml++;
      // streaks: ending a long one, and reaching 3, 5, 10 in a row
      if (who && run.who && run.who !== who && run.n >= 3) push(g, 'ended', `${name(who)} ended ${poss(who === 'me' ? 'them' : 'me')} ${run.n}-game winning streak`, { who });
      if (who) run = run.who === who ? { who, n: run.n + 1 } : { who, n: 1 }; else run = { who: null, n: 0 };
      if (who && [3, 5, 10].includes(run.n)) push(g, 'streak', `${name(who)} won ${run.n} in a row`, { who });
      if ([10, 25, 50, 100, 250, 500].includes(mcount)) push(g, 'milestone', `Game ${mcount} between ${both}`, { accent: true });
      const lv = levelOf(mcount, mdays.size, mw, ml);
      if (lv > tierLevel) { tierLevel = lv; push(g, 'tier', `${meName ? 'They' : 'You'} became ${TIERS[lv].label}`, { accent: true }); }
    }
    // the lifetime lead changing hands (only once there's a real record)
    const nowLead = Math.sign(w - l);
    if (i >= 3 && nowLead !== 0 && nowLead !== leader) push(g, 'lead', `${nowLead > 0 ? name('me') : oppName} took the lifetime lead (${Math.max(w, l)}–${Math.min(w, l)})`, { who: nowLead > 0 ? 'me' : 'them' });
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

// ---- curation: which of my rivalries are worth putting first, and why (every reason is computed, never invented) ----
// sum: a summary() plus recent: { n14, n30, deltas (my rating change over my last 5 games with them) }
function reasonsFor(s, ctx, now = Date.now()) {
  const days = (now - s.last.at) / DAY, out = [];
  const add = (key, text, weight) => out.push({ key, text, weight });
  if (s.leadChange === 'them') add('lead', `${s.name} just took the lead`, 5);
  if (s.leadChange === 'me') add('lead', 'You just took the lead', 4.5);
  if (s.streak && s.streak.n >= 3) add('streak', s.streak.who === 'me' ? `You've won ${s.streak.n} straight` : `You've lost ${s.streak.n} straight`, s.streak.who === 'me' ? 3 : 3.5);
  if (s.games >= 6 && Math.abs(s.w - s.l) <= 1) add('close', s.w === s.l ? `Level at ${s.w}–${s.l}` : 'Neck and neck', 3.2);
  if (ctx.tough === s.name) add('tough', 'Your toughest opponent', 2.8);
  if (ctx.most === s.name) add('most', 'Your most played opponent', 2.4);
  if (s.recent && s.recent.n14 >= 4) add('busy', `${s.recent.n14} games in the last two weeks`, 2.2);
  if (s.games >= 5 && days >= 10 && days < 60) add('overdue', `Rematch overdue · ${Math.floor(days)} days`, 2);
  if (s.games >= 2 && now - s.first < 10 * DAY) add('new', 'A new rivalry', 1.5);
  if (s.recent && Math.abs(s.recent.swing) >= 30) add('swing', `${s.recent.swing > 0 ? '+' : '−'}${Math.abs(s.recent.swing)} rating from your last games with ${s.name}`, 1.4);
  return out.sort((a, b) => b.weight - a.weight);
}
function interest(s, reasons, now = Date.now()) {
  const days = (now - s.last.at) / DAY;
  const recency = 3 * Math.exp(-days / 21);
  const volume = 1.2 * Math.log2(1 + s.games);
  const close = s.games >= 4 ? 2 * (1 - Math.abs(s.w - s.l) / s.games) : 0;
  const busy = s.recent ? 0.35 * Math.min(8, s.recent.n30) : 0;
  return recency + volume + close + busy + (reasons[0] ? reasons[0].weight : 0) + (s.tier ? s.tier.level * 0.6 : 0);
}
// up to 4: the strongest first; a rivalry of one game only if there is nothing better
function curate(sums, ctx, now = Date.now()) {
  const scored = sums.filter((s) => s.available && !s.archived).map((s) => { const reasons = reasonsFor(s, ctx, now); return { s, reasons, score: interest(s, reasons, now) }; });
  const good = scored.filter((x) => x.s.games >= 2 && (x.reasons.length || x.s.games >= 4)).sort((a, b) => b.score - a.score);
  return good.slice(0, 4).map((x) => ({ name: x.s.name, why: x.reasons[0] ? x.reasons[0].text : `${x.s.games} games together`, whyKey: x.reasons[0] ? x.reasons[0].key : 'games', score: Math.round(x.score * 10) / 10 }));
}
function recentOf(games, now = Date.now()) {
  const n14 = games.filter((g) => now - g.at < 14 * DAY).length, n30 = games.filter((g) => now - g.at < 30 * DAY).length;
  const swing = games.slice(-5).reduce((a, g) => a + (typeof g.delta === 'number' ? g.delta : 0), 0);
  return { n14, n30, swing };
}

// ---- community: one small record per pair of players, kept up to date as games are saved ----
// key "a|b" (lowercase, sorted); a and b keep their display names. Results are stored from a's side.
const PAIR_RECENT = 30;
const pairKey = (x, y) => [x.toLowerCase(), y.toLowerCase()].sort().join('|');
function pairAdd(map, g) {
  // g: { id, t, w (white name), b (black name), result 'w'|'b'|'draw', plies, reason }
  if (!g.id || !g.w || !g.b || (g.plies || 0) < 2 || g.reason === 'ended by an admin') return false;
  const k = pairKey(g.w, g.b), [ka] = k.split('|');
  const aName = g.w.toLowerCase() === ka ? g.w : g.b, bName = aName === g.w ? g.b : g.w;
  const e = map[k] || (map[k] = { a: aName, b: bName, n: 0, aw: 0, bw: 0, d: 0, first: g.t, last: 0, lc: 0, lead: 0, recent: [] });
  if (e.recent.some((x) => x.id === g.id)) return false;                  // saving is retried: count each game once
  const winner = g.result === 'draw' ? 'd' : (g.result === 'w' ? g.w : g.b).toLowerCase() === ka ? 'a' : 'b';
  e.n++; if (winner === 'a') e.aw++; else if (winner === 'b') e.bw++; else e.d++;
  const lead = Math.sign(e.aw - e.bw);
  if (lead !== 0 && e.lead !== 0 && lead !== e.lead) e.lc++;              // the lead changed hands
  if (lead !== 0) e.lead = lead;
  e.first = Math.min(e.first, g.t); e.last = Math.max(e.last, g.t);
  e.recent = [...e.recent, { id: g.id, t: g.t, r: winner, p: g.plies || 0 }].sort((x, y) => x.t - y.t).slice(-PAIR_RECENT);
  return true;
}
// full games in the recent list, at most DAILY_CAP a day: the farming-proof activity count
function pairFull(e, since) {
  const per = new Map(); let n = 0;
  for (const x of e.recent) {
    if (x.t < since || x.p < MEANINGFUL_PLIES) continue;
    const d = dayOf(x.t), c = per.get(d) || 0;
    if (c < DAILY_CAP) { per.set(d, c + 1); n++; }
  }
  return n;
}
// what to show "around the community": a few picks per kind, a featured one, and why each is interesting
function community(map, alive, now = Date.now()) {
  const all = Object.values(map).filter((e) => alive(e.a) && alive(e.b));
  const close = (e) => 1 - Math.abs(e.aw - e.bw) / Math.max(1, e.n);
  const view = (e, kind, why) => ({ kind, why, a: e.a, b: e.b, n: e.n, aw: e.aw, bw: e.bw, d: e.d, lc: e.lc, first: e.first, last: e.last,
    strip: e.recent.slice(-10).map((x) => x.r), recentFull: pairFull(e, now - 30 * DAY) });
  const picks = [], used = new Set(), take = (e, kind, why) => { const k = pairKey(e.a, e.b); if (used.has(k)) return; used.add(k); picks.push(view(e, kind, why)); };
  // most competitive: a real record that stays close, with the lead changing hands, and still being played
  all.filter((e) => e.n >= 6 && close(e) >= 0.75 && now - e.last < 45 * DAY && pairFull(e, 0) >= 4)
    .sort((x, y) => y.lc - x.lc || close(y) - close(x) || y.n - x.n).slice(0, 3)
    .forEach((e) => take(e, 'competitive', e.lc >= 2 ? `The lead has changed hands ${e.lc} times` : e.aw === e.bw ? `Dead level after ${e.n} games` : `Separated by one game after ${e.n}`));
  // favourites: the most played pairs that keep coming back
  all.filter((e) => e.n >= 10 && now - e.last < 60 * DAY)
    .sort((x, y) => y.n - x.n).slice(0, 3)
    .forEach((e) => take(e, 'favourite', `${e.n} games since ${new Date(e.first).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`));
  // rising: new or newly busy pairs (counted the farming-proof way)
  all.filter((e) => pairFull(e, now - 14 * DAY) >= 3 && (now - e.first < 30 * DAY || pairFull(e, now - 14 * DAY) >= 5))
    .sort((x, y) => pairFull(y, now - 14 * DAY) - pairFull(x, now - 14 * DAY)).slice(0, 3)
    .forEach((e) => take(e, 'rising', now - e.first < 30 * DAY ? `${e.n} games since they first met ${Math.max(1, Math.round((now - e.first) / DAY))} days ago` : `${pairFull(e, now - 14 * DAY)} full games in the last two weeks`));
  // the featured matchup: the closest of the busiest
  const score = (p) => p.n * 0.15 + (1 - Math.abs(p.aw - p.bw) / Math.max(1, p.n)) * 3 + p.lc * 0.8 + p.recentFull * 0.4 + Math.exp(-(now - p.last) / (14 * DAY)) * 2;
  return picks.sort((x, y) => score(y) - score(x));                      // best first; the first one is featured
}

module.exports = { reasonsFor, curate, recentOf, pairKey, pairAdd, pairFull, community, MEANINGFUL_PLIES, DAILY_CAP, ACTIVE_DAYS, TIERS, SEASON_DAYS, byOpponent, meaningful, tierOf, streakOf, summary, stats, moments, seasonView, insights, halves, tally, pct };
