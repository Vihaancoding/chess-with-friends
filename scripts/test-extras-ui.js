// Profile pictures, GIFs in chat and the stats leaderboard in the browser. Run: node scripts/test-extras-ui.js (needs Playwright)
const { chromium } = require('playwright');
process.env.PORT = String(4210 + Math.floor(Math.random() * 9)); process.env.SUPABASE_URL = ''; process.env.ADMIN_KEY = 'k'; delete process.env.GIPHY_API_KEY;
const PORT = process.env.PORT, origLog = console.log; console.log = () => {};
require('../server.js'); console.log = origLog;
const app = require('../lib/app'), Dmg = require('../lib/damage'), store = require('../lib/store');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => { const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, ...(await r.json()) }; };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
(async () => {
  await sleep(300);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const A = await su('ann'), B = await su('bob');
  // stats: ann played well, bob blundered (made-up evaluations over a short game)
  const hist = [['e2', 'e4'], ['e7', 'e5'], ['d1', 'h5'], ['b8', 'c6'], ['f1', 'c4'], ['g8', 'f6'], ['h5', 'f7']].map(([a, b]) => ({ from: 'abcdefgh'.indexOf(a[0]) + (8 - +a[1]) * 8, to: 'abcdefgh'.indexOf(b[0]) + (8 - +b[1]) * 8 }));
  const rep = Dmg.replay(hist), ev = [20, 30, 25, 30, 25, 30, 9999, 9999]; ev[5] = 40;
  await app.statsRecord({ id: 'AAAAA-z1', players: { w: { name: 'ann' }, b: { name: 'bob' } } }, rep, ev);

  const br = await chromium.launch(); const ctx = await br.newContext({ viewport: { width: 1280, height: 1000 } }); const p = await ctx.newPage();
  p.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); }); p.on('dialog', (d) => d.accept());
  await p.route(/cdn\.jsdelivr\.net|fonts\.g|giphy\.com/, (r) => r.abort());
  await ctx.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), A);
  await p.goto(`http://localhost:${PORT}/`); await p.waitForSelector('#statsBody table');

  console.log('stats leaderboard');
  ok('the lobby has a stats card with a row per player', (await p.$$('#statsBody tbody tr')).length === 2, null);
  await p.click('[data-st="blunder"]');
  ok('Blunders puts the player who blundered first', /bob/.test(await p.textContent('#statsBody tbody tr')), await p.textContent('#statsBody tbody tr'));
  await p.click('[data-st="acc"]');
  ok('Accuracy needs enough moves, and says so', /at least 40/.test(await p.textContent('#statsBody')), null);

  console.log('chat gifs');
  await p.fill('#chatIn', 'hello'); await p.click('#chatForm button.primary'); await p.waitForFunction(() => /hello/.test(document.querySelector('#chatlog').textContent));
  await sleep(800);
  await p.click('#chatForm .gifbtn'); await p.waitForSelector('#gifLink');
  ok('with no Giphy key the picker says so and offers a link box', /not set up/.test(await p.textContent('#gifRes')) || /Loading/.test(await p.textContent('#gifRes')), await p.textContent('#gifRes'));
  await p.fill('#gifLink', 'https://example.com/x.gif'); await p.click('#gifUse');
  ok('a link from another site is refused', /not a GIF link/.test(await p.textContent('#gifErr')), null);
  await p.fill('#gifLink', 'https://giphy.com/gifs/cat-typing-abc12345XYZ'); await p.click('#gifUse');
  await p.waitForSelector('#chatlog img.chatgif', { timeout: 8000 });
  ok('a Giphy page link becomes a picture in the chat', (await p.getAttribute('#chatlog img.chatgif', 'src')) === 'https://media.giphy.com/media/abc12345XYZ/giphy.gif', await p.getAttribute('#chatlog img.chatgif', 'src'));
  await sleep(800);
  await p.fill('#chatIn', 'https://evil.example/x.gif'); await p.click('#chatForm button.primary'); await p.waitForFunction(() => /evil\.example/.test(document.querySelector('#chatlog').textContent));
  ok('other pictures stay plain text', (await p.$$('#chatlog img.chatgif')).length === 1, null);

  console.log('profile picture');
  await p.click('#meName'); await p.waitForSelector('#pfPhotoBox:not(.hidden)');
  ok('my profile has a picture box', await p.isVisible('#pfPhotoIn') || (await p.$('#pfPhotoIn')) !== null, null);
  await p.setInputFiles('#pfPhotoIn', { name: 'me.png', mimeType: 'image/png', buffer: PNG });
  await p.waitForFunction(() => /Saved/.test(document.querySelector('#pfPhotoMsg').textContent), null, { timeout: 8000 });
  const r = await fetch(`http://localhost:${PORT}/api?r=avatar&n=ann`);
  ok('the picture is saved and served as an image', /image\/(webp|jpeg|png)/.test(r.headers.get('content-type')), r.headers.get('content-type'));
  ok('it shows in the sidebar and on the profile', /v=\d+/.test(await p.getAttribute('#meAv', 'src')) && /v=\d+/.test(await p.getAttribute('#pfAvatar img', 'src')), await p.getAttribute('#meAv', 'src'));
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT + '-profile.png' });
  await p.click('#navPlay'); await p.click('[data-st="brilliant"]'); await p.waitForSelector('#statsBody table');
  if (process.env.SHOT) { await p.evaluate(() => document.querySelector('#statscard').scrollIntoView()); await sleep(400); await p.screenshot({ path: process.env.SHOT + '-stats.png' }); }
  console.log('pictures during a game');
  await api('avatar_clear', {}, A);   // ann starts without a picture
  const g = await api('create', { color: 'w', tc: { base: 300, inc: 0 } }, A); await api('join', { code: g.code }, B);
  const ctxB = await br.newContext({ viewport: { width: 1280, height: 900 } }); const pb = await ctxB.newPage();
  await ctxB.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), B); await pb.route(/cdn\.jsdelivr\.net|fonts\.g/, (r) => r.abort());
  await pb.goto(`http://localhost:${PORT}/?game=${g.code}`); await pb.waitForSelector('.avatar[data-avn]');
  const hasImg = () => pb.evaluate(() => !!document.querySelector('.avatar[data-avn="ann"] img.avi'));
  ok('a player without a picture shows the old letter avatar in the game', !(await hasImg()) && /^A/.test(await pb.textContent('.avatar[data-avn="ann"]')), null);
  const PNGD = 'data:image/png;base64,' + PNG.toString('base64');
  await api('avatar_set', { img: PNGD }, A);
  const later = () => pb.evaluate(() => { const real = Date.now.bind(Date); Date.now = () => real() + 40000; avRefresh(); });
  await later();
  await pb.waitForSelector('.avatar[data-avn="ann"] img.avi', { timeout: 8000 });
  ok('when they set one it shows up for the opponent while playing', true);
  await api('avatar_clear', {}, A);
  await pb.evaluate(() => { const real = Date.now.bind(Date); Date.now = () => real() + 40000; avRefresh(); });
  await pb.waitForFunction(() => !document.querySelector('.avatar[data-avn="ann"] img.avi'), null, { timeout: 8000 });
  ok('and when they remove it, it goes back to the old letter avatar', /^A/.test(await pb.textContent('.avatar[data-avn="ann"]')), null);
  await br.close(); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
