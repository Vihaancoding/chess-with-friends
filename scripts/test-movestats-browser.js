// Move stats counted by players' browsers (not the server's engine): a lobby tab takes a game, searches it with its own Stockfish and sends the scores back.
// Run: node scripts/test-movestats-browser.js (needs Playwright, ~30 s)
const { chromium } = require('playwright');
process.env.PORT = String(4300 + Math.floor(Math.random() * 9)); process.env.SUPABASE_URL = ''; process.env.ADMIN_KEY = 'k'; delete process.env.STATS_SERVER;
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
  const A = await su('ann'), B = await su('bob'), C = await su('cat');
  const g = await api('create', { color: 'w', tc: { base: 600, inc: 0 } }, A); await api('join', { code: g.code }, B);
  for (let i = 0; i < 7; i++) await api('move', { code: g.code, from: sq(MV[i].slice(0, 2)), to: sq(MV[i].slice(2, 4)) }, i % 2 ? B : A);
  await sleep(500);
  ok('the server does not run its own engine: the game waits in the queue', (await api('stats_board', {}, C)).pending === 1, await api('stats_board', {}, C));
  ok('a player is never given their own game to count', (await api('stats_job', {}, A)).job === null && (await api('stats_job', {}, B)).job === null, null);
  const bad = await api('stats_submit', { id: g.code + '-x', res: [{ i: 1, s: 5 }] }, C);
  ok('scores for a game that was not given out are refused', bad.status === 409, bad);
  const br = await chromium.launch(); const ctx = await br.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage();
  p.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); });
  await ctx.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), C);
  await p.goto(`http://localhost:${PORT}/`); await p.waitForSelector('#statscard');
  await p.waitForFunction(() => /checked in this round|every finished game/i.test(document.querySelector('#statsBody')?.textContent || ''), null, { timeout: 120000 }).catch(() => {});
  let b = null; for (let i = 0; i < 40 && !(b && b.pending === 0); i++) { b = await api('stats_board', {}, C); await sleep(1000); }
  ok('Cat\'s browser counted the game', b && b.pending === 0 && b.rows.some((r) => r.name === 'ann' && r.games === 1), b);
  const bob = b && b.rows.find((r) => r.name === 'bob');
  ok('Black walking into mate is a blunder', bob && bob.blunder >= 1, bob);
  await br.close(); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
