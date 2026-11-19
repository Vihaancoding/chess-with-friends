// Game chat: normal games keep their spectator chat; games played from a private room are closed to everyone outside the room.
// Run: node scripts/test-gamechat-private.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY; process.env.ADMIN_KEY = 'k'; delete process.env.GAME_CHAT_PLAYERS_ONLY;
const handler = require('../lib/app');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const call = (route, body, who) => new Promise((resolve) => handler({ method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body }, { setHeader() {}, writeHead(c) { this.code = c; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } }));
const tc = { base: 300, inc: 0 };
(async () => {
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = {}; for (const n of ['ann', 'bob', 'cat', 'eve']) P[n] = await su(n);

  console.log('a normal game');
  const g = await call('create', { color: 'w', tc }, P.ann); await call('join', { code: g.code }, P.bob);
  ok('the players chat', (await call('game_chat_send', { code: g.code, text: 'hello' }, P.ann)).ok, null);
  ok('spectators can still read and write, as before', Array.isArray((await call('game_chat', { code: g.code }, P.eve)).msgs) && (await call('game_chat_send', { code: g.code, text: 'gg' }, P.eve)).ok, null);

  console.log('a game from a private room');
  const l = await call('lounge_create', { name: 'Club' }, P.ann); await call('lounge_invite', { id: l.id, name: 'bob' }, P.ann); await call('lounge_reply', { id: l.id, accept: true }, P.bob);
  await call('lounge_invite', { id: l.id, name: 'cat' }, P.ann); await call('lounge_reply', { id: l.id, accept: true }, P.cat);
  const t = await call('lounge_table', { id: l.id, tc }, P.ann); await call('lounge_sit', { id: l.id, code: t.code }, P.bob);
  await new Promise((r) => setTimeout(r, 800));   // the chat rate limit
  ok('the two players chat', (await call('game_chat_send', { code: t.code, text: 'room secret' }, P.ann)).ok, null);
  ok('another member of the room can watch and read it', (await call('game_chat', { code: t.code }, P.cat)).msgs.length === 1, null);
  ok('a stranger cannot read, write, join or open the game', (await call('game_chat', { code: t.code }, P.eve)).status === 404 && (await call('game_chat_send', { code: t.code, text: 'hi' }, P.eve)).status === 404 && (await call('join', { code: t.code }, P.eve)).status === 404 && (await call('room', { code: t.code }, P.eve)).status === 404, null);

  console.log('deleting your own messages');
  const wait = () => new Promise((r) => setTimeout(r, 800));
  // lobby
  await call('admin_claim', { key: 'k' }, P.eve);
  const lm = (await call('chat_send', { text: 'oops wrong chat' }, P.ann)).msg; await wait();
  ok('lobby: someone else cannot delete it', (await call('chat_delete', { id: lm.id }, P.bob)).status === 403, null);
  ok('lobby: the author deletes it', (await call('chat_delete', { id: lm.id }, P.ann)).ok && !(await call('me', {}, P.bob)).chat.some((m) => m.id === lm.id), null);
  ok('lobby: deleting it twice is fine', (await call('chat_delete', { id: lm.id }, P.ann)).ok, null);
  // game chat
  const gm = (await call('game_chat_send', { code: g.code, text: 'gg ez' }, P.bob)).msg;
  ok('game: not yours, not allowed', (await call('game_chat_delete', { code: g.code, id: gm.id }, P.ann)).status === 403, null);
  ok('game: yours, gone for everyone', (await call('game_chat_delete', { code: g.code, id: gm.id }, P.bob)).ok && !(await call('game_chat', { code: g.code }, P.ann)).msgs.some((m) => m.id === gm.id), null);
  // room chat
  const rm = (await call('lounge_chat', { id: l.id, text: 'private oops' }, P.ann)).msg;
  ok('room: a member cannot delete another member\'s message', (await call('lounge_chat_delete', { id: l.id, mid: rm.id }, P.bob)).status === 403, null);
  ok('room: the author can', (await call('lounge_chat_delete', { id: l.id, mid: rm.id }, P.ann)).ok && !(await call('lounge_msgs', { id: l.id }, P.bob)).chat.some((m) => m.id === rm.id), null);
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
