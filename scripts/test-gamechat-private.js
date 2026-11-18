// A game's chat is private to its two players; the Damage Report no longer quotes it, and old cards that did are removed.
// Run: node scripts/test-gamechat-private.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY; process.env.ADMIN_KEY = 'k'; delete process.env.GAME_CHAT_SPECTATORS; delete process.env.DAMAGE_QUOTE_CHAT;
const handler = require('../lib/app'), store = require('../lib/store');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const call = (route, body, who) => new Promise((resolve) => handler({ method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body }, { setHeader() {}, writeHead(c) { this.code = c; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } }));
(async () => {
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const O = await su('owner'); await call('admin_claim', { key: 'k' }, O);
  const P = {}; for (const n of ['ann', 'bob', 'cat']) P[n] = await su(n);
  const g = await call('create', { color: 'w', tc: { base: 300, inc: 0 } }, P.ann); await call('join', { code: g.code }, P.bob);
  console.log('game chat');
  ok('the two players can chat and read it', (await call('game_chat_send', { code: g.code, text: 'secret between us' }, P.ann)).ok && (await call('game_chat', { code: g.code }, P.bob)).msgs.length === 1, null);
  ok('a spectator cannot read it', (await call('game_chat', { code: g.code }, P.cat)).status === 403, null);
  ok('a spectator cannot write in it', (await call('game_chat_send', { code: g.code, text: 'hi' }, P.cat)).status === 403, null);
  ok('an admin still can (moderation)', Array.isArray((await call('game_chat', { code: g.code }, O)).msgs), null);
  ok('the game itself can still be watched', (await call('room', { code: g.code }, P.cat)).status !== 403, null);

  console.log('damage report');
  const rows = [['AAAAA-x1', 'he said "get rekt buddy" and then blundered his queen', 'get rekt buddy'], ['BBBBB-x2', 'a plain roast with no chat at all', null], ['CCCCC-x3', 'quoted "something" but the chat is long gone', null]];
  for (const [id, line, chat] of rows) {
    await store.set('dmg:' + id, { id, st: 'd', line, at: Date.now() }, 3600);
    if (chat) await store.set('gchat:' + id.split('-')[0], { v: 1, list: [{ id: 'm1', n: 'x', s: 'w', t: chat, ts: 1, k: 1 }] }, 3600);
  }
  await store.set('dmgfeed', { v: 1, list: rows.map(([id, line], i) => ({ id, line, at: Date.now() - i, st: 'd', w: 'ann', b: 'bob', ws: 0, bs: 1 })) }, 3600);
  const r = await call('damage_feed', {}, P.ann);
  console.log('  (the feed route ran the clean-up:', r.status, ')');
  const left = (await store.get('dmgfeed')).list.map((x) => x.id);
  ok('a card quoting the chat is taken down', !left.includes('AAAAA-x1') && !(await store.get('dmg:AAAAA-x1')), left);
  ok('so is one with a quotation whose chat has expired', !left.includes('CCCCC-x3'), left);
  ok('a card without chat is left alone', left.includes('BBBBB-x2') && !!(await store.get('dmg:BBBBB-x2')), left);
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
