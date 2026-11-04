// @mentions in the browser: the @ picker, highlighting, and the pop-up for a player who is busy in a game.
// Run: node scripts/test-mentions-ui.js          (needs Playwright: npm i -g playwright, or NODE_PATH pointing at it)
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 4050 + Math.floor(Math.random() * 9);
const SHOTS = process.env.SHOTS || '';
let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => {
  const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) });
  return { status: r.status, ...(await r.json()) };
};
let srv = null;
process.on('exit', () => { if (srv) srv.kill(); });

(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, SUPABASE_URL: '' }, stdio: 'ignore' });
  await sleep(800);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const ann = await su('ann'), bob = await su('bob'), bea = await su('bea'), cat = await su('cat');
  const br = await chromium.launch();
  const open = async (u, viewport) => {
    const ctx = await br.newContext({ viewport });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); });
    await page.route(/cdn\.jsdelivr\.net/, (r) => r.abort());
    await ctx.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), u);
    return page;
  };
  const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png') });

  // bob is busy playing cat
  const g = await api('create', { color: 'w', tc: { base: 300, inc: 0 } }, bob);
  await api('join', { code: g.code }, cat);
  const B = await open(bob, { width: 1280, height: 860 });
  await B.goto(`http://localhost:${PORT}/?game=${g.code}`);
  await B.waitForFunction(() => snap && snap.players.w && snap.players.b);
  await api('chat_send', { text: 'hi all' }, bea);                    // so the picker knows bea too

  console.log('the @ picker');
  const A = await open(ann, { width: 1280, height: 860 });
  await A.goto(`http://localhost:${PORT}/`);
  await A.waitForSelector('#onlinelist .orow b, #chatlog .mx', { timeout: 15000 });
  await A.waitForFunction(() => knownNames.has('bob') && knownNames.has('bea'), null, { timeout: 15000 });
  await A.click('#chatIn');
  await A.type('#chatIn', 'good luck @b');
  await A.waitForSelector('#chatcard .mentbox:not(.hidden)');
  const opts = await A.$$eval('#chatcard .mentbox [data-n]', (x) => x.map((b) => b.dataset.n));
  ok('typing @b lists the matching players', opts.includes('bob') && opts.includes('bea') && !opts.includes('ann'), opts);
  ok('players online come first', opts[0] === 'bob', opts);
  await shot(A, 'm1-picker');
  await A.keyboard.press('Enter');
  ok('Enter picks the name instead of sending', (await A.inputValue('#chatIn')) === 'good luck @bob ');
  await A.type('#chatIn', 'you got this');
  await A.keyboard.press('Enter');
  await A.waitForFunction(() => /good luck/.test(document.querySelector('#chatlog').textContent));
  ok('the mention is highlighted in the message', /@bob/.test(await A.textContent('#chatlog .ment')));

  console.log('the person mentioned, busy in a game');
  await B.waitForSelector('#chatToast.show', { timeout: 20000 });
  const toast = await B.textContent('#chatToast');
  ok('a pop-up says who mentioned them and where', /ann mentioned you in the lobby chat/.test(toast) && /good luck @bob/.test(toast), toast);
  await shot(B, 'm2-toast-in-game');
  await B.click('#chatToast');
  await B.waitForSelector('#lobby:not(.hidden)');
  await B.waitForFunction(() => document.activeElement && document.activeElement.id === 'chatIn', null, { timeout: 5000 }).catch(() => {});
  ok('tapping it opens the lobby chat', await B.evaluate(() => document.activeElement && document.activeElement.id === 'chatIn'));
  await B.waitForSelector('#chatlog .ment.me');
  ok('their own name stands out in the message', /@bob/.test(await B.textContent('#chatlog .ment.me')));

  console.log('mentioned while looking at that chat');
  await api('chat_send', { text: '@bob are you here?' }, cat);
  await B.waitForFunction(() => /are you here/.test(document.querySelector('#chatlog').textContent), null, { timeout: 15000 });
  await sleep(13000);                                                   // the fallback check runs every 12 s
  ok('no pop-up when you are already reading that chat', !(await B.evaluate(() => /cat mentioned you/.test(document.querySelector('#chatToast').textContent) && document.querySelector('#chatToast').classList.contains('show'))));

  await br.close(); srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
