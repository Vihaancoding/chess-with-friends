// The fair-play tribunal in the browser: the case card, voting, discussion, the appeal, the game-over note, phones.
// Run: node scripts/test-tribunal-ui.js   (needs Playwright)
const { chromium } = require('playwright');
process.env.PORT = String(4130 + Math.floor(Math.random() * 9)); process.env.SUPABASE_URL = ''; process.env.ADMIN_KEY = 'k';
const PORT = process.env.PORT, origLog = console.log; console.log = () => {};
require('../server.js'); console.log = origLog;
const app = require('../lib/app'), store = require('../lib/store');
const fx = require('./fixtures/damage-games.json');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => { const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, ...(await r.json()) }; };
const sq = (q) => 'abcdefgh'.indexOf(q[0]) + (8 - +q[1]) * 8;
(async () => {
  await sleep(300);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = {}; for (const n of ['ann', 'bob', 'cat']) P[n] = await su(n);
  app.fairDeps = { scan: async (h, c) => (c === 'w' ? { n: 22, match: 97, acpl: 3, cv: 0.2 } : null) };
  const g = await api('create', { color: 'w', tc: { base: 300, inc: 0 } }, P.ann); await api('join', { code: g.code }, P.bob);
  for (let i = 0; i < 40; i++) { const u = fx[9].ucis[i]; await api('move', { code: g.code, from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)) }, P[i % 2 ? 'bob' : 'ann']); }
  await sleep(500);
  const br = await chromium.launch();
  const open = async (u, viewport) => { const ctx = await br.newContext({ viewport }); const p = await ctx.newPage(); p.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); }); p.on('dialog', (d) => d.accept()); await p.route(/cdn\.jsdelivr\.net/, (r) => r.abort()); await ctx.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), u); return p; };

  const C = await open(P.cat, { width: 1280, height: 900 });
  await C.goto(`http://localhost:${PORT}/`);
  await C.waitForSelector('#fpcard:not(.hidden) .fpc');
  ok('the case shows with the question and five options', /What punishment should ann receive\?/.test(await C.textContent('#fpbody')) && (await C.$$('#fpbody [data-fpvote]')).length === 5);
  ok('the evidence and confidence are on the card', /\d+% sure/.test(await C.textContent('#fpbody')) && /97% engine moves/.test(await C.textContent('#fpbody')));
  ok('the announcement is in the lobby chat', /FAIR PLAY VIOLATION/.test(await C.textContent('#chatlog')) && /ann/.test(await C.textContent('#chatlog')));
  await C.click('[data-fpvote="ban7d"]');
  await C.waitForSelector('[data-fpvote="ban7d"].on');
  ok('voting shows the result straight away', /1 vote/.test(await C.textContent('#fpbody')));
  await C.fill('[data-fpcomment] input', 'seen enough'); await C.click('[data-fpcomment] button');
  await C.waitForFunction(() => /seen enough/.test(document.querySelector('#fpbody').textContent));
  ok('the discussion works', true);
  const M = await open(P.cat, { width: 390, height: 800 });
  await M.goto(`http://localhost:${PORT}/`); await M.waitForSelector('#fpbody .fpc');
  ok('fits a phone', await M.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

  const B = await open(P.bob, { width: 1280, height: 900 });
  await B.goto(`http://localhost:${PORT}/?game=${g.code}`); await sleep(1500);
  const fp = await B.evaluate(() => snap && snap.fp);
  ok('the opponent is told who was forfeited and how sure (in the game state)', fp && fp.name === 'ann' && fp.conf >= 0.95, fp);
  ok('the game ends with a plain reason', /fair play forfeit/.test(await B.textContent('body')), null);

  const id = (await api('fair_cases', {}, P.cat)).cases[0].id;
  const c = await store.get('fcase:' + id); c.pollEnds = Date.now() - 1; await store.set('fcase:' + id, c);
  await api('fair_cases', {}, P.cat);
  const A = await open(P.ann, { width: 1280, height: 900 });
  await A.goto(`http://localhost:${PORT}/`); await A.waitForSelector('[data-fpappeal]');
  await A.fill('[data-fpappeal] input', 'I only analyse after the game.'); await A.click('[data-fpappeal] button');
  await A.waitForFunction(() => /Appeal: should ann/.test(document.querySelector('#fpbody').textContent));
  ok('the appeal turns the case into an uphold or overturn vote', (await A.$$('#fpbody [data-fpvote]')).length === 2);
  await br.close();
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
