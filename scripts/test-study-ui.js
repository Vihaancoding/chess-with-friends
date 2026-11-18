// Study rooms in the browser: pick a game, annotate it together, Stockfish checks the verdicts. Run: node scripts/test-study-ui.js (needs Playwright)
const { chromium } = require('playwright');
process.env.PORT = String(4200 + Math.floor(Math.random() * 9)); process.env.SUPABASE_URL = ''; process.env.ADMIN_KEY = 'k';
const PORT = process.env.PORT, origLog = console.log; console.log = () => {};
require('../server.js'); console.log = origLog;
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => { const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, ...(await r.json()) }; };
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
// a short game where black blunders on move 3 (...Nf6?? is not; ...g6?? lets Qxf7 mate): 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7#
const MOVES = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
(async () => {
  await sleep(300);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = { ann: await su('ann'), bob: await su('bob') };
  const g = await api('create', { color: 'w', tc: { base: 300, inc: 0 } }, P.ann); await api('join', { code: g.code }, P.bob);
  for (let i = 0; i < MOVES.length; i++) await api('move', { code: g.code, from: sq(MOVES[i].slice(0, 2)), to: sq(MOVES[i].slice(2, 4)) }, i % 2 ? P.bob : P.ann);
  await sleep(800);
  const br = await chromium.launch();
  const open = async (u, url = '/') => { const c = await br.newContext({ viewport: { width: 1280, height: 1000 } }); const p = await c.newPage(); p.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); }); p.on('dialog', (d) => d.accept()); await p.route(/cdn\.jsdelivr\.net|fonts\.g/, (r) => r.abort()); await c.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), u); await p.goto(`http://localhost:${PORT}${url}`); return p; };

  const A = await open(P.ann, '/?lounges'); await A.waitForSelector('#lgNew');
  ok('creating a room offers a choice: play room or study room', (await A.$$('input[name=lgkind]')).length === 2, null);
  await A.check('input[name=lgkind][value=study]'); await A.fill('#lgName', 'Study group'); await A.click('#lgNew button[type=submit]'); await A.waitForSelector('#lgStudyP');
  ok('a study room shows the study panel, not tables', !(await A.$('[data-lg="table"]')) && /Choose a game/.test(await A.textContent('#lgStudyP')), null);
  await A.fill('#lgInvName', 'bob'); await A.click('#lgInv button'); await A.waitForFunction(() => /Waiting for: bob/.test(document.querySelector('#lounge').textContent));
  const B = await open(P.bob, '/?lounges'); await B.waitForSelector('[data-lg="yes"]'); await B.click('[data-lg="yes"]'); await B.waitForSelector('#lgStudyP');

  await A.click('[data-lg="pick"]'); await A.waitForSelector('[data-lg="use"]'); await A.click('[data-lg="use"]'); await A.waitForSelector('.stboard');
  ok('picking a game shows a board and the move list', (await A.$$('.stmv')).length === 7 && (await A.$$('.stsq img')).length === 32, null);
  await B.waitForSelector('.stboard', { timeout: 10000 });
  ok('the other member sees the same game', (await B.$$('.stmv')).length === 7, null);

  await A.click('.stmv[data-p="6"]');
  ok('stepping to a move updates the board and shows the note form', /Your note on 3\.\.\. Nf6/.test(await A.textContent('#stForm')) && (await A.$$('.stsq img')).length === 32, await A.textContent('#stForm'));
  await A.click('.stmk[data-m="??"]'); await A.fill('#stText', 'walks into mate'); await A.click('[data-lg="note"]');
  await B.click('.stmv[data-p="6"]'); await B.waitForFunction(() => /walks into mate/.test(document.querySelector('#stList').textContent), null, { timeout: 10000 });
  ok('a note shows up for the other member', true);
  await B.click('.stmk[data-m="!"]'); await B.fill('#stText', 'looks fine to me'); await B.click('[data-lg="note"]');
  await A.waitForFunction(() => /looks fine to me/.test(document.querySelector('#stList').textContent), null, { timeout: 10000 });

  console.log('stockfish');
  await A.waitForFunction(() => /Stockfish agrees|Stockfish disagrees|Close/.test(document.querySelector('#stList').textContent), null, { timeout: 60000 });
  const t = await A.textContent('#stList');
  ok('Stockfish agrees with the blunder mark', /ann[\s\S]*Stockfish agrees/.test(t), t);
  ok('and disagrees with calling it good', /bob[\s\S]*Stockfish disagrees: it rates this as a blunder/.test(t), t);
  ok('the agreement table ranks the members', /Agreement with Stockfish/.test(await A.textContent('#stScore')) && /100%/.test(await A.textContent('#stScore')), await A.textContent('#stScore'));
  if (process.env.SHOT) await A.screenshot({ path: process.env.SHOT + '-study.png', fullPage: true });
  await br.close(); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
