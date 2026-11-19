// A rival who switched servers is shown as "on another server", not as a removed account. Run: node scripts/test-rival-away.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY; process.env.ADMIN_KEY = 'k';
const handler = require('../lib/app');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const call = (route, body, who) => new Promise((resolve) => handler({ method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body }, { setHeader() {}, writeHead(c) { this.code = c; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const O = await su('owner'); await call('admin_claim', { key: 'k' }, O);
  const A = await su('ann'), B = await su('bob');
  await call('admin_server_new', { name: 'Room 2' }, O);
  const g = await call('create', { color: 'w', tc: { base: 300, inc: 0 } }, A); await call('join', { code: g.code }, B);
  await call('move', { code: g.code, from: 52, to: 36 }, A); await call('move', { code: g.code, from: 12, to: 28 }, B);
  await call('resign', { code: g.code }, B);
  let row; for (let i = 0; i < 30 && !row; i++) { row = (await call('rivalries', {}, A)).rivals && (await call('rivalries', {}, A)).rivals.find((x) => x.name === 'bob'); if (!row) await sleep(150); }
  const list = async () => { const r = await call('rivalries', {}, A); return (r.all || r.rivals || r.list || []).find((x) => x.name === 'bob'); };
  const before = await list();
  ok('a rival on the same server is available', before && before.available === true, before);
  await call('admin_move', { name: 'bob', to: '2' }, O);
  const after = await list();
  ok('after they switch server: unavailable, but marked as away (not removed)', after && after.available === false && after.away === true, after);
  const d = await call('rivalry', { name: 'bob' }, A);
  ok('the rivalry page says the same', d.rival && d.rival.away === true, d.error || d.rival);
  await call('admin_delete', { name: 'bob' }, O);
  const gone = await list();
  ok('a really deleted account is still "removed"', gone && gone.available === false && !gone.away, gone);
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
