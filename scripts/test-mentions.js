// @mentions: in the lobby, game and tournament chats, the mentioned player gets a notification (kept until seen).
// Drives the real API in-process with in-memory storage. Run: node scripts/test-mentions.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
process.env.ADMIN_KEY = 'test-admin-key';
const handler = require('../lib/app');

let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };
function call(route, body, who) {
  return new Promise((resolve) => {
    const req = { method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body };
    const res = { setHeader() {}, writeHead(code) { this.code = code; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } };
    handler(req, res);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let tick = 0;
const say = async (route, body, who) => { await wait(720); tick++; return call(route, body, who); };   // chats are throttled to one message per 0.7 s

(async () => {
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const ann = await su('ann'), bob = await su('bob'), cat = await su('cat');
  const mine = async (who) => (await call('mentions', {}, who)).mentions;

  console.log('lobby chat');
  let r = await say('chat_send', { text: 'hey @bob and @Cat, game? also @nobody and @ann' }, ann);
  ok('message sent', r.ok);
  await wait(50);
  let mb = await mine(bob), mc = await mine(cat);
  ok('bob is notified', mb.length === 1 && mb[0].from === 'ann' && mb[0].kind === 'lobby' && /game\?/.test(mb[0].text), mb);
  ok('names are case-insensitive', mc.length === 1, mc);
  ok('you are not notified for mentioning yourself', (await mine(ann)).length === 0);
  r = await call('mention_seen', { ids: [mb[0].id] }, bob);
  ok('seen mentions are not shown again', r.ok && (await mine(bob)).length === 0);
  ok("…and only your own can be marked", (await mine(cat)).length === 1);
  await say('chat_send', { text: 'email me at bob@x.io' }, ann);
  ok('an email address is not a mention', (await mine(bob)).length === 0);

  console.log('game chat');
  const g = await call('create', { color: 'w', tc: { base: 300, inc: 0 } }, ann);
  await call('join', { code: g.code }, bob);
  await say('game_chat_send', { code: g.code, text: '@cat come and watch' }, bob);
  await wait(50);
  mc = await mine(cat);
  ok('a game chat mention says which game', mc.some((m) => m.kind === 'game' && m.code === g.code && m.from === 'bob'), mc);

  console.log('tournament chat');
  await call('admin_claim', { key: 'test-admin-key' }, ann);
  const t = await call('tour_create', { name: 'Ping Cup', tc: null, cfg: { kind: 'ko' } }, ann);
  await say('tour_chat_send', { id: t.tour.id, text: 'sign up @bob!' }, ann);
  await wait(50);
  mb = await mine(bob);
  ok('a tournament chat mention says which tournament', mb.some((m) => m.kind === 'tour' && m.tid === t.tour.id && m.title === 'Ping Cup'), mb);

  console.log('limits');
  await say('chat_send', { text: '@bob @bob @BOB' }, cat);
  await wait(50);
  ok('several mentions of the same person notify once', (await mine(bob)).filter((m) => m.from === 'cat').length === 1);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
