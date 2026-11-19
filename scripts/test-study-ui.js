// Study rooms: the usual game viewer with a notes panel beside it; Stockfish checks the verdicts. Run: node scripts/test-study-ui.js (needs Playwright)
const { chromium } = require('playwright');
process.env.PORT = String(4200 + Math.floor(Math.random() * 9)); process.env.SUPABASE_URL = ''; process.env.ADMIN_KEY = 'k';
const PORT = process.env.PORT, origLog = console.log; console.log = () => {};
require('../server.js'); console.log = origLog;
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => { const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, ...(await r.json()) }; };
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
// 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7#: black's third move (ply 6) walks into mate
const MOVES = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
(async () => {
  await sleep(300);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = { ann: await su('ann'), bob: await su('bob') };
  const g = await api('create', { color: 'w', tc: { base: 300, inc: 0 } }, P.ann); await api('join', { code: g.code }, P.bob);
  for (let i = 0; i < MOVES.length; i++) await api('move', { code: g.code, from: sq(MOVES[i].slice(0, 2)), to: sq(MOVES[i].slice(2, 4)) }, i % 2 ? P.bob : P.ann);
  await sleep(800);
  const br = await chromium.launch();
  const open = async (u, url = '/', w = 1280) => { const c = await br.newContext({ viewport: { width: w, height: 1000 } }); const p = await c.newPage(); p.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); }); p.on('dialog', (d) => d.accept()); await p.route(/cdn\.jsdelivr\.net|fonts\.g/, (r) => r.abort()); await c.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), u); await p.goto(`http://localhost:${PORT}${url}`); return p; };

  const A = await open(P.ann, '/?lounges'); await A.waitForSelector('#lgNew');
  ok('creating a room offers a choice: play room or study room', (await A.$$('input[name=lgkind]')).length === 2, null);
  await A.check('input[name=lgkind][value=study]'); await A.fill('#lgName', 'Study group'); await A.click('#lgNew button[type=submit]'); await A.waitForSelector('#lgStudyP');
  ok('a study room shows a study panel, not tables', !(await A.$('[data-lg="table"]')) && /Choose a game/.test(await A.textContent('#lgStudyP')), null);
  await A.fill('#lgInvName', 'bob'); await A.click('#lgInv button'); await A.waitForFunction(() => /Waiting for: bob/.test(document.querySelector('#lounge').textContent));
  const B = await open(P.bob, '/?lounges'); await B.waitForSelector('[data-lg="yes"]'); await B.click('[data-lg="yes"]'); await B.waitForSelector('#lgStudyP');

  await A.click('[data-lg="pick"]'); await A.waitForSelector('[data-lg="use"]'); await A.click('[data-lg="use"]'); await A.waitForSelector('[data-lg="board"]');
  ok('picking a game offers the full study board', /ann vs bob/.test(await A.textContent('#stPick')), null);
  await A.click('[data-lg="board"]'); await A.waitForSelector('#studypanel:not(.hidden)'); await A.waitForSelector('#moves .mv[data-ply="6"]');
  ok('it opens in the usual game viewer: the board, the move list, the review', (await A.isVisible('#board, #boardwrap')) && (await A.$$('#moves .mv:not(.ph)')).length === 7 && !(await A.isHidden('#anpanel')), null);
  ok('the panel beside it names the room', /Study · Study group/.test(await A.textContent('#sgTitle')), null);
  await B.waitForSelector('[data-lg="board"]', { timeout: 10000 }); await B.click('[data-lg="board"]'); await B.waitForSelector('#studypanel:not(.hidden)'); await B.waitForSelector('#moves .mv[data-ply="6"]');

  console.log('notes');
  await A.click('#moves .mv[data-ply="6"]:not(.ph)');
  await A.waitForFunction(() => /Your note on 3\.\.\. Nf6/.test(document.querySelector('#sgForm').textContent), null, { timeout: 8000 });
  ok('stepping to a move (in the usual way) shows the note form for it', true);
  await A.click('#sgForm [data-m="??"]'); await A.fill('#sgText', 'walks into mate'); await A.click('[data-sg="note"]');
  await B.click('#moves .mv[data-ply="6"]:not(.ph)');
  await B.waitForFunction(() => /walks into mate/.test(document.querySelector('#sgList').textContent), null, { timeout: 10000 });
  ok('a note shows up for the other member', true);
  await B.click('#sgForm [data-m="!"]'); await B.fill('#sgText', 'looks fine to me'); await B.click('[data-sg="note"]');
  await A.waitForFunction(() => /looks fine to me/.test(document.querySelector('#sgList').textContent), null, { timeout: 10000 });
  ok('and the move list marks moves that have notes', !!(await A.$('#moves .mv[data-ply="6"][data-notes]')), null);

  console.log('stockfish');
  await A.waitForFunction(() => /Stockfish agrees/.test(document.querySelector('#sgList').textContent) && /Stockfish disagrees/.test(document.querySelector('#sgList').textContent), null, { timeout: 60000 });
  const t = await A.textContent('#sgList');
  ok('Stockfish agrees with the blunder mark', /ann[\s\S]*Stockfish agrees/.test(t), t);
  ok('and disagrees with calling it good', /bob[\s\S]*Stockfish disagrees: it rates this as a blunder/.test(t), t);
  ok('the agreement table ranks the members', /100%/.test(await A.textContent('#sgScore')), await A.textContent('#sgScore'));

  console.log('chat and leaving');
  await A.fill('#sgIn', 'nice catch'); await A.click('#sgSend button[type=submit]');
  await B.waitForFunction(() => /nice catch/.test(document.querySelector('#sgLog').textContent), null, { timeout: 10000 });
  ok('the room chat works beside the board', true);
  if (process.env.SHOT) { await sleep(500); await A.screenshot({ path: process.env.SHOT + '-study.png', fullPage: true }); }
  await A.click('#leave'); await A.waitForSelector('#lgStudyP', { timeout: 8000 });
  ok('"Back to room" returns to the room, and the panel closes', await A.isHidden('#studypanel'), null);
  await br.close(); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
