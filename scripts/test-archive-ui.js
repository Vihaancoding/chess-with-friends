// Game archive UI tests: plays real games through the API, then drives the archive, replay and analysis in a
// headless browser, on a desktop and a phone-sized screen.
// Run: node scripts/test-archive-ui.js          (needs Playwright: npm i -g playwright, or NODE_PATH pointing at it)
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 4010 + Math.floor(Math.random() * 9), BASE = `http://localhost:${PORT}`;
let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => {
  const r = await fetch(`${BASE}/api?r=${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) });
  return { status: r.status, ...(await r.json()) };
};
const sq = (q) => 'abcdefgh'.indexOf(q[0]) + (8 - +q[1]) * 8;
async function game(w, b, tc, ucis, end) {
  const c = await api('create', { color: 'w', tc }, w);
  await api('join', { code: c.code }, b);
  for (const [i, u] of ucis.entries()) {
    const r = await api('move', { code: c.code, from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)) }, i % 2 ? b : w);
    if (r.status !== 200) throw new Error(`${u}: ${r.error}`);
  }
  if (end) await end(c.code);
  return c.code;
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, SUPABASE_URL: '' }, stdio: 'ignore' });
  await sleep(800);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const alice = await su('alice'), bob = await su('bob'), cara = await su('cara');
  // 1: alice (white) mates bob · 2: cara beats alice (Sicilian, resignation) · 3: alice and bob draw (unrated, no clock)
  await game(alice, bob, { base: 300, inc: 0 }, ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7']);
  await game(cara, alice, { base: 60, inc: 0 }, ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6'], (c) => api('resign', { code: c }, alice));
  await game(bob, alice, null, ['d2d4', 'd7d5', 'c2c4'], async (c) => { await api('draw_offer', { code: c }, alice); await api('draw_accept', { code: c }, bob); });
  for (let i = 0; i < 40 && (await api('games', { name: 'alice' }, alice)).games.length < 3; i++) await sleep(50);

  const br = await chromium.launch();
  for (const [label, viewport] of [['desktop', { width: 1280, height: 860 }], ['phone', { width: 390, height: 800 }]]) {
    console.log(`\n${label}`);
    const page = await br.newPage({ viewport });
    page.on('pageerror', (e) => { if (!/outerHTML/.test(e.message)) { failed++; console.log('  ✗ page error:', e.message); } });
    await page.route(/cdn\.jsdelivr\.net/, (r) => r.abort());          // piece images: the text fallback is enough here
    await page.addInitScript((u) => localStorage.setItem('chess:user', JSON.stringify(u)), alice);
    await page.goto(BASE + '/');
    await page.waitForSelector('#lobby:not(.hidden)');

    // ----- archive list -----
    await page.click('#navProfile');
    await page.waitForSelector('#pfGames .grow.ga[data-id]');
    const rows = () => page.$$eval('#pfGames .grow.ga', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')));
    let r = await rows();
    ok('all three games listed, newest first', r.length === 3 && /vs bob/.test(r[0]) && /vs cara/.test(r[1]) && /vs bob/.test(r[2]), r);
    ok('row shows result, opening, time control, moves and rating change', /^D/.test(r[0]) && /\+0/.test(r[0]) && /^L/.test(r[1]) && /Sicilian/.test(r[1]) && /Bullet/.test(r[1]) && /5 moves/.test(r[1]) && /−\d+/.test(r[1]) && /\+\d+/.test(r[2]), r);
    ok('count shown', (await page.textContent('#gaCount')).includes('3 games'), await page.textContent('#gaCount'));
    ok('no horizontal page scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));

    await page.selectOption('#gaRes', 'win'); r = await rows();
    ok('filter by result', r.length === 1 && /^W/.test(r[0]), r);
    await page.selectOption('#gaRes', ''); await page.selectOption('#gaCat', 'bullet'); r = await rows();
    ok('filter by time control', r.length === 1 && /cara/.test(r[0]), r);
    await page.selectOption('#gaCat', ''); await page.fill('#gaQ', 'sicil'); await sleep(200); r = await rows();
    ok('search by opening', r.length === 1 && /cara/.test(r[0]), r);
    await page.fill('#gaQ', 'BOB'); await sleep(200); r = await rows();
    ok('search by opponent', r.length === 2 && r.every((x) => /bob/.test(x)), r);
    await page.fill('#gaQ', 'nobody'); await sleep(200);
    ok('empty filter state with a way out', (await page.textContent('#pfGames')).includes('No games match'), await page.textContent('#pfGames'));
    await page.click('#gaClear'); r = await rows();
    ok('clear filters', r.length === 3 && (await page.inputValue('#gaQ')) === '', r);
    const ops = await page.$$eval('#gaOp option', (o) => o.map((x) => x.value).filter(Boolean));
    ok('opening menu lists the openings played', ops.includes('Sicilian Defense') && ops.length >= 2, ops);
    await page.selectOption('#gaOp', 'Sicilian Defense'); r = await rows();
    ok('filter by opening', r.length === 1 && /cara/.test(r[0]), r);
    await page.selectOption('#gaOp', '');
    await page.selectOption('#gaSort', 'opp'); r = await rows();
    ok('sort by opponent', /bob/.test(r[0]) && /bob/.test(r[1]) && /cara/.test(r[2]), r);
    await page.selectOption('#gaSort', 'old'); r = await rows();
    ok('sort oldest first', /^W/.test(r[0]) && /^D/.test(r[2]), r);
    await page.selectOption('#gaSort', 'res'); r = await rows();
    ok('sort by result', /^W/.test(r[0]) && /^D/.test(r[1]) && /^L/.test(r[2]), r);
    await page.selectOption('#gaSort', 'new');
    await page.selectOption('#gaWhen', '1'); r = await rows();
    ok('filter by date', r.length === 3, r);
    await page.selectOption('#gaWhen', '');

    // ----- replay -----
    const before = await api('me', {}, alice);
    await page.click('#pfGames .grow.ga:nth-child(3) [data-act="replay"]');             // the mate against bob
    await page.waitForFunction(() => snap && snap.code === 'ARCHIVE');
    const st = () => page.evaluate(() => ({ ply: curPly(), n: snap.hist.length, viewPly, status: $('#status').textContent, url: location.search, op: $('#opName').textContent,
      pieces: [...document.querySelectorAll('#board .sq')].filter((e) => e.querySelector('.piece, .glyph')).length, cur: (document.querySelector('#moves .mv.cur') || {}).textContent || null }));
    let s = await st();
    ok('opens at the start with the full move list', s.ply === 0 && s.n === 7 && s.pieces === 32 && /^\?archive=/.test(s.url) && (await page.$$('#moves .mv:not(.ph)')).length === 7, s);
    ok('no chat, rematch or resign in a replay', await page.evaluate(() => ['#gchat', '#rematch', '#resign', '#drawBtn', '#pauseBtn'].every((x) => $(x).classList.contains('hidden'))));
    await page.click('#mvNext'); await page.click('#mvNext'); s = await st();
    ok('next move', s.ply === 2 && s.cur === 'e5', s);
    await page.click('#mvPrev'); s = await st();
    ok('previous move', s.ply === 1 && s.cur === 'e4', s);
    await page.click('#moves .mv[data-ply="5"]'); s = await st();
    ok('click a move to jump to it', s.ply === 5 && s.cur === 'Qh5' && /Move 3/.test(s.status), s);
    await page.keyboard.press('End'); s = await st();
    ok('End shows the final position', s.viewPly === null && /You win/.test(s.status), s);
    await page.keyboard.press('Home'); s = await st();
    ok('Home goes back to the start', s.ply === 0, s);
    await page.keyboard.press('ArrowRight'); s = await st();
    ok('arrow keys step through', s.ply === 1, s);
    ok('opening shown', /^[A-E]\d\d/.test(s.op), s.op);
    // play / pause / speed
    await page.evaluate(() => { RP.speed = 4; paintReplay(); });
    await page.click('#mvPlay');
    await sleep(900); s = await st();
    ok('play steps forward on its own', s.ply >= 3, s);
    await page.click('#mvPlay'); const paused = (await st()).ply; await sleep(600);
    ok('pause stops it', (await st()).ply === paused && !(await page.evaluate(() => !!RP.timer)), paused);
    await page.click('#mvSpeed');
    ok('speed control cycles', (await page.textContent('#mvSpeed')) === '0.5×', await page.textContent('#mvSpeed'));
    await page.evaluate(() => { RP.speed = 4; paintReplay(); });
    await page.keyboard.press('End'); await page.click('#mvPlay'); await sleep(2600); s = await st();
    ok('play from the end restarts and stops at the last move', s.viewPly === null && !(await page.evaluate(() => !!RP.timer)), s);
    ok('board cannot be moved on in a replay', await page.evaluate(() => { goPly(0); clickSquare(52); clickSquare(36); return snap.hist.length === 7 && curPly() === 0 && selected === null; }));

    // ----- analysis -----
    await page.click('#moves .mv[data-ply="4"]');
    await page.click('#anBtn');
    await page.waitForFunction(() => AN.res[3] && AN.res[4], null, { timeout: 15000 });
    ok('analysis starts from the move on the board', await page.evaluate(() => AN.queue[0] === 3), await page.evaluate(() => AN.queue.slice(0, 3)));
    await page.waitForFunction(() => AN.done, null, { timeout: 30000 });
    const an = await page.evaluate(() => ({ cls: AN.cls.slice(), comment: $('#anComment').textContent, sum: $('#anSummary').textContent, graph: !!document.querySelector('#anGraph svg') }));
    ok('every move classified, with accuracy and an eval graph', an.cls.length === 7 && an.cls.every(Boolean) && /Accuracy/.test(an.sum) && an.graph, an);
    await page.click('#moves .mv[data-ply="6"]');
    const c6 = await page.textContent('#anComment');
    ok('Nf6?? is flagged as a blunder with the better move and an eval', /Nf6/.test(c6) && /blunder/i.test(c6) && /Better was/.test(c6) && /Eval/.test(c6), c6);
    ok('mistakes are marked in the move list', await page.evaluate(() => document.querySelector('#moves .mv[data-ply="6"]').dataset.sym === '??'));
    await page.click('#mvPlay'); await sleep(400);
    ok('replay keeps working while analyzing', (await st()).ply > 6 || (await st()).viewPly === null);

    // ----- read-only, back, deep link -----
    const after = await api('me', {}, alice);
    ok('replaying and analyzing changed nothing on the account', JSON.stringify(before.user) === JSON.stringify(after.user), [before.user, after.user]);
    await page.click('#leave');
    await page.waitForSelector('#profile:not(.hidden) #pfGames .grow.ga');
    ok('back returns to the archive', await page.evaluate(() => view === 'profile'));
    await page.click('#pfGames .grow.ga:nth-child(2) [data-act="analyze"]');
    await page.waitForFunction(() => snap && snap.code === 'ARCHIVE' && AN.key);
    ok('Analyze button opens the game with the review running', await page.evaluate(() => !$('#anpanel').classList.contains('hidden') && snap.players.w.name === 'cara'));
    const link = await page.evaluate(() => location.href);
    await page.goto(link); await page.waitForFunction(() => snap && snap.code === 'ARCHIVE');
    ok('a replay link opens the same game', await page.evaluate(() => snap.hist.length === 10 && snap.status.reason === 'resignation'));
    ok('black player sees the board from black', await page.evaluate(() => snap.you === 'b' && boardFlip === true));
    ok('no horizontal scroll in the replay', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: path.join(process.env.SHOTS || '/tmp', `archive-replay-${label}.png`) });
    await page.click('#leave'); await page.waitForSelector('#pfGames .grow.ga');
    await page.screenshot({ path: path.join(process.env.SHOTS || '/tmp', `archive-list-${label}.png`), fullPage: true });
    await page.close();
  }

  // a live game is not disturbed by someone browsing the archive
  console.log('\nlive games');
  const live = await api('create', { color: 'w', tc: { base: 300, inc: 0 } }, bob);
  await api('join', { code: live.code }, cara);
  await api('move', { code: live.code, from: sq('e2'), to: sq('e4') }, bob);
  const page = await br.newPage();
  await page.route(/cdn\.jsdelivr\.net/, (r) => r.abort());
  await page.addInitScript((u) => localStorage.setItem('chess:user', JSON.stringify(u)), bob);
  await page.goto(BASE + '/?game=' + live.code);
  await page.waitForFunction(() => snap && snap.code !== 'ARCHIVE' && snap.moves.length === 1);
  ok('live game has no replay controls while running', await page.evaluate(() => $('#mvPlay').classList.contains('hidden')));
  await api('move', { code: live.code, from: sq('e7'), to: sq('e5') }, cara);
  await page.waitForFunction(() => snap.moves.length === 2, null, { timeout: 5000 });
  ok('moves still arrive', true);
  await page.close();

  await br.close(); srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
