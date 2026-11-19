// L-shaped knight arrows and the "What's new" splash screen. Run: node scripts/test-splash-arrows-ui.js (needs Playwright)
const { chromium } = require('playwright');
process.env.PORT = String(4220 + Math.floor(Math.random() * 9)); process.env.SUPABASE_URL = ''; process.env.ADMIN_KEY = 'k';
const PORT = process.env.PORT, origLog = console.log; console.log = () => {};
require('../server.js'); console.log = origLog;
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body) => { const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, ...(await r.json()) }; };
(async () => {
  await sleep(300);
  const a = await api('signup', { email: 'a@x.io', password: 'password1', username: 'ann' }); const U = { name: a.name, token: a.token };
  const br = await chromium.launch(); const ctx = await br.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage();
  p.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); });
  await p.route(/cdn\.jsdelivr\.net|fonts\.g/, (r) => r.abort());
  await ctx.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), U);

  console.log('arrows');
  await p.goto(`http://localhost:${PORT}/`); await p.waitForSelector('#navPlay');
  const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
  const r = await p.evaluate(([n, s1, st, e4]) => ({ knight: arrowSVG(n[0], n[1], '#e8a33d', 1), knight2: arrowSVG(n[2], n[3], '#e8a33d', 1), straight: arrowSVG(s1[0], s1[1], '#e8a33d', 1), diag: arrowSVG(st[0], st[1], '#e8a33d', 1) }),
    [[sq('g1'), sq('f3'), sq('b1'), sq('c3')], [sq('e2'), sq('e4')], [sq('c1'), sq('f4')], null]);
  const pts = (svg) => (/points="([^"]+)" fill="none"/.exec(svg) || [])[1].split(' ').length;
  ok('a knight jump g1 to f3 is drawn as an L (start, bend, end)', pts(r.knight) === 3, r.knight);
  ok('so is b1 to c3, the other way round', pts(r.knight2) === 3, r.knight2);
  ok('a straight move stays a straight line', pts(r.straight) === 2, r.straight);
  ok('and so does a diagonal', pts(r.diag) === 2, r.diag);
  // the bend of g1->f3 is at g3 (two squares up the g file, then one across), in board units
  const g1 = await p.evaluate(([a1, b1]) => [sqXY(a1), sqXY(b1)], [sq('g1'), sq('f3')]);
  const m = /points="([^"]+)" fill="none"/.exec(r.knight)[1].split(' ').map((x) => x.split(',').map(Number));
  ok('the bend is on the long side first', Math.abs(m[1][0] - g1[0][0]) < 0.01 && Math.abs(m[1][1] - g1[1][1]) < 0.01, [m, g1]);

  console.log('splash');
  await p.goto(`http://localhost:${PORT}/?whatsnew`); await p.waitForSelector('#splash', { timeout: 6000 });
  const t = await p.textContent('#splash');
  ok('the splash describes GIFs, profile pictures and knight arrows', /GIFs in chat/.test(t) && /Profile pictures/.test(t) && /L-shaped knight arrows/.test(t), t);
  ok('it has pictures for each item', (await p.$$('#splash .item svg')).length === 3, null);
  if (process.env.SHOT) { await sleep(400); await p.screenshot({ path: process.env.SHOT + '-splash.png' }); }
  await p.click('#splashOk'); ok('Got it closes it', !(await p.$('#splash')), null);
  await p.goto(`http://localhost:${PORT}/?whatsnew`); await sleep(1800);
  ok('and it does not come back after a reload', !(await p.$('#splash')), null);
  await p.click('#whatsNew'); ok('the sidebar link opens it again', !!(await p.$('#splash')), null);
  await p.keyboard.press('Escape'); ok('Escape closes it', !(await p.$('#splash')), null);
  await p.click('#whatsNew'); await p.click('#splashPfp'); await p.waitForSelector('#pfPhotoBox:not(.hidden)', { timeout: 6000 });
  ok('"Set my picture" goes to my profile', true);
  const ctx2 = await br.newContext({ viewport: { width: 1280, height: 900 } }); const q = await ctx2.newPage();
  await ctx2.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), U); await q.route(/cdn\.jsdelivr\.net|fonts\.g/, (r) => r.abort());
  await q.goto(`http://localhost:${PORT}/`); await sleep(1800);
  ok('automated browsers are not interrupted by it (so other tests keep working)', !(await q.$('#splash')), null);
  await br.close(); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
