// Servers: sign-up codes, Server 1 closed to new players, nothing crossing between servers, admins moving
// players and switching servers. Drives the real API in-process with in-memory storage. Run: node scripts/test-servers.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
process.env.CLOSED_SERVER1 = '1';                                   // behave like production: Server 1 closes after its first player
process.env.ADMIN_KEY = 'test-admin-key';
const handler = require('../lib/app');

let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };

function call(route, body, who) {
  return new Promise((resolve) => {
    const req = { method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body };
    const res = { writeHead(code) { this.code = code; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } };
    handler(req, res);
  });
}
const su = (n, server) => call('signup', { email: n + '@x.io', password: 'password1', username: n, server });
const tc = { base: 300, inc: 0 };
const names = (me) => (me.leaderboards ? Object.values(me.leaderboards).flat() : []).map((x) => x.name);

(async () => {
  console.log('signing up');
  let r = await su('ann');
  ok('the first player on a new site gets into Server 1 without a code', r.status === 200 && r.srv === '1' && r.ns === '', r);
  const ann = { name: r.name, token: r.token };
  r = await su('bob');
  ok('after that, Server 1 is closed to new players', r.status === 400 && /server code/.test(r.error), r);
  r = await su('bob', 'NOPE12');
  ok('a wrong code is refused', r.status === 400 && /doesn't work/.test(r.error), r);

  console.log('admin: servers');
  ok('players cannot manage servers', (await call('admin_servers', {}, ann)).status === 403);
  await call('admin_claim', { key: 'test-admin-key' }, ann);
  r = await call('admin_servers', {}, ann);
  ok('Server 1 is listed, with no code', r.servers.length === 1 && r.servers[0].id === '1' && !r.servers[0].code && r.current === '1', r);
  ok('Server 1 cannot get a code', (await call('admin_server_edit', { id: '1', code: 'new' }, ann)).status === 400);
  r = await call('admin_server_new', { name: 'Friends' }, ann);
  ok('an admin creates a server', r.ok && r.id === '2', r);
  r = await call('admin_servers', {}, ann);
  const code = r.servers[1].code;
  ok('…which gets a code', /^[A-Z0-9]{6}$/.test(code), r.servers);

  r = await su('bob', code.toLowerCase());
  ok('signing up with the code puts you on that server (any case)', r.status === 200 && r.srv === '2' && r.ns === 'srv2:', r);
  const bob = { name: r.name, token: r.token };
  r = await su('cat', code);
  const cat = { name: r.name, token: r.token };

  console.log('separation');
  let me = await call('me', {}, bob);
  ok('the leaderboard only has players from your server', !names(me).includes('ann'), names(me));
  ok('the server name is shown once there are two servers', me.user.srvName === 'Friends', me.user);
  ok("can't challenge someone on another server", (await call('challenge', { to: 'ann', tc }, bob)).status === 404);
  ok("can't open the profile of someone on another server", (await call('profile', { name: 'ann' }, bob)).status === 404);
  ok("can't play against the clone of someone on another server", (await call('style_games', { name: 'ann' }, bob)).status === 404);
  ok('can challenge someone on your own server', (await call('challenge', { to: 'cat', tc }, bob)).ok);
  await call('cancel', {}, bob);
  await call('chat_send', { text: 'hi from server 2' }, bob);
  me = await call('me', {}, ann);
  ok("lobby chat doesn't cross servers", !me.chat.some((m) => m.text === 'hi from server 2'), me.chat);
  const g1 = await call('create', { tc }, ann);
  ok("a game's code doesn't work from another server", (await call('join', { code: g1.code }, bob)).status === 404);
  const g2 = await call('create', { tc }, bob);
  await call('join', { code: g2.code }, cat);
  me = await call('me', {}, ann);
  ok("live games don't cross servers", !me.live.some((g) => g.code === g2.code), me.live);
  me = await call('me', {}, cat);
  ok('…but show on your own', me.live.some((g) => g.code === g2.code), me.live);
  ok('Server 1 players still sign in as before', (await call('login', { email: 'ann@x.io', password: 'password1' })).srv === '1');

  console.log('admin: players and switching');
  r = await call('admin_overview', {}, ann);
  ok("the admin panel lists the server you're on", r.users.map((u) => u.name).join() === 'ann', r.users);
  r = await call('admin_move', { to: '2' }, ann);
  ok('an admin switches server', r.ok && (await call('admin_servers', {}, ann)).current === '2');
  r = await call('admin_overview', {}, ann);
  ok('…and now sees that server', ['ann', 'bob', 'cat'].every((n) => r.users.some((u) => u.name === n)), r.users);
  me = await call('me', {}, bob);
  ok('…and can play its players', (await call('challenge', { to: 'bob', tc }, ann)).ok);
  await call('cancel', {}, ann);
  r = await call('admin_move', { name: 'cat', to: '1' }, ann);
  me = await call('me', {}, cat);
  ok('an admin moves a player to another server', r.ok && me.user.srv === '1' && !names(me).includes('bob'), me.user);
  r = await call('admin_servers', {}, ann);
  ok('player counts follow', r.servers.find((x) => x.id === '1').players === 1 && r.servers.find((x) => x.id === '2').players === 2, r.servers);
  ok('moving to a server that does not exist fails', (await call('admin_move', { name: 'bob', to: '9' }, ann)).status === 404);
  ok('players cannot move people', (await call('admin_move', { name: 'cat', to: '2' }, bob)).status === 403);

  console.log('codes');
  await call('admin_server_edit', { id: '2', code: 'new' }, ann);
  const code2 = (await call('admin_servers', {}, ann)).servers[1].code;
  ok('a new code replaces the old one', code2 !== code && (await su('dan', code)).status === 400 && (await su('dan', code2)).srv === '2');
  await call('admin_server_edit', { id: '2', code: 'off', name: 'Club' }, ann);
  r = await call('admin_servers', {}, ann);
  ok('turning the code off closes the server; renaming works', !r.servers[1].code && r.servers[1].name === 'Club' && (await su('eve', code2)).status === 400, r.servers);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
