// Rivalries: head-to-head records derived from the server's game archive, tiers that resist farming, streaks,
// moments, seasons, archiving, the in-room "best of 3" rematch, and permissions.
// Drives the real API in-process with in-memory storage. Run: node scripts/test-rivalries.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
process.env.ADMIN_KEY = 'test-admin-key';
const handler = require('../lib/app');
const store = require('../lib/store');
const Riv = require('../lib/rivalry');

let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };
function call(route, body, who) {
  return new Promise((resolve) => {
    const req = { method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body };
    const res = { setHeader() {}, writeHead(code) { this.code = code; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } };
    handler(req, res);
  });
}
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
const MATE = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];                       // 7 plies: white mates
const LONG = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'd2d3', 'd7d6', 'b1c3', 'g8f6', 'c1g5', 'c8g4'];   // 12 plies
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const ann = await su('ann'), bob = await su('bob'), cat = await su('cat');
  const P = { ann, bob, cat };
  // play a game: `white` plays White; end: 'mate' (white wins), 'draw', 'wresign' / 'bresign' after LONG, 'none' (resign before moving)
  const game = async (white, black, end) => {
    const g = await call('create', { color: 'w', tc: { base: 300, inc: 0 } }, P[white]);
    await call('join', { code: g.code }, P[black]);
    const play = async (ucis) => { for (const [i, u] of ucis.entries()) await call('move', { code: g.code, from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)) }, i % 2 ? P[black] : P[white]); };
    if (end === 'mate') await play(MATE);
    else if (end === 'draw') { await play(LONG); await call('draw_offer', { code: g.code }, P[white]); await call('draw_accept', { code: g.code }, P[black]); }
    else if (end === 'wresign') { await play(LONG); await call('resign', { code: g.code }, P[white]); }
    else if (end === 'bresign') { await play(LONG); await call('resign', { code: g.code }, P[black]); }
    else if (end === 'none') await call('resign', { code: g.code }, P[white]);
    await wait(20);
    return g.code;
  };
  const list = async (who) => (await call('rivalries', {}, P[who])).list;

  console.log('empty');
  let r = await call('rivalries', {}, ann);
  ok('no rivalries yet', r.list.length === 0 && r.insights.length === 0, r);
  r = await call('rivalries', {}, null);
  ok('needs to be signed in', r.status === 401);

  console.log('first games');
  await game('ann', 'bob', 'mate');
  let a = await list('ann'), b = await list('bob');
  ok('ann 1–0 against bob', a.length === 1 && a[0].name === 'bob' && a[0].w === 1 && a[0].l === 0 && a[0].games === 1, a);
  ok('bob sees the same game from his side', b[0].name === 'ann' && b[0].l === 1 && b[0].w === 0, b);
  ok('one game: Acquaintances, a 1-win streak, a strip of one', a[0].tier.key === 'acq' && a[0].streak.who === 'me' && a[0].streak.n === 1 && a[0].strip.join() === 'w', a[0]);
  await game('bob', 'ann', 'draw');
  a = await list('ann');
  ok('draws are counted as draws', a[0].d === 1 && a[0].games === 2 && a[0].streak === null, a[0]);
  await game('ann', 'bob', 'none');
  a = await list('ann');
  ok('a game nobody played (resigned before moving) does not count', a[0].games === 2, a[0]);

  console.log('duplicates and incomplete history');
  const key = 'games:ann', raw = await store.get(key), rows = raw.list || raw;
  const dup = [...rows, rows[0], { opp: 'bob', at: rows[0].at - 1000, result: 'loss', code: 'OLDXX' }];   // a duplicate row, and an old row with no id/metadata
  await store.set(key, { v: (raw.v || 0) + 1, list: dup });
  a = await list('ann');
  ok('a duplicated archive row is counted once; old rows without details still count', a[0].games === 3 && a[0].l === 1, a[0]);
  r = await call('rivalry', { name: 'bob' }, ann);
  ok('…and show without a replay link', r.encounters.some((e) => !e.id && e.result === 'loss'), r.encounters);

  console.log('tiers resist farming');
  for (let i = 0; i < 8; i++) await game(i % 2 ? 'bob' : 'ann', i % 2 ? 'ann' : 'bob', 'bresign');   // 8 full games, all today
  a = await list('ann');
  ok('8 full games in one day: still Acquaintances (3 a day count)', a[0].tier.key === 'acq' && a[0].tier.meaningful === 3, a[0].tier);
  ok('the next tier says what is missing', /Rivals/.test(a[0].tier.next.label) && /day/.test(a[0].tier.next.text), a[0].tier.next);
  // spread the games over several days, as if played over a week
  const r2 = await store.get(key), l2 = (r2.list || r2).slice().sort((x, y) => x.at - y.at);
  const base = Date.now() - 6 * 86400e3;
  l2.forEach((x, i) => { x.at = base + Math.floor(i / 2) * 86400e3 + i * 1000; });
  await store.set(key, { v: (r2.v || 0) + 1, list: l2 });
  a = await list('ann');
  ok('over several days they become Rivals', a[0].tier.key === 'riv', a[0].tier);
  ok('Nemeses needs both of you winning', a[0].tier.next && /Nemeses/.test(a[0].tier.next.label), a[0].tier.next);

  console.log('the head-to-head page');
  r = await call('rivalry', { name: 'BOB' }, ann);
  ok('names are case-insensitive', r.rival && r.rival.name === 'bob');
  const st = r.stats;
  ok('stats add up', st.games === st.w + st.l + st.d && st.games === r.encounters.length && st.pct >= 0 && st.pct <= 100, st);
  ok('longest streaks and colours are there', st.longest.me >= 1 && st.colors.w + st.colors.b >= st.games - 1, st);
  ok('the opening is known for archived games', !!(st.opening && st.opening.name), st.opening);
  ok('encounters are newest first and link to their games', r.encounters[0].at >= r.encounters[1].at && r.encounters.filter((e) => e.id).length >= st.games - 1, r.encounters.slice(0, 2));
  const types = r.moments.map((m) => m.type);
  ok('moments: first game, first wins, the lead, the tier', types[0] === 'first' && types.includes('firstwin') && types.includes('tier'), types);
  ok('moments link to their games', r.moments.filter((m) => m.type !== 'season').every((m) => 'id' in m), r.moments);
  r = await call('rivalry', { name: 'cat' }, ann);
  ok('no rivalry with someone you never played', r.status === 404, r);

  console.log('seasons');
  r = await call('rivalry_season', { name: 'bob', action: 'start', days: 3 }, ann);
  ok('season length must be 7, 14 or 30 days', r.status === 400);
  r = await call('rivalry_season', { name: 'cat', action: 'start', days: 7 }, ann);
  ok('no season with someone you never played', r.status === 400, r);
  r = await call('rivalry_season', { name: 'bob', action: 'start', days: 7 }, ann);
  ok('ann starts a 7-day season', r.ok, r);
  r = await call('rivalry_season', { name: 'ann', action: 'start', days: 14 }, bob);
  ok('only one season at a time (either player)', r.status === 400 && /already/.test(r.error), r);
  const life0 = (await call('rivalry', { name: 'bob' }, ann)).stats.games;
  await game('ann', 'bob', 'mate'); await game('ann', 'bob', 'mate'); await game('bob', 'ann', 'mate');
  r = await call('rivalry', { name: 'ann' }, bob);
  ok('bob sees the same season: 1–2 for him', r.season && r.season.no === 1 && r.season.games === 3 && r.season.w === 1 && r.season.l === 2, r.season);
  r = await call('rivalry_season', { name: 'ann', action: 'end' }, bob);
  r = await call('rivalry', { name: 'bob' }, ann);
  ok('ended: kept with its winner', !r.season && r.seasons[0].done && r.seasons[0].winner === 'me' && r.seasons[0].games === 3, r.seasons);
  ok('the lifetime record is untouched by the season', r.stats.games === life0 + 3, [r.stats.games, life0]);
  ok('the season result is in the timeline', r.moments.some((m) => m.type === 'season' && /Season 1: you won it 2–1/.test(m.text)), r.moments.slice(-3));
  r = await call('rivalry_season', { name: 'bob', action: 'start', days: 14 }, ann);
  r = await call('rivalry', { name: 'bob' }, ann);
  ok('a new season starts at 0–0 and is number 2', r.season.no === 2 && r.season.games === 0 && r.seasons.length === 2, r.season);

  console.log('archive');
  await call('rivalry_archive', { name: 'bob', on: true }, ann);
  a = await list('ann');
  ok('archived', a[0].archived === true);
  ok("…only for ann", !(await list('bob'))[0].archived);
  await game('bob', 'ann', 'mate');
  a = await list('ann');
  ok('a new game brings it back', a[0].archived === false, a[0]);

  console.log('the result card');
  r = await call('rivalry_brief', { name: 'bob' }, ann);
  ok('a brief head-to-head for the result card', r.rival && r.rival.games === a[0].games && r.rival.name === 'bob', r.rival);
  r = await call('rivalry_brief', { name: 'cat' }, ann);
  ok('none for a first meeting', r.rival === null);

  console.log('best of 3 from the result card');
  const code = await game('ann', 'bob', 'mate');
  r = await call('rematch', { code, series: 'bo3' }, bob);
  let room = await call('room', { code }, ann);
  ok('the offer is shown to the other player', room.rematchSeries === 'bo3' && room.rematch.length === 1, room.rematchSeries);
  await call('rematch', { code }, ann);
  room = await call('room', { code }, ann);
  ok('accepting starts a best-of-3 series, colours swapped', room.match && room.match.fmt === 'bo' && room.match.n === 3 && !room.status.over && room.players.w.name === 'bob', room.match);
  ok('…and the offer is cleared', room.rematchSeries === null);

  const code2 = await game('ann', 'bob', 'mate');
  await call('rematch', { code: code2 }, ann);                                 // ann asks for a plain rematch first
  await call('rematch', { code: code2, series: 'bo3' }, bob);                  // bob's best-of-3 can't override that
  room = await call('room', { code: code2 }, ann);
  ok('a best of 3 can\'t be forced on someone who asked for one game', !room.status.over && !room.match, room.match);
  r = await call('rivalry_archive', { name: 'cat', on: true }, ann);
  ok('only rivalries you have can be archived', r.status === 404, r);

  console.log('curation');
  r = await call('rivalries', {}, ann);
  ok('bob is featured, with a reason taken from the record', r.featured.length >= 1 && r.featured[0].name === 'bob' && typeof r.featured[0].why === 'string' && r.featured[0].why.length > 3, r.featured);
  ok('every rival carries its best reason (or none)', r.list.every((x) => 'why' in x), r.list.map((x) => x.why));
  const reasons = Riv.reasonsFor({ name: 'zed', games: 12, w: 6, l: 6, d: 0, leadChange: 'them', streak: { who: 'them', n: 4 }, first: Date.now() - 90 * 864e5, last: { at: Date.now() - 864e5 }, recent: { n14: 5, n30: 8, swing: -40 } }, { tough: 'zed', most: null });
  ok('reasons come from the numbers: lead change first, then the losing streak…', reasons[0].text === 'zed just took the lead' && reasons.some((x) => x.text === "You've lost 4 straight") && reasons.some((x) => x.text === 'Level at 6–6'), reasons.map((x) => x.text));
  ok('…and a one-game rivalry is never featured over real ones', Riv.curate([{ name: 'one', games: 1, w: 1, l: 0, d: 0, available: true, last: { at: Date.now() }, first: Date.now(), tier: { level: 0 } }], {}).length === 0);

  console.log('around the community');
  r = await call('rivalry_community', {}, cat);
  const all = [r.featured, ...r.picks].filter(Boolean);
  const mineToo = await call('rivalry_community', {}, ann);
  const srvwide = await call('rivalry_community', { all: true }, ann);
  ok('the main page view is the same for everyone (yours included), at most 3', [srvwide.featured, ...srvwide.picks].filter(Boolean).length <= 3 && JSON.stringify(srvwide) === JSON.stringify(await call('rivalry_community', { all: true }, cat)), srvwide);
  ok("you don't see your own matchups there", ![mineToo.featured, ...mineToo.picks].filter(Boolean).some((p) => [p.a, p.b].includes('ann')), mineToo);
  ok('ann vs bob shows up for someone else, with why', all.some((p) => [p.a, p.b].sort().join() === 'ann,bob' && p.why && p.n >= 10), all);
  ok('the reason matches the score', all.filter((p) => p.kind === 'competitive' && p.lc < 2).every((p) => (p.aw === p.bw && /Dead level/.test(p.why)) || (Math.abs(p.aw - p.bw) === 1 && /one win/.test(p.why)) || new RegExp(Math.abs(p.aw - p.bw) + ' wins apart').test(p.why)), all.map((p) => [p.aw, p.bw, p.why]));
  ok('the strip says who won each game (a, b or draw)', all.every((p) => p.strip.every((x) => ['a', 'b', 'd'].includes(x))));
  const rec0 = await store.get('rpairs'), n0 = rec0.map['ann|bob'].n;
  const codeN = await game('ann', 'bob', 'mate');
  const rec1 = await store.get('rpairs');
  ok('a new game updates the index at once', rec1.map['ann|bob'].n === n0 + 1, [n0, rec1.map['ann|bob'].n]);
  const m = { }; const g1 = { id: 'X1', t: 1, w: 'p', b: 'q', result: 'w', plies: 20 };
  Riv.pairAdd(m, g1); Riv.pairAdd(m, g1);
  ok('the same game saved twice counts once', m['p|q'].n === 1);
  Riv.pairAdd(m, { id: 'X2', t: 2, w: 'q', b: 'p', result: 'w', plies: 20 }); Riv.pairAdd(m, { id: 'X3', t: 3, w: 'q', b: 'p', result: 'w', plies: 20 });
  ok('lead changes are counted', m['p|q'].lc === 1 && m['p|q'].aw === 1 && m['p|q'].bw === 2, m['p|q']);
  Riv.pairAdd(m, { id: 'X4', t: 4, w: 'p', b: 'q', result: 'w', plies: 1 }); Riv.pairAdd(m, { id: 'X5', t: 5, w: 'p', b: 'q', result: 'w', plies: 30, reason: 'ended by an admin' });
  ok('unplayed and admin-ended games are left out', m['p|q'].n === 3);
  r = await call('rivalry_public', { a: 'ann', b: 'bob' }, cat);
  ok("someone else's rivalry opens from the public archive", r.a.name === 'ann' && r.b.name === 'bob' && r.stats.games > 10 && r.encounters.length === r.stats.games, r.stats);
  ok('its story is told with both names, never "You"', r.moments.length > 3 && r.moments.every((x) => !/\b(You|you|your|Your)\b/.test(x.text)), r.moments.map((x) => x.text));
  r = await call('rivalry_public', { a: 'ann', b: 'nobody' }, cat);
  ok('unknown players: nothing', r.status === 404);

  console.log('accounts that are gone');
  const lb = await store.get('lb'); delete lb.bob; await store.set('lb', lb);
  a = await list('ann');
  ok('history stays, rematch is not offered', a[0].name === 'bob' && a[0].available === false && a[0].games > 0, a[0]);
  r = await call('rivalry_public', { a: 'ann', b: 'bob' }, cat);
  ok('…and removed accounts are not shown to others', r.status === 404, r);

  console.log('insights only from enough games');
  const sums = [{ name: 'x', games: 3, w: 0, l: 3, d: 0 }, { name: 'y', games: 12, w: 2, l: 9, d: 1, firstHalf: 10, lastHalf: 40 }, { name: 'z', games: 8, w: 6, l: 1, d: 1 }];
  const ins = Riv.insights(sums), keys = ins.map((x) => x.key);
  ok('no insight from 3 games', !ins.some((x) => x.name === 'x'), ins);
  ok('most played, toughest, best record, most improved', keys.includes('most') && keys.includes('tough') && keys.includes('best') && keys.includes('improved'), ins);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
