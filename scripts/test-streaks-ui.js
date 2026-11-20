// Win streaks in the browser: the Domination Report after a game, the milestone moment, the board and the profile. Run: node scripts/test-streaks-ui.js (needs Playwright)
const { chromium } = require('playwright');
process.env.PORT = String(4290 + Math.floor(Math.random() * 9)); process.env.SUPABASE_URL = ''; process.env.ADMIN_KEY = 'k';
const PORT = process.env.PORT, origLog = console.log; console.log = () => {};
require('../server.js'); console.log = origLog;
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => { const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, ...(await r.json()) }; };
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
const MV = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
(async () => {
  await sleep(300);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const A = await su('ann'), B = await su('bob');
  const play = async (code, upto) => { for (let i = 0; i < upto; i++) await api('move', { code, from: sq(MV[i].slice(0, 2)), to: sq(MV[i].slice(2, 4)) }, i % 2 ? B : A); };
  for (let k = 0; k < 2; k++) { const g = await api('create', { color: 'w', tc: { base: 600, inc: 0 } }, A); await api('join', { code: g.code }, B); await play(g.code, 7); await sleep(400); }
  const br = await chromium.launch(); const ctx = await br.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage();
  p.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); }); await p.route(/cdn\.jsdelivr\.net|fonts\.g/, (x) => x.abort());
  await ctx.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), A);
  const g3 = await api('create', { color: 'w', tc: { base: 600, inc: 0 } }, A); await api('join', { code: g3.code }, B); await play(g3.code, 6);
  await p.goto(`http://localhost:${PORT}/?game=${g3.code}`); await p.waitForSelector('#board .sq'); await sleep(800);
  await api('move', { code: g3.code, from: sq('h5'), to: sq('f7') }, A);
  await p.waitForSelector('#chatToast.show', { timeout: 20000 });
  ok('a milestone is celebrated in the site\'s own toast, with the real number and some attitude', /3 wins in a row/.test(await p.textContent('#chatToast')) && /heat is rising/i.test(await p.textContent('#chatToast')), await p.textContent('#chatToast'));
  ok('the game-over screen itself is untouched (no streak block added to it)', !(await p.$('#odom')) && !(await p.$('#msOverlay')), null);
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT + '-dom.png' });
  await p.reload(); await p.waitForSelector('#board .sq'); await sleep(4000);
  ok('reloading does not celebrate it again', !(await p.$('#chatToast.show')), null);
  await p.goto(`http://localhost:${PORT}/`); await p.waitForSelector('#strkLb tr', { timeout: 15000 }); await sleep(600);
  ok('the Win streaks board lists her first with 3 in a row, and has the other boards as tabs', /ann/.test(await p.textContent('#strkLb tr')) && (await p.$$('#strkTabs button')).length === 5, await p.textContent('#strkBody'));
  await p.click('[data-sk="rate"]');
  ok('the win-rate board needs a minimum number of games', /Needs at least 10|at least 10 completed/.test(await p.textContent('#strkBody')), await p.textContent('#strkBody'));
  await p.click('#meName'); await p.waitForSelector('#pfStreakCards .rcard', { timeout: 15000 });
  ok('her profile shows streak, longest streak, win rate and milestones as rating-style cards', (await p.$$('#pfStreakCards .rcard')).length === 4 && /3 in a row/.test(await p.textContent('#pfStreakCards')) && /3 wins/.test(await p.textContent('#pfStreakCards')), await p.textContent('#pfStreakCards'));
  await p.setViewportSize({ width: 390, height: 800 }); await sleep(300);
  ok('it fits a phone', await p.evaluate(() => [...document.querySelectorAll('#pfStreakCards *')].every((e) => e.getBoundingClientRect().right <= innerWidth + 1)), null);
  await br.close(); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
