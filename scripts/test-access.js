// Request access / request a server: an admin decides which server people go to. Run: node scripts/test-access.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
process.env.ADMIN_KEY = 'test-admin-key'; process.env.CLOSED_SERVER1 = '1'; delete process.env.RESEND_API_KEY; delete process.env.SMTP_USER;
const handler = require('../lib/app');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
function call(route, body, who) {
  return new Promise((resolve) => {
    const req = { method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body };
    handler(req, { setHeader() {}, writeHead(code) { this.code = code; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } });
  });
}
(async () => {
  const first = await call('signup', { email: 'owner@x.io', password: 'password1', username: 'owner' });
  const O = { name: first.name, token: first.token };
  await call('admin_claim', { key: 'test-admin-key' }, O);
  const mk = await call('admin_server_new', { name: 'Room 12' }, O);   // server 2
  const sv = (await call('admin_servers', {}, O)).servers;
  ok('there are two servers and server 1 is closed to people without a code', sv.length === 2 && (await call('signup', { email: 'x@x.io', password: 'password1', username: 'nocode' })).status === 400, sv.length);
  ok('the refusal points to requesting access', /request access/i.test((await call('signup', { email: 'x@x.io', password: 'password1', username: 'nocode' })).error), null);

  console.log('request access');
  ok('bad email, missing name and bots are handled', (await call('access_request', { email: 'nope', name: 'Zed' })).status === 400 && (await call('access_request', { email: 'z@x.io', name: '' })).status === 400 && (await call('access_request', { email: 'bot@x.io', name: 'bot', website: 'http://spam' })).ok, null);
  const rq = await call('access_request', { kind: 'join', email: 'Zed@X.io', name: 'Zed', note: 'friend of owner' });
  ok('a request is accepted', rq.ok, rq);
  ok('asking again straight away is slowed down', (await call('access_request', { kind: 'join', email: 'zed@x.io', name: 'Zed' })).status === 429, null);
  ok('only admins see requests', (await call('admin_access_list', {})).status >= 400 || (await call('admin_access_list', {}, { name: 'nobody', token: 'x' })).status >= 400, null);
  const list = await call('admin_access_list', {}, O);
  const item = list.items.find((x) => x.email === 'zed@x.io');
  ok('the admin sees it (the bot was dropped)', item && item.name === 'Zed' && item.kind === 'join' && !list.items.some((x) => x.email === 'bot@x.io'), list.items);
  ok('without approval they still cannot sign up without a code', (await call('signup', { email: 'zed@x.io', password: 'password1', username: 'zed' })).status === 400, null);
  const ap = await call('admin_access_decide', { id: item.id, act: 'approve', server: '2' }, O);
  ok('the admin approves them into server 2', ap.ok && ap.server.id === '2', ap);
  ok('deciding twice changes nothing', (await call('admin_access_decide', { id: item.id, act: 'deny' }, O)).already === 'approved', null);
  const z = await call('signup', { email: 'zed@x.io', password: 'password1', username: 'zed' });
  ok('they can now sign up with no code, and land on server 2', z.name === 'zed' && (await call('me', {}, { name: z.name, token: z.token })).user.srv === '2', z);
  ok('the approval is used up', (await call('signup', { email: 'zed@x.io', password: 'password1', username: 'zed2' })).status >= 400, null);

  console.log('deny');
  await call('access_request', { kind: 'join', email: 'dan@x.io', name: 'Dan' });
  const dan = (await call('admin_access_list', {}, O)).items.find((x) => x.email === 'dan@x.io');
  ok('a denied request stays denied', (await call('admin_access_decide', { id: dan.id, act: 'deny' }, O)).ok && (await call('signup', { email: 'dan@x.io', password: 'password1', username: 'dan' })).status === 400, null);

  console.log('request a server');
  ok('a server request needs a name', (await call('access_request', { kind: 'server', email: 'eve@x.io', name: 'Eve' })).status === 400, null);
  await call('access_request', { kind: 'server', email: 'eve@x.io', name: 'Eve', serverName: 'Chess Club 9', note: 'my class' });
  const eve = (await call('admin_access_list', {}, O)).items.find((x) => x.email === 'eve@x.io');
  ok('it shows as a server request', eve && eve.kind === 'server' && eve.serverName === 'Chess Club 9', eve);
  const ae = await call('admin_access_decide', { id: eve.id, act: 'approve', serverName: 'Chess Club 9' }, O);
  ok('approving creates the server and gives an invite link', ae.ok && ae.server.code && /\?join=/.test(ae.link) && (await call('admin_servers', {}, O)).servers.some((s) => s.name === 'Chess Club 9'), ae);
  const e = await call('signup', { email: 'eve@x.io', password: 'password1', username: 'eve' });
  ok('the requester signs up into their new server', (await call('me', {}, { name: e.name, token: e.token })).user.srv === ae.server.id, null);
  ok('an email that already has an account cannot ask again', (await call('access_request', { kind: 'join', email: 'eve@x.io', name: 'Eve' })).status === 409, null);
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
