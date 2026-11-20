// Anyone can host a tournament, no admin needed. Run: node scripts/test-tour-host.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY; process.env.ADMIN_KEY = 'k';
const handler = require('../lib/app');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const call = (route, body, who) => new Promise((resolve) => handler({ method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body }, { setHeader() {}, writeHead(c) { this.code = c; }, end(b) { let j = {}; try { j = JSON.parse(b || '{}'); } catch {} resolve({ status: this.code, ...j }); } }));
const tc = { base: 300, inc: 0 };
(async () => {
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const A = await su('ann'), B = await su('bob');
  const mk = (who, name) => call('tour_create', { name, tc, cfg: { kind: 'rr', size: 4 } }, who);
  const t1 = await mk(A, 'Ann Open');
  const id1 = t1.tour && t1.tour.id;
  ok('a player who is not an admin can create a tournament', t1.status === 200 && id1, t1);
  const g = await call('tour_get', { id: id1 }, A);
  ok('they are its host and are signed up', g.tour.by === 'ann' && g.tour.players.some((p) => p.name === 'ann'), g.tour && g.tour.by);
  const j = await call('tour_join', { id: id1 }, B);
  ok('others can join it', j.status === 200, j);
  ok('the host can run it (add players, start it, delete it), others cannot', (await call('tour_delete', { id: id1 }, B)).status === 403, null);
  const t2 = await mk(A, 'Ann Two'), t3 = await mk(A, 'Ann Three');
  ok('a host can run 2 at once, not 3', t2.status === 200 && t3.status === 400 && /2 tournaments/.test(t3.error), t3);
  ok('another player is not held back by that', (await mk(B, 'Bob Open')).status === 200, null);
  ok('a tournament needs a name', (await mk(B, 'x')).status === 400, null);
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
