// The analysis engine setting: Stockfish (public/sfengine.js) answers the review, badges, evaluation bar and coach
// the same way our engine does. Run: node scripts/test-stockfish-ui.js   (needs Playwright, like the other UI tests)
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 4050 + Math.floor(Math.random() * 9);
let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const br = await chromium.launch();
  const page = await br.newPage();
  page.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); });
  await page.route(/cdn\.jsdelivr\.net/, (r) => r.abort());
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForTimeout(400);
  const analyze = (moves, extra = {}) => page.evaluate(([mv, ex]) => new Promise((res) => {
    let st = Chess.initial(); const states = [st], hist = [];
    for (const u of mv) { const m = Chess.findUci(st, u); hist.push(m); st = Chess.apply(st, m); states.push(st); }
    const w = new StockfishWorker(), out = [];
    w.onmessage = (e) => { if (e.data.done) res(out); else out.push(e.data); };
    w.onerror = (e) => res({ err: e.message });
    w.postMessage({ type: 'analyze', id: 1, states, hist, ms: 120, ...ex });
  }), [moves, extra]);
  const nm = (m) => m && 'abcdefgh'[m.from & 7] + (8 - (m.from >> 3)) + 'abcdefgh'[m.to & 7] + (8 - (m.to >> 3));

  console.log('\nThe Stockfish adapter');
  let r = await analyze(['e2e4', 'e7e5', 'g1f3', 'f7f6', 'f3e5', 'f6e5', 'd1h5', 'g7g6']);
  ok('it answers every position of a game, in order', r.length === 9 && r.every((d, i) => d.i === i && d.n === 8), r.map((d) => d.i));
  ok('it finds the winning Qh5+', nm(r[6].best) === 'd1h5' && r[6].bestScore > 200, r[6]);
  ok('the played move gets a score, worse than the best when it was a mistake', r[3].played < r[3].bestScore - 50, r[3]);
  ok('second-best scores come along', r.slice(0, 8).every((d) => typeof d.second === 'number'), r.map((d) => d.second));
  r = await analyze(['f2f3', 'e7e5', 'g2g4'], { skipFinal: false, order: [3], scores: true });
  ok('mate in one is found and scored on our scale', nm(r[0].best) === 'd8h4' && r[0].bestScore === 99999, r[0]);
  ok('the coach gets every legal move scored', r[0].scores.length === r[0].legal && r[0].legal === 30, r[0].legal);
  r = await analyze(['f2f3', 'e7e5', 'g2g4', 'd8h4'], { order: [4] });
  ok('a finished position is terminal, like ours', r[0].terminal && r[0].bestScore === -100000, r[0]);
  const fens = await page.evaluate(() => { let st = Chess.initial(); for (const u of ['e2e4', 'c7c5', 'e4e5', 'd7d5']) st = Chess.apply(st, Chess.findUci(st, u)); return Stockfish.fen(st); });
  ok('positions go over as correct FEN (castling, en passant, clocks)', fens === 'rnbqkbnr/pp2pppp/8/2ppP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3', fens);
  const again = await page.evaluate(() => new Promise((res) => {
    const a = new StockfishWorker();
    a.onmessage = () => {};
    a.postMessage({ type: 'analyze', id: 1, states: [Chess.initial()], hist: [], ms: 3000 });
    setTimeout(() => {
      a.terminate();
      const b = new StockfishWorker(), t0 = performance.now();
      b.onmessage = (e) => { if (!e.data.done) res(Math.round(performance.now() - t0)); };
      b.postMessage({ type: 'analyze', id: 1, states: [Chess.initial()], hist: [], ms: 100 });
    }, 300);
  }));
  ok('ending a search early frees the engine for the next one quickly', again < 1500, again);

  console.log('\nThe setting');
  await page.evaluate(() => openSkins());
  let btns = await page.$$eval('#engPick button', (b) => b.map((x) => x.textContent + (x.classList.contains('on') ? '*' : '')));
  ok('the picker offers both engines, ours by default', btns.join() === 'Ours*,Stockfish', btns);
  await page.click('#engPick [data-engine="stockfish"]');
  btns = await page.$$eval('#engPick button', (b) => b.map((x) => x.textContent + (x.classList.contains('on') ? '*' : '')));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('chess:skin')).engine);
  ok('picking Stockfish selects it and remembers it', btns.join() === 'Ours,Stockfish*' && saved === 'stockfish', [btns, saved]);
  await page.evaluate(() => $('#skinModal').classList.add('hidden'));

  console.log('\nIn a game against the computer');
  await page.evaluate(() => { window.botThink = () => {}; user = { name: 'Tester' }; enterBot(makeBot(Object.keys(BOT_LEVELS)[0], 'w', null)); });
  await page.waitForFunction(() => EV.worker && !$('#evalbar').classList.contains('busy') && $('#evtxt').textContent.trim(), null, { timeout: 15000 }).catch(() => {});
  let ev = await page.evaluate(() => ({ sf: EV.worker instanceof StockfishWorker, txt: $('#evtxt').textContent.trim() }));
  ok('the evaluation bar is worked out by Stockfish', ev.sf && /\d/.test(ev.txt), ev);
  await page.evaluate(() => clickSquare(52) || clickSquare(36));
  await page.waitForFunction(() => !!document.querySelector('#boardwrap .mbadge'), null, { timeout: 15000 }).catch(() => {});
  const badge = await page.evaluate(() => ({ sf: LB.worker instanceof StockfishWorker, badge: !!document.querySelector('#boardwrap .mbadge') }));
  ok('move badges come from Stockfish', badge.sf && badge.badge, badge);
  await page.evaluate(() => { openSkins(); $('#engPick [data-engine="ours"]').click(); $('#skinModal').classList.add('hidden'); });
  await page.evaluate(() => { const b = botGame, m = Chess.legalMoves(b.state)[0]; applyBotMove(b, m, true); pushBot(); });
  await page.waitForFunction(() => EV.worker && !$('#evalbar').classList.contains('busy'), null, { timeout: 15000 }).catch(() => {});
  ev = await page.evaluate(() => ({ ours: EV.worker instanceof Worker && !(EV.worker instanceof StockfishWorker), txt: $('#evtxt').textContent.trim() }));
  ok('switching back mid-game hands the evaluation bar to ours', ev.ours && /\d/.test(ev.txt), ev);

  console.log(`\n${passed} passed, ${failed} failed`);
  await br.close(); srv.kill();
  process.exit(failed ? 1 : 0);
})();
