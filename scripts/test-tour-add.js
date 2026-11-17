// Adding a player after a tournament has started. Run: node scripts/test-tour-add.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY; process.env.ADMIN_KEY = 'k';
const handler = require('../lib/app'), Tour = require('../public/tournament.js');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const call = (route, body, who) => new Promise((resolve) => handler({ method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body }, { setHeader() {}, writeHead(c) { this.code = c; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } }));
const tc = { base: 300, inc: 0 };
(async () => {
  console.log('engine');
  const mk = (kind, n) => { const t = Tour.create({ id: 'x', name: 'T', by: 'o', tc, cfg: { kind, size: 4 }, now: 1 }); for (let i = 0; i < n; i++) Tour.join(t, { name: 'p' + i, elo: 1500 - i }); return Tour.start(t, 2); };
  let t = mk('rr', 4); const before = t.groups[0].fixtures.length;
  Tour.addLate(t, { name: 'new', elo: 1400 }, 3);
  ok('round robin: the newcomer plays everyone once', t.groups[0].fixtures.length === before + 4 && t.groups[0].fixtures.filter((f) => f.a === 'new' || f.b === 'new').length === 4 && new Set(t.groups[0].fixtures.map((f) => f.id)).size === t.groups[0].fixtures.length, t.groups[0].fixtures.length);
  t = mk('gko', 8); Tour.addLate(t, { name: 'new', elo: 1 }, 3);
  ok('groups: goes into one group only', t.groups.filter((g) => g.players.includes('new')).length === 1 && t.players.length === 9, null);
  let threw = ''; try { Tour.addLate(t, { name: 'new', elo: 1 }, 3); } catch (e) { threw = e.message; }
  ok('the same player cannot be added twice', /already/.test(threw), threw);
  t = mk('ko', 4); Tour.addLate(t, { name: 'new', elo: 1 }, 3);
  ok('untouched knockout: the draw is made again with everyone', t.players.length === 5 && (t.groups || t.ko) && Tour.allFixtures(t).some((f) => f.a === 'new' || f.b === 'new'), null);
  t = mk('ko', 4); Tour.find(t, 'k1-1').room = 'abc'; threw = ''; try { Tour.addLate(t, { name: 'new', elo: 1 }, 3); } catch (e) { threw = e.message; }
  ok('a knockout that has begun refuses', /started/.test(threw), threw);

  console.log('api');
  const su = async (n, e) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const O = await su('owner'), P = []; for (const n of ['aa', 'bb', 'cc', 'dd', 'ee']) P.push(await su(n));
  await call('admin_claim', { key: 'k' }, O);
  const c = await call('tour_create', { name: 'Late cup', tc, cfg: { kind: 'rr' }, join: false }, O); const id = c.tour.id;
  for (const p of P.slice(0, 3)) await call('tour_join', { id }, p);
  
  await call('tour_start', { id }, O);
  ok('players cannot add themselves', (await call('tour_add', { id, name: 'dd' }, P[3])).status === 403, null);
  ok('an unknown name is refused', (await call('tour_add', { id, name: 'nobody' }, O)).status === 404, null);
  const r = await call('tour_add', { id, name: 'dd' }, O);
  ok('the organizer adds a player after the start', r.tour && r.tour.players.some((p) => p.name === 'dd') && r.tour.groups[0].fixtures.filter((f) => f.a === 'dd' || f.b === 'dd').length === 3, r.error);
  const g = await call('tour_get', { id }, O);
  ok('the tournament chat says so', g.chat.some((m) => /dd was added/.test(m.t)), g.chat);
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
