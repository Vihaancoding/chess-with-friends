// STREAK HUNT: breaks found from the canonical archive, the announcement once per game, the feed, breaker stats and
// achievements, ON THE LINE, historical backfill, and the games that must not count. Run: node scripts/test-streakhunt.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY; process.env.ADMIN_KEY = 'k';
const RT = require('../lib/realtime');
const pushed = []; const realPublish = RT.publish; RT.publish = async (topic, ev, data) => { if (ev === 'sbreak') pushed.push({ topic, data }); return realPublish(topic, ev, data); };
const SH = require('../lib/streakhunt'), handler = require('../lib/app'), store = require('../lib/store');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const call = (route, body, who) => new Promise((resolve) => handler({ method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body }, { setHeader() {}, writeHead(c) { this.code = c; }, end(b) { let j = {}; try { j = JSON.parse(b || '{}'); } catch {} resolve({ status: this.code, ...j }); } }));
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
// rows like the archive's: i = order, r = W/L/D, opp = opponent
const row = (i, r, opp, extra = {}) => ({ id: 'G' + String(i).padStart(4, '0') + '-x', code: 'G' + i, at: 1000 + i * 10, result: r === 'W' ? 'win' : r === 'L' ? 'loss' : 'draw', opp, moves: 30, reason: 'checkmate', ...extra });
const seq = (s, opps) => [...s].map((c, i) => row(i + 1, c, opps ? opps[i % opps.length] : 'opp' + i));

