// Drag & drop tests: a move is made only when the dragging finger or mouse button is released, on that square.
// Drives the real page in a headless browser with synthetic pointer events, in a computer game whose engine is off.
// Run: node scripts/test-drag.js          (needs Playwright: npm i -g playwright, or NODE_PATH pointing at it)
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 4010 + Math.floor(Math.random() * 9);
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
  await page.waitForTimeout(500);

  // T.setup(me) starts a game with the engine off; T.ev(type, square, opts) fires a pointer event at a square's centre.
  await page.evaluate(() => {
    const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
    window.botThink = () => {};
    window.T = {
      setup(me = 'w') { user = { name: 'Tester' }; enterBot(makeBot(Object.keys(BOT_LEVELS)[0], me, null)); },
      ev(type, s, o = {}) {
        const r = sqEls[sq(s)].getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...o };
        (type === 'pointerdown' ? document.elementFromPoint(x, y) : window).dispatchEvent(new PointerEvent(type, init));
      },
      drag(from, to, o) { T.ev('pointerdown', from, o); T.ev('pointermove', from, { ...o, clientX: undefined }); T.ev('pointermove', to, o); },
      get() { return { moves: snap.moves.join(' '), sel: selected, ghosts: document.querySelectorAll('.dragghost').length, dragging: !!drag }; },
    };
  });
  const T = (fn, ...a) => page.evaluate(([fn, a]) => T[fn](...a), [fn, a]);

  console.log('\nNormal drag');
  await T('setup');
  await T('drag', 'e2', 'e4'); await T('ev', 'pointerup', 'e4');
  ok('dragging e2 to e4 and letting go plays e4', (await T('get')).moves === 'e4', await T('get'));

  console.log('\nA release that never reached the page (mouse let go outside the window)');
  await T('setup');
  await T('drag', 'e2', 'e3');
  await T('ev', 'pointermove', 'e4', { buttons: 0 });               // the mouse comes back with no button held
  let g = await T('get');
  ok('the drag is dropped once the mouse moves with no button held', !g.dragging && g.ghosts === 0, g);
  await T('ev', 'pointerdown', 'e5'); await T('ev', 'pointerup', 'e4');
  ok('a later click elsewhere does not play the stale drag', (await T('get')).moves === '', await T('get'));

  console.log('\nTwo fingers');
  await T('setup');
  const t1 = { pointerType: 'touch', pointerId: 11 }, t2 = { pointerType: 'touch', pointerId: 12, isPrimary: false };
  await T('drag', 'e2', 'e4', t1);
  await T('ev', 'pointerdown', 'h6', t2); await T('ev', 'pointerup', 'e4', t2);   // another finger taps and lifts
  g = await T('get');
  ok('lifting a second finger does not drop the piece', g.moves === '' && g.dragging, g);
  await T('ev', 'pointermove', 'd4', t2);
  await T('ev', 'pointerup', 'e4', t1);
  ok('lifting the dragging finger plays the move', (await T('get')).moves === 'e4', await T('get'));

  console.log('\nThe position changes mid-drag');
  await T('setup');
  await T('drag', 'e2', 'e4');
  await page.evaluate(() => { selected = null; legal = []; });       // what a server update does to the selection
  await T('ev', 'pointerup', 'e4');
  ok('the drop still plays the move', (await T('get')).moves === 'e4', await T('get'));

  console.log('\nClick-click still works');
  await T('setup');
  await page.evaluate(() => { clickSquare(52); });
  await page.evaluate(() => { clickSquare(36); });
  ok('clicking e2 then e4 plays e4', (await T('get')).moves === 'e4', await T('get'));

  console.log('\nIllegal moves shake');
  const shook = () => page.evaluate(() => ({ shake: [...document.querySelectorAll('#board .shake')].map((e) => +e.closest('.sq').dataset.sq).sort(), flash: [...document.querySelectorAll('#board .kflash')].map((e) => +e.closest('.sq').dataset.sq) }));
  await T('setup');
  await T('drag', 'e2', 'e5'); await T('ev', 'pointerup', 'e5');
  let s = await shook();
  ok('a pawn dropped three squares up shakes, and the king does not', (await T('get')).moves === '' && s.shake.join() === '52' && !s.flash.length, s);
  await page.waitForTimeout(800);
  s = await shook();
  ok('the shake clears itself', !s.shake.length && !s.flash.length, s);
  await T('drag', 'e2', 'd2'); await T('ev', 'pointerup', 'd2');
  ok('dropping on my own piece just puts it back', !(await shook()).shake.length, await shook());
  // Black is in check from Qh5 after 1.e4 f6 2.Qh5+
  await page.evaluate(() => { user = { name: 'Tester' }; const b = makeBot(Object.keys(BOT_LEVELS)[0], 'b', null); for (const u of ['e2e4', 'f7f6', 'd1h5']) applyBotMove(b, Chess.findUci(b.state, u), false); enterBot(b); });
  await T('drag', 'a7', 'a6'); await T('ev', 'pointerup', 'a6');
  s = await shook();
  ok('a move that ignores check shakes the piece and the king, and flashes the king red', s.shake.join() === '4,8' && s.flash.join() === '4', s);
  await page.waitForTimeout(800);
  await page.evaluate(() => { clickSquare(8); clickSquare(16); });   // the same move, click-click
  s = await shook();
  ok('click-click of a move the king forbids flashes too', s.flash.join() === '4', s);
  await page.waitForTimeout(800);
  await page.evaluate(() => { clickSquare(8); clickSquare(35); });   // a7 to d4 isn't a move at all: just a click away
  ok('a plain click away does not shake', !(await shook()).shake.length, await shook());

  // castling through an attacked square: after 1.e4 b6 2.g3 Ba6 3.Bg2 e6 4.Nf3 Nc6 the a6 bishop hits f1
  await page.evaluate(() => { user = { name: 'Tester' }; const b = makeBot(Object.keys(BOT_LEVELS)[0], 'w', null); for (const u of ['e2e4', 'b7b6', 'g2g3', 'c8a6', 'f1g2', 'e7e6', 'g1f3', 'b8c6']) applyBotMove(b, Chess.findUci(b.state, u), false); enterBot(b); });
  await page.evaluate(() => { clickSquare(60); clickSquare(62); });   // e1 to g1
  s = await shook();
  ok('castling through an attacked square flashes the king', s.flash.join() === '60', s);
  await page.waitForTimeout(800);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { clickSquare(60); clickSquare(62); clickSquare(60); clickSquare(62); });
  await page.waitForTimeout(900);
  s = await shook();
  ok('with reduced motion the markers still clear and do not pile up', !s.shake.length && !s.flash.length, s);

  console.log(`\n${passed} passed, ${failed} failed`);
  await br.close(); srv.kill();
  process.exit(failed ? 1 : 0);
})();
