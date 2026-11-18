// Reversing / undoing a tournament result. Run: node scripts/test-tour-reverse.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY; process.env.ADMIN_KEY = 'k';
const handler = require('../lib/app'), Tour = require('../public/tournament.js');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const call = (route, body, who) => new Promise((resolve) => handler({ method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body }, { setHeader() {}, writeHead(c) { this.code = c; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } }));
const tc = { base: 300, inc: 0 };
const mk = (kind, n) => { const t = Tour.create({ id: 'x', name: 'T', by: 'o', tc, cfg: { kind, size: 4 }, now: 1 }); for (let i = 0; i < n; i++) Tour.join(t, { name: 'p' + i, elo: 1500 - i }); return Tour.start(t, 2); };
const thrown = (f) => { try { f(); return ''; } catch (e) { return e.message; } };
(async () => {
  console.log('engine');
  let t = mk('rr', 3); const f = t.groups[0].fixtures[0];
  Tour.record(t, f.id, 'a', null, 'awarded', 5);
  Tour.reopen(t, f.id);
  ok('a group result can be taken back', !f.res && !f.by && Tour.ready(f), f);
  ok('a match without a result cannot be reopened', /no result/.test(thrown(() => Tour.reopen(t, f.id))), null);
  for (const x of t.groups[0].fixtures) Tour.record(t, x.id, 'a', null, 'awarded', 6);
  ok('a finished round robin has a champion', t.phase === 'done' && !!t.champion, t.phase);
  Tour.reopen(t, t.groups[0].fixtures[1].id);
  ok('reversing a result reopens a finished tournament', t.phase === 'groups' && t.champion === null && t.ended === null, t);

  t = mk('ko', 4);                                       // semi-finals k1-1, k1-2, final k2-1
  Tour.record(t, 'k1-1', 'a', null, 'awarded', 5); Tour.record(t, 'k1-2', 'b', null, 'awarded', 5);
  const finalists = [t.ko.rounds[1][0].a, t.ko.rounds[1][0].b];
  ok('winners reach the final', finalists.every(Boolean), finalists);
  Tour.reopen(t, 'k1-1');
  ok('undoing a semi-final removes its winner from the final', t.ko.rounds[1][0].a === null && t.ko.rounds[1][0].b === finalists[1] && !t.ko.rounds[0][0].res, t.ko.rounds[1][0]);
  Tour.record(t, 'k1-1', 'b', null, 'awarded', 6);
  ok('and the other player takes the place', t.ko.rounds[1][0].a === t.ko.rounds[0][0].b, t.ko.rounds[1][0]);
  Tour.record(t, 'k2-1', 'a', null, 'awarded', 7);
  ok('the final crowns a champion', t.phase === 'done' && t.champion, t.phase);
  ok('a semi-final cannot be reversed once the final is decided', /next round/.test(thrown(() => Tour.reopen(t, 'k1-1'))), null);
  Tour.reopen(t, 'k2-1');
  ok('reversing the final removes the champion', t.phase === 'ko' && t.champion === null && t.ended === null, t.phase);

  t = mk('gko', 4);                                       // one group of 4... or two groups; finish the groups
  for (const g of t.groups) for (const x of g.fixtures) Tour.record(t, x.id, 'a', null, 'awarded', 5);
  ok('groups done: the knockout is drawn', !!t.ko && t.phase === 'ko', t.phase);
  const gx = t.groups[0].fixtures[0];
  Tour.reopen(t, gx.id);
  ok('reversing a group result before the knockout starts redraws it', t.ko === null && t.phase === 'groups', t.phase);
  for (const g of t.groups) for (const x of g.fixtures) if (!x.res) Tour.record(t, x.id, 'b', null, 'awarded', 6);
  const k = t.ko.rounds[0][0]; Tour.record(t, k.id, 'a', null, 'awarded', 7);
  ok('once a knockout match is played, group results are locked', /knockout has started/.test(thrown(() => Tour.reopen(t, gx.id))), null);

  console.log('api');
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const O = await su('owner'), P = []; for (const n of ['aa', 'bb', 'cc', 'dd']) P.push(await su(n));
  await call('admin_claim', { key: 'k' }, O);
  const c = await call('tour_create', { name: 'Rev cup', tc, cfg: { kind: 'ko' }, join: false }, O); const id = c.tour.id;
  for (const p of P) await call('tour_join', { id }, p);
  await call('tour_start', { id }, O);
  const aw = await call('tour_award', { id, fx: 'k1-1', res: 'a' }, O);
  const before = aw.tour.ko.rounds[0][0];
  ok('a player cannot reverse results', (await call('tour_reverse', { id, fx: 'k1-1' }, P[0])).status === 403, null);
  const rv = await call('tour_reverse', { id, fx: 'k1-1', mode: 'flip' }, O);
  ok('the organizer flips it: the other player wins', rv.tour && rv.tour.ko.rounds[0][0].res === 'b' && rv.tour.ko.rounds[1][0].a === before.b, rv.error);
  const un = await call('tour_reverse', { id, fx: 'k1-1', mode: 'undo' }, O);
  ok('or undoes it', un.tour && !un.tour.ko.rounds[0][0].res && !un.tour.ko.rounds[1][0].a, un.error);
  ok('there is nothing to reverse on an undecided match', (await call('tour_reverse', { id, fx: 'k1-1', mode: 'undo' }, O)).status === 400, null);
  const g = await call('tour_get', { id }, O);
  ok('the tournament chat says what happened', g.chat.some((m) => /reversed by the organizer/.test(m.t)), g.chat.map((m) => m.t));
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