(async () => {
  console.log('finding a break');
  let b = SH.breakOf(seq('WWWL'), 'G0004-x');
  ok('three wins then a loss: a 3-game streak was broken', b && b.len === 3 && b.opps === 3, b);
  ok('a loss with no streak before it breaks nothing', SH.breakOf(seq('LL'), 'G0002-x') === null);
  ok('a 2-game streak is below the threshold', SH.breakOf(seq('WWL'), 'G0003-x') === null);
  ok('a draw ends a streak, but nobody broke it', SH.breakOf(seq('WWWD'), 'G0004-x') === null);
  ok('consecutive wins: the longest run before the loss counts, not earlier ones', SH.breakOf(seq('WWWWLWWWWWWL'), 'G0012-x').len === 6);
  ok('a draw in the middle restarts the count', SH.breakOf(seq('WWWWDWWWL'), 'G0009-x').len === 3);
  const shuffled = seq('WWWWWL').reverse();
  ok('history in any order: sorted by time first', SH.breakOf(shuffled, 'G0006-x').len === 5);
  const dup = [...seq('WWWL'), ...seq('WWWL')];
  ok('the same games twice (duplicate result events) count once', SH.breakOf(dup, 'G0004-x').len === 3);

  console.log('games that must not count');
  b = SH.breakOf(seq('WWWL', ['alt']), 'G0004-x');
  ok('a streak built against one account is not announced (farming)', !SH.qualifies(b, 'me'), b);
  b = SH.breakOf(seq('WWWL', ['alt1', 'alt2']), 'G0004-x');
  ok('...nor against two', !SH.qualifies(b, 'me'), b);
  ok('three different opponents is a real streak', SH.qualifies(SH.breakOf(seq('WWWL'), 'G0004-x'), 'me'));
  ok('a very short game proves nothing', !SH.qualifies(SH.breakOf([...seq('WWW'), row(4, 'L', 'x', { moves: 6 })], 'G0004-x'), 'me'));
  ok('a private room game is not announced', !SH.qualifies(SH.breakOf([...seq('WWW'), row(4, 'L', 'x', { priv: 1 })], 'G0004-x'), 'me'));
  ok('a fair play forfeit is not a takedown', !SH.qualifies(SH.breakOf([...seq('WWW'), row(4, 'L', 'x', { reason: 'fair play forfeit' })], 'G0004-x'), 'me'));
  ok('no self-play: breaker and victim are different players', !SH.qualifies({ ...SH.breakOf(seq('WWWL'), 'G0004-x'), breaker: 'Me' }, 'me'));
  ok('aborted and invalid games are ignored (Streaks.valid)', SH.breakOf([...seq('WWW'), row(4, 'W', 'z', { reason: 'aborted' }), row(5, 'L', 'q')], 'G0005-x').len === 3);

  console.log('historical');
  const hist = seq('WWWLWWWWWLWLWWWWL');
  const all = SH.breaksIn(hist), one = hist.filter((r) => r.result === 'loss').map((r) => SH.breakOf(hist, r.id)).filter(Boolean);
  ok('one pass over the archive finds the same breaks as one game at a time', JSON.stringify(all.map((x) => [x.id, x.len])) === JSON.stringify(one.map((x) => [x.breaker && hist.find((r) => r.opp === x.breaker && r.result === 'loss').id, x.len])) && all.length === 3, { all, one });

  console.log('the announcement');
  const a3 = SH.announce({ id: 'x', victim: 'ann', breaker: 'bob', len: 3 }), a17 = SH.announce({ id: 'x', victim: 'ann', breaker: 'bob', len: 17 }), a25 = SH.announce({ id: 'y', victim: 'ann', breaker: 'bob', len: 25 });
  ok('it names the player, the length and the breaker', /ann's 3-game win streak has been ENDED/.test(a3.body), a3);
  ok('it gets more dramatic as the streak gets longer', a3.level === 0 && a17.level === 3 && a25.level === 4 && /History rewritten/.test(a17.tail), [a3, a17, a25]);
  ok('20+ is the king (or N WINS. ONE DEFEAT.)', /KING HAS FALLEN|25 WINS\. ONE DEFEAT/.test(a25.head), a25);
  ok('ON THE LINE gets its own headline', /ON THE LINE/.test(SH.announce({ id: 'x', victim: 'a', breaker: 'b', len: 5, line: true }).head));

  console.log('breaker stats and achievements');
  let s = SH.breakerStats([{ id: '1', victim: 'a', len: 4, at: 1 }]);
  ok('first break: First Blood', s.total === 1 && s.ach.join() === 'first' && s.title === 'First Blood', s);
  s = SH.breakerStats([{ id: '1', victim: 'a', len: 4, at: 1 }, { id: '2', victim: 'b', len: 12, at: 2 }]);
  ok('a 10+ streak: Giant Slayer, and the biggest is remembered', s.biggest === 12 && s.biggestOf.victim === 'b' && s.title === 'Giant Slayer', s);
  ok('15+: Legend Hunter; 20+: Streak Executioner', SH.breakerStats([{ id: '1', victim: 'a', len: 16, at: 1 }]).title === 'Legend Hunter' && SH.breakerStats([{ id: '1', victim: 'a', len: 21, at: 1 }]).title === 'Streak Executioner' && SH.breakerStats([{ id: '1', victim: 'a', len: 21, at: 1 }]).ach.length === 4);
  s = SH.breakerStats([{ id: '1', victim: 'a', len: 3, at: 1 }, { id: '2', victim: 'A', len: 3, at: 1 + 86400e3 }, { id: '3', victim: 'a', len: 3, at: 1 + 40 * 86400e3 }]);
  ok('the same victim again within 30 days counts once (no farming off a friend)', s.total === 2, s);
  ok('most recent break is tracked', s.recent && s.recent.id === '3', s);

  console.log('ON THE LINE');
  ok('the line is live while no loss or draw has happened since it was set', SH.lineLive({ nw: 2 }, { cur: 4, l: 1, d: 1 }) && !SH.lineLive({ nw: 2 }, { cur: 4, l: 2, d: 1 }) && !SH.lineLive({ nw: 2 }, { cur: 2, l: 1, d: 1 }));

  console.log('live games through the API');
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = {}; for (const n of ['ann', 'bob', 'cat', 'dan', 'eve', 'fay']) P[n] = await su(n);
  const MV = ['e2e4', 'a7a6', 'f1c4', 'a6a5', 'd1h5', 'a5a4', 'a2a3', 'b7b6', 'h2h3', 'b6b5', 'h5f7'];   // 11 plies, white mates
  const win = async (w, b) => { const g = await call('create', { color: 'w', tc: { base: 600, inc: 0 } }, w); await call('join', { code: g.code }, b); for (let i = 0; i < MV.length; i++) { const r = await call('move', { code: g.code, from: sq(MV[i].slice(0, 2)), to: sq(MV[i].slice(2, 4)) }, i % 2 ? b : w); if (!r.ok) throw new Error('move ' + MV[i] + ': ' + r.error); } await new Promise((r) => setTimeout(r, 50)); return g.code; };
  await win(P.ann, P.bob); await win(P.ann, P.cat);
  let r = await call('streak_line', { on: true }, P.ann);
  ok('the line needs a 3+ streak', r.status === 400, r);
  await win(P.ann, P.dan);
  r = await call('streak_hunt', {}, P.eve);
  ok('the hunted list shows ann on 3', r.status === 200 && r.hunted.length === 1 && r.hunted[0].name === 'ann' && r.hunted[0].cur === 3 && r.hunted[0].lastTs > 0, r.hunted);
  r = await call('streak_line', { on: true }, P.ann);
  ok('ann puts the streak on the line', r.ok && r.line === true, r);
  r = await call('streak_hunt', {}, P.eve);
  ok('...and it shows', r.hunted[0].line === true, r.hunted);
  const before = pushed.length;
  await win(P.eve, P.ann);
  r = await call('streak_hunt', {}, P.fay);
  const ev = r.feed[0];
  ok('eve breaks the streak: in the feed with victim, length, breaker, game and time', ev && ev.victim === 'ann' && ev.breaker === 'eve' && ev.len === 3 && ev.code && ev.at > 0 && ev.id, ev);
  ok('it was on the line, and says so', ev && ev.line === true && /ON THE LINE/.test(ev.head), ev);
  ok('announced live to the whole site, once', pushed.length === before + 1 && pushed[pushed.length - 1].topic === 'lobby', pushed.slice(before));
  r = await call('profile', { name: 'eve' }, P.fay);
  ok("eve's profile: First Blood", r.hunt && r.hunt.total === 1 && r.hunt.title === 'First Blood' && r.hunt.recent.victim === 'ann', r.hunt);
  r = await call('streak_hunt', {}, P.ann);
  ok("ann's streak is over and off the hunted list, line cleared", !r.hunted.length && r.me.cur === 0 && !r.me.line, r);

  console.log('duplicates and simultaneous completions');
  const g0 = await store.get('game:' + ev.id);
  const again = await Promise.all([handler.huntAfterGame(g0), handler.huntAfterGame(g0), handler.huntAfterGame(g0)]);
  r = await call('streak_hunt', {}, P.fay);
  ok('the same result event three times at once: no new announcement, one feed entry', again.every((x) => x === null) && r.feed.filter((x) => x.id === ev.id).length === 1 && pushed.length === before + 1, { again, n: r.feed.length });
  // two different breaks landing at the same moment, written straight into the archive
  const mk = async (victim, breaker, n, tag) => {
    const rows = [...Array(n)].map((_, i) => row(i + 1, 'W', tag + i)).concat([row(n + 1, 'L', breaker, { id: tag + '-end', code: tag })]).reverse();
    await store.set('games:' + victim, rows);
    return { id: tag + '-end', code: tag, endedAt: 9e12, result: 'w', players: { w: { name: breaker }, b: { name: victim } } };
  };
  const [gx, gy] = [await mk('cat', 'bob', 10, 'X'), await mk('dan', 'bob', 16, 'Y')];
  const both = await Promise.all([handler.huntAfterGame(gx), handler.huntAfterGame(gy)]);
  r = await call('profile', { name: 'bob' }, P.fay);
  ok('two breaks by the same player at the same moment: both recorded, none lost', both.every(Boolean) && r.hunt.total === 2 && r.hunt.biggest === 16, r.hunt);
  ok('a 16-game streak ended: Legend Hunter (and Giant Slayer on the way)', r.hunt.title === 'Legend Hunter' && r.hunt.ach.includes('giant'), r.hunt);
  ok('the big one is announced with more drama', both[1].level === 3, both[1]);

  console.log('historical backfill');
  await store.set('games:fay', [...Array(5)].map((_, i) => row(i + 1, 'W', 'h' + i)).concat([row(6, 'L', 'eve', { id: 'H-old', code: 'HOLD' })]).reverse());
  await store.del('sbrkbuilt');
  const n0 = pushed.length;
  await handler.huntBackfill();
  r = await call('streak_hunt', {}, P.fay);
  const old = r.feed.find((x) => x.id === 'H-old');
  ok('an old break from the archive is found', old && old.victim === 'fay' && old.breaker === 'eve' && old.len === 5 && old.hist === 1, r.feed);
  ok('backfill announces nothing live', pushed.length === n0, pushed.slice(n0));
  await store.del('sbrkbuilt'); await handler.huntBackfill();
  r = await call('streak_hunt', {}, P.fay);
  ok('running the backfill again duplicates nothing', r.feed.filter((x) => x.id === 'H-old').length === 1 && r.feed.filter((x) => x.id === ev.id).length === 1, r.feed.map((x) => x.id));
  r = await call('profile', { name: 'eve' }, P.fay);
  ok("the old break is on eve's record too", r.hunt.total === 2, r.hunt);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
