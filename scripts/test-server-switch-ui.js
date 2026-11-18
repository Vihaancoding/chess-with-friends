// The server picker: a chip next to the logo opens a sheet; admins tick the servers a player may use. Run: node scripts/test-server-switch-ui.js (needs Playwright)
const { chromium } = require('playwright');
process.env.PORT = String(4180 + Math.floor(Math.random() * 9)); process.env.SUPABASE_URL = ''; process.env.ADMIN_KEY = 'k'; process.env.CLOSED_SERVER1 = '1';
const PORT = process.env.PORT, origLog = console.log; console.log = () => {};
require('../server.js'); console.log = origLog;
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => { const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, ...(await r.json()) }; };
(async () => {
  await sleep(300);
  const o = await api('signup', { email: 'o@x.io', password: 'password1', username: 'owner' }); const O = { name: o.name, token: o.token };
  await api('admin_claim', { key: 'k' }, O); const a = await api('admin_server_new', { name: 'Room 2' }, O);
  const code = (await api('admin_servers', {}, O)).servers.find((s) => s.id === a.id).code;
  const z = await api('signup', { email: 'z@x.io', password: 'password1', username: 'zed', server: code }); const Z = { name: z.name, token: z.token };
  await api('admin_move', { to: a.id }, O);   // admins see the players of the server they are on
  const br = await chromium.launch();
  const open = async (u, w = 1280) => { const c = await br.newContext({ viewport: { width: w, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); }); p.on('dialog', (d) => d.accept()); await p.route(/cdn\.jsdelivr\.net|fonts\.g/, (r) => r.abort()); await c.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), u); await p.goto(`http://localhost:${PORT}/${u === O ? '?admin' : ''}`); return p; };
  const A = await open(O);
  await A.click('#navAdmin'); await A.waitForSelector('[data-act="access"]');
  await A.click('[data-name="zed"][data-act="access"]'); await A.waitForSelector('#sheet input[type=checkbox]');
  ok('the admin gets a tick-list, their server is fixed', (await A.$$('#sheet input[type=checkbox]')).length === 2 && (await A.$$('#sheet input:disabled')).length === 1, null);
  await A.check('#sheet input:not(:disabled)'); await A.click('#sheetSave'); await A.waitForSelector('#sheet', { state: 'detached' });
  await A.waitForFunction(() => /Servers \(1\)/.test(document.querySelector('[data-name="zed"][data-act="access"]').textContent));
  ok('saving closes the sheet and the button shows the count', true);
  const P = await open(Z, 390);
  await P.waitForSelector('.brand .srvname');
  ok('the player has a server chip next to the logo', /Room 2/.test(await P.textContent('.brand .srvname')), null);
  await P.click('.brand .srvname');
  ok('it opens a sheet listing their servers, current one marked', (await P.isVisible('#sheet')) && /you are here/.test(await P.textContent('#sheet')) && (await P.$$('#sheet [data-to]')).length === 1, null);
  ok('the sheet fits a phone', await P.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), null);
  if (process.env.SHOT) await P.screenshot({ path: process.env.SHOT + '-sheet.png' });
  await P.click('#sheet [data-to]');
  await P.waitForFunction(() => { const c = document.querySelector('.brand .srvname'); return c && /Server 1/.test(c.textContent); }, null, { timeout: 8000 });
  ok('switching reloads onto the other server', true);
  ok('admins have the same chip', await A.evaluate(() => !!document.querySelector('.brand .srvname')), null);
  await br.close(); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
