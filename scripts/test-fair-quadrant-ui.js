// The top-left quadrant flag: a player whose cursor keeps leaving through the top-left on their own turns is flagged once,
// and both players get a notice laid over the board. Run: node scripts/test-fair-quadrant-ui.js (needs Playwright, takes ~25 s)
const { chromium } = require('playwright');
process.env.PORT = String(4260 + Math.floor(Math.random() * 9)); process.env.SUPABASE_URL = ''; process.env.ADMIN_KEY = 'k';
const PORT = process.env.PORT, origLog = console.log; console.log = () => {};
require('../server.js'); console.log = origLog;
const Chess = require('../public/chess.js');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => { const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, ...(await r.json()) }; };
(async () => {
  await sleep(300);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const A = await su('ann'), B = await su('bob');
  const g = await api('create', { color: 'w', tc: { base: 600, inc: 0 } }, A); await api('join', { code: g.code }, B);
  const br = await chromium.launch();
  const open = async (who) => { const c = await br.newContext({ viewport: { width: 1280, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); }); await p.route(/cdn\.jsdelivr\.net|fonts\.g/, (x) => x.abort()); await c.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), who); await p.goto(`http://localhost:${PORT}/?game=${g.code}`); await p.waitForSelector('#board .sq'); return p; };
  const pa = await open(A), pb = await open(B);
  const leave = (p, x, y) => p.evaluate(([cx, cy]) => document.dispatchEvent(new MouseEvent('mouseout', { clientX: cx, clientY: cy, relatedTarget: null, bubbles: true })), [x, y]);
  const warn = (p) => p.evaluate(() => { const o = document.querySelector('#fwSheet'); return o ? o.textContent : null; });

  let st = Chess.initial(), ply = 0;
  const play = async (who) => { const ms = Chess.legalMoves(st); const m = ms[(ply * 7 + 3) % ms.length]; const r = await api('move', { code: g.code, from: m.from, to: m.to, ...(m.promo ? { promo: m.promo } : {}) }, who); st = Chess.apply(st, m); ply++; return r; };

  console.log('exits that must not count');
  await api('move', { code: g.code, from: 52, to: 36 }, A); st = Chess.apply(st, Chess.legalMoves(st).find((m) => m.from === 52 && m.to === 36)); ply++;
  await api('move', { code: g.code, from: 12, to: 28 }, B); st = Chess.apply(st, Chess.legalMoves(st).find((m) => m.from === 12 && m.to === 28)); ply++;
  await pa.waitForFunction(() => snap && snap.state.turn === snap.you, null, { timeout: 10000 }); await sleep(1100);
  await leave(pa, 1200, 3); await leave(pa, 600, 890); await leave(pa, 1275, 700);   // top right, bottom, right edge: not the top-left quadrant
  ok('leaving anywhere but the top-left quadrant does not start the count', await pa.evaluate(() => FPC.tl.size === 0), await pa.evaluate(() => FPC.tl.size));

  console.log('the top-left quadrant on many turns');
  await play(A); await play(B);
  for (let t = 0; t < 8; t++) {
    await pa.waitForFunction((n) => snap && snap.state.turn === snap.you && (snap.hist || snap.moves).length >= n, ply, { timeout: 10000 });
    await sleep(1100);                                   // the page notes my turn once a second
    await leave(pa, t % 2 ? 4 : 300, t % 2 ? 200 : 3);   // through the left edge, then through the top edge, both in the quadrant
    if (t === 3) ok('a few exits are not enough to flag anyone', (await warn(pa)) === null && (await warn(pb)) === null, await warn(pa));
    await play(A); await play(B);
  }
  await pa.waitForFunction(() => document.querySelector('#fwSheet'), null, { timeout: 15000 });
  const ta = await warn(pa);
  ok('the flagged player gets a notice over the board', /recorded for the admins/.test(ta) && await pa.evaluate(() => document.querySelector('#boardwrap #fwSheet') !== null), ta);
  await pb.waitForFunction(() => document.querySelector('#fwSheet'), null, { timeout: 15000 });
  const tb = await warn(pb);
  ok('the opponent gets a notice over the board too, naming the player', /ann/.test(tb) && /admins will take a look/.test(tb), tb);
  ok('the notice is addressed to each of them (not the same text)', ta !== tb, null);
  ok('the app does not flag its own notice as a layer over the board', await pa.evaluate(() => !fpFindings().some((x) => /fwSheet|sheet/.test(x))), await pa.evaluate(() => fpFindings()));
  await pb.click('#fwOk');
  ok('"OK" closes it', (await warn(pb)) === null, null);
  await sleep(1500);
  ok('and it stays closed on the next update', (await warn(pb)) === null, await warn(pb));
  ok('the flagged player still has it until they close it', (await warn(pa)) !== null, null);
  await pa.click('#fwOk');
  ok('the flag was recorded for the admins as a top-left quadrant report', await pa.evaluate(() => [...FP.sent].some((k) => /top-left quadrant/.test(k))), null);
  ok('only once per game (a second batch of exits sends nothing new)', await (async () => { const n = await pa.evaluate(() => FP.sent.size); await leave(pa, 5, 5); return (await pa.evaluate(() => FP.sent.size)) === n; })(), null);
  await br.close(); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
