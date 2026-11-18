// Rooms in the browser: make a room, invite, chat live, open a table, play, see the table. Run: node scripts/test-lounge-ui.js (needs Playwright)
const { chromium } = require('playwright');
process.env.PORT = String(4190 + Math.floor(Math.random() * 9)); process.env.SUPABASE_URL = ''; process.env.ADMIN_KEY = 'k';
const PORT = process.env.PORT, origLog = console.log; console.log = () => {};
require('../server.js'); console.log = origLog;
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => { const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, ...(await r.json()) }; };
(async () => {
  await sleep(300);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = {}; for (const n of ['ann', 'bob', 'cat']) P[n] = await su(n);
  const br = await chromium.launch();
  const open = async (u, url = '/', w = 1280) => { const c = await br.newContext({ viewport: { width: w, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); }); p.on('dialog', (d) => d.accept()); await p.route(/cdn\.jsdelivr\.net|fonts\.g/, (r) => r.abort()); await c.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), u); await p.goto(`http://localhost:${PORT}${url}`); return p; };
  const A = await open(P.ann); await A.waitForSelector('#navLounge');
  await A.click('#navLounge'); await A.waitForSelector('#lgNew');
  ok('the Rooms page explains itself and starts empty', /Private rooms/.test(await A.textContent('#lounge')) && /not in any room/.test(await A.textContent('#lounge')), null);
  await A.fill('#lgName', 'Friday club'); await A.click('#lgNew button[type=submit]'); await A.waitForSelector('#lgSend');
  ok('creating a room opens it with me as owner', /Friday club/.test(await A.textContent('#lounge')) && /owner/.test(await A.textContent('#lounge')), null);
  await A.fill('#lgInvName', 'bob'); await A.click('#lgInv button'); await A.waitForFunction(() => /Waiting for: bob/.test(document.querySelector('#lounge').textContent)); await A.fill('#lgInvName', 'cat'); await A.click('#lgInv button');
  await A.waitForFunction(() => /Waiting for: bob, cat/.test(document.querySelector('#lounge').textContent));
  ok('inviting shows who we are waiting for', true);

  const B = await open(P.bob); await B.waitForSelector('#navLounge.dot', { timeout: 8000 });
  ok('the invited person sees a dot on Rooms', true);
  await B.waitForFunction(() => /invited you/.test(document.querySelector('#roomlist').textContent), null, { timeout: 8000 });
  ok('the lobby has a Rooms card showing the invitation', await B.isVisible('#roomcard'), null);
  await B.click('#navLounge'); await B.waitForSelector('[data-lg="yes"]'); await B.click('[data-lg="yes"]'); await B.waitForSelector('#lgSend');
  ok('they join from the invitation', /Friday club/.test(await B.textContent('#lounge')), null);
  const C = await open(P.cat, '/?lounges', 390); await C.waitForSelector('[data-lg="yes"]'); await C.click('[data-lg="yes"]'); await C.waitForSelector('#lgSend');
  await sleep(1200);
  ok('the room page fits a phone', await C.evaluate(() => [...document.querySelectorAll('#lounge *')].every((e) => e.getBoundingClientRect().right <= innerWidth + 1)), null);
  if (process.env.SHOT) { await sleep(600); await C.screenshot({ path: process.env.SHOT + '-phone.png', fullPage: true }); await A.screenshot({ path: process.env.SHOT + '-desktop.png' }); }

  await A.click('#navPlay'); await A.waitForFunction(() => /Friday club/.test(document.querySelector('#roomlist').textContent));
  await A.click('#roomlist [data-rm]'); await A.waitForSelector('#lgSend');
  ok('my room is listed on the lobby card and opens from it', /Friday club/.test(await A.textContent('#lounge')), null);
  console.log('chat');
  await A.fill('#lgIn', 'hi all'); await A.click('#lgSend button'); await B.waitForFunction(() => /hi all/.test(document.querySelector('#lgLog').textContent), null, { timeout: 8000 });
  await C.waitForFunction(() => /hi all/.test(document.querySelector('#lgLog').textContent), null, { timeout: 8000 });
  ok('a message reaches everyone in the room', true);

  console.log('playing');
  await B.click('[data-lg="table"]'); await B.waitForSelector('#board, #boardwrap', { timeout: 10000 });
  ok('opening a table puts me in a game', await B.evaluate(() => view === 'game'), null);
  await A.waitForSelector('[data-lg="sit"]', { timeout: 10000 });
  ok('the others see the open table', /bob/.test(await A.textContent('#lounge')), null);
  await A.click('[data-lg="sit"]'); await A.waitForFunction(() => view === 'game', null, { timeout: 8000 });
  ok('another member sits down and the game starts', true);
  await api('resign', { code: await A.evaluate(() => gameCode) }, P.ann);
  await sleep(500);
  const code = await A.evaluate(() => gameCode); const g = await api('room', { code }, P.ann);
  await br.close();
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
