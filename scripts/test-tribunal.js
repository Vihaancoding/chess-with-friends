// Fair play: the automatic forfeit (only when sure), the announcement, the community poll, bans, appeals, the audit trail,
// and spectators seeing a live game a few moves late. Run: node scripts/test-tribunal.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
process.env.ADMIN_KEY = 'test-admin-key'; delete process.env.ANTHROPIC_API_KEY;
const handler = require('../lib/app');
const store = require('../lib/store');
const C = require('../public/chess.js');
const T = require('../lib/tribunal.js');
const fx = require('./fixtures/damage-games.json');

let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function call(route, body, who) {
  return new Promise((resolve) => {
    const req = { method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body };
    const res = { setHeader() {}, writeHead(code) { this.code = code; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } };
    handler(req, res);
  });
}
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
const LONG = fx[9].ucis;                                           // 50 plies

(async () => {
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = {}; for (const n of ['ann', 'bob', 'cat', 'dan', 'eve', 'fay']) P[n] = await su(n);
  await call('admin_claim', { key: 'test-admin-key' }, P.dan);
  const start = async (w, b) => { const g = await call('create', { color: 'w', tc: { base: 300, inc: 0 } }, P[w]); await call('join', { code: g.code }, P[b]); return g.code; };
  const mv = (code, u, who) => call('move', { code, from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)), promo: u[4] ? u[4].toUpperCase() : undefined }, P[who]);

  console.log('the rules');
  const strong = { n: 22, match: 97, acpl: 3, cv: 0.2 };
  ok('a very engine-like window with steady times is sure enough', T.judge(strong).strong && T.judge(strong).confidence >= 0.95);
  ok('engine-like moves alone are not (one signal)', !T.judge({ ...strong, cv: 0.8 }).strong);
  ok('a trace from their browser plus engine-like moves is', T.judge({ ...strong, cv: 0.8 }, { ext: 1 }).strong);
  ok('a trace alone, or too few moves, or bullet, never is', !T.judge({ n: 22, match: 60, acpl: 40, cv: 0.2 }, { ext: 3 }).strong && !T.judge({ ...strong, n: 10 }).strong && !T.judge(strong, { tc: { base: 60, inc: 0 } }).strong);
  ok('phrases: threats, slurs and missing names are refused', T.phraseProblem('{name} should die') && T.phraseProblem('no name here at all') && !T.phraseProblem('{name} brought a robot to a chess fight') && T.DEFAULT_PHRASES.every((p) => !T.phraseProblem(p)));
  ok('few votes mean a warning; a thin vote cannot give a long ban', T.decide({ a: { o: 'perm' } }).key === 'warn' && T.decide({ a: { o: 'perm' }, b: { o: 'perm' }, c: { o: 'perm' } }).key === 'ban24h' && T.decide(Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((k) => [k, { o: 'perm' }]))).key === 'perm');

  console.log('an uncertain detection does nothing');
  handler.fairDeps = { scan: async () => ({ n: 22, match: 80, acpl: 14, cv: 0.9 }) };
  const g1 = await start('ann', 'bob');
  for (let i = 0; i < 44; i++) await mv(g1, LONG[i], i % 2 ? 'bob' : 'ann');
  await sleep(300);
  let r1 = await call('room', { code: g1 }, P.cat);
  ok('no forfeit on a weak result', !r1.status.over && !(await handler.fairCase(r1.hist ? 'x' : 'x')));
  await call('resign', { code: g1 }, P.ann);

  console.log('a sure detection forfeits once');
  handler.fairDeps = { scan: async (h, color) => (color === 'w' ? strong : null) };
  const g2 = await start('ann', 'bob');
  for (let i = 0; i < 40; i++) await mv(g2, LONG[i], i % 2 ? 'bob' : 'ann');
  await sleep(500);
  r1 = await call('room', { code: g2 }, P.bob);
  ok('the game is over: ann forfeited, bob won', r1.status.over && r1.status.reason === 'fair play forfeit' && r1.status.result === 'b', r1.status);
  ok('both players are told: the snapshot carries who and how sure', r1.fp && r1.fp.name === 'ann' && r1.fp.conf >= 0.95, r1.fp);
  const gid = r1.fp.id, c0 = await handler.fairCase(gid);
  ok('the evidence and confidence are kept', c0.conf >= 0.95 && c0.evidence.scan.match === 97 && c0.evidence.reasons.length >= 1 && c0.log.some((l) => l.act === 'detected'), c0);
  ok('the audit log shows detection, forfeit and announcement, once each', ['detected', 'forfeit', 'announced'].every((a) => c0.log.filter((l) => l.act === a).length === 1), c0.log.map((l) => l.act));
  const chat = (await call('me', {}, P.cat)).chat;
  const ann1 = chat.filter((m) => m.fp === gid);
  ok('everyone sees one announcement with the name in it', ann1.length === 1 && /ann/.test(ann1[0].text) && /FAIR PLAY VIOLATION/.test(ann1[0].text), ann1);
  await sleep(100);
  ok('bob is paid for the win (the game was settled)', (await call('me', {}, P.bob)).user.w >= 1);

  console.log('the poll');
  let cs = (await call('fair_cases', {}, P.cat)).cases;
  ok('the case is public with the five options', cs.length === 1 && cs[0].options.map((o) => o.label).join('|') === 'Warning only|24-hour ban|7-day ban|30-day ban|Permanent ban', cs[0] && cs[0].options);
  ok('the accused cannot vote on it', (await call('fair_vote', { id: gid, opt: 'warn' }, P.ann)).status === 403);
  ok('a made-up option is refused', (await call('fair_vote', { id: gid, opt: 'exile' }, P.cat)).status === 400);
  await call('fair_vote', { id: gid, opt: 'warn' }, P.cat);
  await call('fair_vote', { id: gid, opt: 'ban7d' }, P.cat);
  await call('fair_vote', { id: gid, opt: 'ban7d' }, P.bob);
  await call('fair_vote', { id: gid, opt: 'ban7d' }, P.eve);
  cs = (await call('fair_cases', {}, P.cat)).cases;
  ok('results show: one vote each, a changed vote counts once', cs[0].poll.counts.ban7d === 3 && cs[0].poll.counts.warn === 0 && cs[0].poll.total === 3 && cs[0].mine === 'ban7d', cs[0].poll);
  const c1 = await handler.fairCase(gid);
  ok('the voting history is kept, including the changed vote', c1.log.filter((l) => l.act === 'vote').length === 4 && c1.log.some((l) => /warn -> ban7d/.test(l.detail || '')));
  await call('fair_comment', { id: gid, text: 'ann plays 97 percent engine moves, easy call' }, P.fay);
  ok('players can discuss it', (await call('fair_cases', {}, P.cat)).cases[0].comments.length === 1);

  console.log('the decision and the appeal');
  const raw = await store.get('fcase:' + gid); raw.pollEnds = Date.now() - 1000; await store.set('fcase:' + gid, raw);
  cs = (await call('fair_cases', {}, P.cat)).cases;
  ok('when the poll ends the result applies; 3 voters cap the ban at 24 hours', cs[0].status === 'decided' && cs[0].result.key === 'ban24h' && cs[0].result.total === 3, cs[0].result);
  ok('ann cannot play any more', (await call('create', { color: 'w', tc: { base: 300, inc: 0 } }, P.ann)).status === 403);
  ok('but can still see the case and appeal', (await call('fair_cases', {}, P.ann)).ok && (await call('me', {}, P.ann)).user.banUntil > Date.now());
  ok('only the accused can appeal', (await call('fair_appeal', { id: gid, text: 'it was not me, honest' }, P.cat)).status === 403);
  ok('an appeal needs a reason', (await call('fair_appeal', { id: gid, text: 'no' }, P.ann)).status === 400);
  const ap = await call('fair_appeal', { id: gid, text: 'I analyse my own games after playing them, not during.' }, P.ann);
  ok('the appeal opens a second vote', ap.ok && ap.case.status === 'appeal' && ap.case.appeal.poll.total === 0, ap.case && ap.case.status);
  ok('an appeal cannot be filed twice', (await call('fair_appeal', { id: gid, text: 'one more time please ok' }, P.ann)).status === 400);
  await call('fair_comment', { id: gid, text: 'show us your move times then' }, P.ann);
  ok('the accused can discuss it too', (await call('fair_cases', {}, P.ann)).cases[0].comments.some((x) => x.accused));
  for (const n of ['cat', 'bob', 'eve']) await call('fair_vote', { id: gid, opt: 'overturn' }, P[n]);
  await call('fair_vote', { id: gid, opt: 'uphold' }, P.fay);
  const raw2 = await store.get('fcase:' + gid); raw2.appeal.ends = Date.now() - 1000; await store.set('fcase:' + gid, raw2);
  cs = (await call('fair_cases', {}, P.cat)).cases;
  ok('the community overturns it: the ban is lifted', cs[0].status === 'closed' && cs[0].appeal.result.overturned && !(await call('create', { color: 'w', tc: { base: 300, inc: 0 } }, P.ann)).error?.includes('banned'), cs[0].appeal);
  const c2 = await handler.fairCase(gid);
  ok('everything stays on record: evidence, votes, comments, appeal, log', c2.evidence.scan && Object.keys(c2.votes).length === 3 && c2.comments.length === 2 && c2.appeal.text && c2.log.some((l) => l.act === 'ban lifted') && c2.log.some((l) => l.act === 'appeal'), c2.log.map((l) => l.act));

  console.log('admins');
  ok('players cannot read the full record', (await call('admin_fair_case', { id: gid }, P.cat)).status === 403 && (await call('admin_fair_decide', { id: gid, act: 'perm' }, P.cat)).status === 403);
  ok('an admin can read it and set the punishment themselves', (await call('admin_fair_case', { id: gid }, P.dan)).case.log.length > 5 && (await call('admin_fair_decide', { id: gid, act: 'ban7d' }, P.dan)).ok && (await call('me', {}, P.ann)).user.banUntil > Date.now() + 6 * 86400e3);
  ok('…or dismiss the case and lift the ban', (await call('admin_fair_decide', { id: gid, act: 'dismiss' }, P.dan)).ok && (await call('me', {}, P.ann)).user.banUntil === 0);
  ok('admins can set the phrases, never threats', (await call('admin_fair_phrases', { phrases: ['{name} should die'] }, P.dan)).status === 400 && (await call('admin_fair_phrases', { phrases: ['{name} lost to their own laptop. Shameful.'] }, P.dan)).ok);

  console.log('spectators see a live game a few moves late');
  const g3 = await start('eve', 'fay');
  for (let i = 0; i < 10; i++) await mv(g3, LONG[i], i % 2 ? 'fay' : 'eve');
  const pl = await call('room', { code: g3 }, P.eve), sp = await call('room', { code: g3 }, P.cat);
  ok('the players see the real position', pl.hist.length === 10 && !pl.delayed);
  ok('a spectator is 4 plies behind (position, moves and last move)', sp.hist.length === 6 && sp.moves.length === 6 && sp.delayed === 4 && JSON.stringify(sp.state.board) !== JSON.stringify(pl.state.board), [sp.hist.length, sp.delayed]);
  await call('resign', { code: g3 }, P.eve);
  const done = await call('room', { code: g3 }, P.cat);
  ok('once the game is over everyone sees all of it', done.hist.length === 10 && !done.delayed);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
