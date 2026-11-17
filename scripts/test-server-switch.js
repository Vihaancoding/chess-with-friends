// Players switch servers only where an admin allows it. Run: node scripts/test-server-switch.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY; process.env.ADMIN_KEY = 'k'; process.env.CLOSED_SERVER1 = '1';
const handler = require('../lib/app');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const call = (route, body, who) => new Promise((resolve) => handler({ method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body }, { setHeader() {}, writeHead(c) { this.code = c; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } }));
(async () => {
  const o = await call('signup', { email: 'o@x.io', password: 'password1', username: 'owner' }); const O = { name: o.name, token: o.token };
  await call('admin_claim', { key: 'k' }, O);
  const a = await call('admin_server_new', { name: 'Room 2' }, O), b = await call('admin_server_new', { name: 'Room 3' }, O);
  const code = (await call('admin_servers', {}, O)).servers.find((s) => s.id === a.id).code;
  const zr = await call('signup', { email: 'z@x.io', password: 'password1', username: 'zed', server: code }); const Z = { name: zr.name, token: zr.token }; if (!zr.token) console.log('signup', JSON.stringify(zr));
  ok('a player on one server has no switch and cannot switch', (await call('me', {}, Z)).user.srvOpts.length === 0 && (await call('server_switch', { to: '1' }, Z)).status === 403, null);
  ok('only admins grant access', (await call('admin_server_access', { name: 'zed', servers: ['1'] }, Z)).status >= 400, null);
  const g = await call('admin_server_access', { name: 'zed', servers: ['1', b.id, '99', a.id] }, O);
  ok('the admin opens servers (unknown ids and their own are dropped)', g.ok && g.servers.sort().join() === ['1', b.id].sort().join(), g);
  const me = (await call('me', {}, Z)).user;
  ok('the player now sees a switch with exactly those servers', me.srvOpts.map((x) => x.id).sort().join() === ['1', a.id, b.id].sort().join(), me.srvOpts);
  ok('switching to an allowed server works', (await call('server_switch', { to: b.id }, Z)).ok && (await call('me', {}, Z)).user.srv === b.id, null);
  await call('admin_server_access', { name: 'zed', servers: [] }, O);
  const back = await call('server_switch', { to: a.id }, Z);
  ok('closing access: they stay where they are and can no longer go elsewhere', (await call('me', {}, Z)).user.srv === b.id && (await call('server_switch', { to: '1' }, Z)).status === 403 && back.status === 403, back);
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
