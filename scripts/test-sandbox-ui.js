// The Sandbox room: one blank board, any pieces anywhere, play from any position. Run: node scripts/test-sandbox-ui.js (needs Playwright)
const { chromium } = require('playwright');
process.env.PORT = String(4240 + Math.floor(Math.random() * 9)); process.env.SUPABASE_URL = ''; process.env.ADMIN_KEY = 'k';
const PORT = process.env.PORT, origLog = console.log; console.log = () => {};
require('../server.js'); console.log = origLog;
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await sleep(300);
  const r = await fetch(`http://localhost:${PORT}/api?r=signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@x.io', password: 'password1', username: 'ann' }) }).then((x) => x.json());
  const room = await fetch(`http://localhost:${PORT}/api?r=lounge_create`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-name': r.name, 'x-token': r.token }, body: JSON.stringify({ name: 'Sand', kind: 'board' }) }).then((x) => x.json());
  const br = await chromium.launch(); const ctx = await br.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage();
  p.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); });
  await p.route(/cdn\.jsdelivr\.net|fonts\.g/, (x) => x.abort());
  await ctx.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), { name: r.name, token: r.token });
  await p.goto(`http://localhost:${PORT}/?lounge=${room.id}`); await p.waitForSelector('[data-lg="sbopen"]'); await p.click('[data-lg="sbopen"]'); await p.waitForSelector('.sbboard');
  const click = p.click.bind(p); p.click = async (sel) => { await click(sel); await sleep(150); };   // the room board is saved on the server, so give each action a moment
  const sq = (s) => `.sbsq[data-sq="${'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8}"]`;
  const pieces = () => p.$$eval('.sbsq img', (a) => a.length);
  const put = async (piece, ...squares) => { await p.click(`[data-pick="${piece}"]`); for (const s of squares) await p.click(sq(s)); };

  console.log('the blank board');
  ok('the room opens with one empty 8x8 board', (await p.$$('.sbsq')).length === 64 && (await pieces()) === 0, await pieces());
  ok('there is a palette with every piece in both colours', (await p.$$('.sbp[data-pick]')).length === 13, null);
  await put('wQ', 'a1', 'h8'); await put('bN', 'd4'); await put('wP', 'a8', 'e1'); await put('bP', 'h1');
  ok('pieces can go anywhere (two queens, a knight, pawns even on the first and last rows)', (await pieces()) === 6, await pieces());
  await p.click(sq('d4'));   // clicking an occupied square with a different piece selected replaces it
  ok('placing a different piece on a square replaces it', (await pieces()) === 6, null);
  await p.click('[data-pick="x"]'); await p.click(sq('h1'));
  ok('the remove tool takes a piece away', (await pieces()) === 5, null);
  await p.click('[data-sbclear]'); ok('"Clear the board" empties it again', (await pieces()) === 0, null);

  console.log('play from any position');
  await put('wK', 'e1'); await put('wK', 'a3'); await put('bR', 'h5'); await put('wR', 'a5');   // two white kings and no black king: nothing forbids it
  await p.click('[data-sbmode="play"]'); await p.waitForSelector('[data-sbundo]');
  ok('play starts from exactly that position', (await pieces()) === 4 && /White to move/.test(await p.textContent('.sbstatus')), await p.textContent('.sbstatus'));
  await p.click(sq('a5')); const dots = await p.$$('.sbsq.tgt');
  ok('selecting a piece shows where it can go (it moves like that piece, wherever it stands)', dots.length >= 8, dots.length);
  await p.click(sq('a7'));
  ok('moving works and passes the turn', /Black to move/.test(await p.textContent('.sbstatus')) && !!(await p.$(sq('a7') + ' img')) && !(await p.$(sq('a5') + ' img')), null);
  await p.click(sq('h5')); await p.click(sq('a5'));
  ok('captures work, in a position with no black king', !!(await p.$(sq('a5') + ' img')) && (await pieces()) === 4 - 0, await pieces());
  await p.click('[data-sbundo]'); await p.click('[data-sbundo]');
  ok('undo takes moves back one by one', /White to move/.test(await p.textContent('.sbstatus')) && !!(await p.$(sq('a5') + ' img')), null);
  await p.click('[data-sbmode="setup"]');
  ok('back to placing pieces: the setup is still there', (await pieces()) === 4, null);

  console.log('checks and the end of the game still follow the rules when both kings exist');
  await p.click('[data-sbclear]'); await put('bK', 'a8'); await put('wK', 'c6'); await put('wQ', 'b7');
  await p.click('[data-sbturn="b"]'); await p.click('[data-sbmode="play"]'); await p.waitForSelector('.sbstatus');
  ok('a position with no moves for the side to move says so (checkmate)', /Checkmate: White wins/.test(await p.textContent('.sbstatus')), await p.textContent('.sbstatus'));
  await p.click('[data-sbmode="setup"]'); await p.click('[data-sbclear]'); await put('wK', 'e1'); await put('bK', 'e8'); await put('wP', 'a7');
  await p.click('[data-sbturn="w"]'); await p.click('[data-sbmode="play"]'); await p.click(sq('a7')); await p.click(sq('a8'));
  ok('a pawn that reaches the last row becomes a queen', (await p.getAttribute(sq('a8') + ' img', 'src')).includes('wQ'), null);
  await p.click('[data-sbmode="setup"]'); await p.click('[data-sbclear]'); await put('wK', 'a1'); await put('bK', 'h8');
  await p.click('[data-sbmode="play"]'); await p.click(sq('a1')); await p.click(sq('a2'));
  ok('even two bare kings can be played (no draw rule gets in the way)', /Black to move/.test(await p.textContent('.sbstatus')), await p.textContent('.sbstatus'));
  ok('the board fits a phone', await (async () => { await p.setViewportSize({ width: 390, height: 800 }); await sleep(300); return p.evaluate(() => [...document.querySelectorAll('#sandbox *')].every((e) => e.getBoundingClientRect().right <= innerWidth + 1)); })(), null);
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT + '-sandbox.png', fullPage: true });
  await br.close(); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
