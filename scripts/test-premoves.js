// Premove behaviour tests, modelled on how chess.com handles premoves.
// Drives the real page in a headless browser: a computer game whose engine is switched off, so the test plays the
// opponent's moves itself and every scenario is deterministic.
// Run: node scripts/test-premoves.js          (needs Playwright: npm i -g playwright, or NODE_PATH pointing at it)
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 3990 + Math.floor(Math.random() * 9);
let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const br = await chromium.launch();
  const page = await br.newPage();
  page.on('pageerror', (e) => { if (!/outerHTML/.test(e.message)) { failed++; console.log('  ✗ page error:', e.message); } });
  await page.route(/cdn\.jsdelivr\.net/, (r) => r.abort());          // piece images: the text fallback is enough here
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForTimeout(500);

  // in-page helpers: T.setup(['e2e4', …], me) starts a game and plays those moves to reach a position (games always
  // start from the initial position), T.opp('e2e4') plays the opponent, T.pre('e7e5') clicks a premove.
  // T.get().moves lists only the moves made after the setup.
  await page.evaluate(() => {
    const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8, nm = (i) => 'abcdefgh'[i & 7] + (8 - (i >> 3));
    window.botThink = () => {};                                       // the opponent only moves when the test says so
    window.T = {
      setup(line = [], me = 'b') {
        user = { name: 'Tester' };
        const b = makeBot(Object.keys(BOT_LEVELS)[0], me, null);
        for (const u of line) applyBotMove(b, Chess.findUci(b.state, u), false);
        T.n0 = line.length;
        enterBot(b);
      },
      opp(uci) { const b = botGame, m = Chess.findUci(b.state, uci); if (!m) throw new Error('bad opponent move ' + uci); applyBotMove(b, m, true); pushBot(); },
      pre(uci) { clickSquare(sq(uci.slice(0, 2))); clickSquare(sq(uci.slice(2, 4))); return premoves.length; },
      targets(from) { clickSquare(sq(from)); const t = legal.filter((m) => m.from === sq(from)).map((m) => nm(m.to) + (m.re ? '*' : '')).sort(); clickSquare(sq(from)); return t; },
      get() { return { moves: snap.moves.slice(T.n0).join(' '), q: premoves.map((m) => nm(m.from) + nm(m.to)), turn: snap.state.turn, sel: selected === null ? null : nm(selected), over: snap.status.over } },
      board(s) { return premoveTurn() ? premoveBoard()[sq(s)] : snap.state.board[sq(s)]; },
      sq, nm,
    };
  });
  const T = (fn, ...a) => page.evaluate(([fn, a]) => T[fn](...a), [fn, a]);
  const tick = () => page.waitForTimeout(20);                         // let the queued premove run
  const opp = async (u) => { await T('opp', u); await tick(); };
  const START_W = [];                                                  // the initial position: White to move, I am Black

  console.log('\nQueue and execution');
  await T('setup', START_W);
  await T('pre', 'e7e5');
  ok('a premove is queued on the opponent\'s turn', (await T('get')).q.join() === 'e7e5', await T('get'));
  ok('the queued move is shown on the board', (await T('board', 'e5')) === 'bP' && !(await T('board', 'e7')), await T('board', 'e5'));
  await opp('e2e4');
  ok('it is played the moment the opponent moves', (await T('get')).moves === 'e4 e5', await T('get'));

  await T('setup', START_W);
  await T('pre', 'e7e5'); await T('pre', 'g8f6'); await T('pre', 'f8c5');   // Bc5 goes through e7, freed by the first premove
  ok('several premoves queue up, each planned from the one before', (await T('get')).q.join() === 'e7e5,g8f6,f8c5', await T('get'));
  await opp('e2e4');
  ok('only one premove is played per turn', (await T('get')).moves === 'e4 e5' && (await T('get')).q.length === 2, await T('get'));
  await opp('g1f3'); await opp('b1c3');
  ok('the rest follow, one per opponent move', (await T('get')).moves === 'e4 e5 Nf3 Nf6 Nc3 Bc5' && !(await T('get')).q.length, await T('get'));

  await T('setup', START_W);
  for (const u of ['a7a6', 'a6a5', 'a5a4', 'h7h6', 'h6h5', 'h5h4', 'b7b6', 'b6b5', 'g7g6', 'g6g5']) await T('pre', u);
  const n11 = await T('pre', 'c7c6');
  ok('the queue holds at most 10 premoves', n11 === 10, n11);

  console.log('\nCancelling (chess.com: an illegal premove cancels the whole queue)');
  await T('setup', ['g1f3', 'g8f6', 'h2h3', 'f6g8']);
  await T('pre', 'e7e5'); await T('pre', 'b8c6');
  await opp('f3e5');
  ok('a premove that became illegal is not played, and the queue is cleared', (await T('get')).moves === 'Ne5' && !(await T('get')).q.length && (await T('get')).turn === 'b', await T('get'));

  await T('setup', START_W);
  await T('pre', 'e7e5'); await T('pre', 'e5e4');
  await opp('e2e4');
  await opp('d2d3');
  ok('a later premove blocked by the opponent is cancelled, the earlier one stood', (await T('get')).moves === 'e4 e5 d3' && !(await T('get')).q.length, await T('get'));

  await T('setup', ['e2e4', 'd7d5']);
  await T('pre', 'd5d4'); await T('pre', 'g8f6');
  await opp('e4d5');
  ok('a premoved piece that gets captured cancels the queue', (await T('get')).moves === 'exd5' && !(await T('get')).q.length, await T('get'));

  await T('setup', ['e2e4', 'e7e5', 'b1c3', 'f8b4']);
  await T('pre', 'b4c3');
  await opp('a2a3');
  ok('premoves are played normally when still legal (Bxc3)', (await T('get')).moves === 'a3 Bxc3', await T('get'));

  await T('setup', ['e2e4', 'e7e5', 'b1c3', 'f8b4']);
  await T('pre', 'c7c6');
  await opp('d1h5');                                                   // no check, c6 still fine
  await T('pre', 'a7a6');
  await opp('h5f7');                                                   // Qxf7+: my king is in check, a6 does not answer it
  ok('a premove that does not get out of check is cancelled', (await T('get')).moves === 'Qh5 c6 Qxf7+' && !(await T('get')).q.length && (await T('get')).turn === 'b', await T('get'));

  await T('setup', ['e2e4', 'e7e5']);
  await T('pre', 'd7d6');
  await opp('f1b5');                                                   // Bb5 pins the d7 pawn: d6 would expose the king
  ok('a premove with a piece that became pinned is cancelled', (await T('get')).moves === 'Bb5' && !(await T('get')).q.length && (await T('get')).turn === 'b', await T('get'));

  await T('setup', START_W);
  await T('pre', 'e7e5'); await T('pre', 'g8f6');
  const box = await page.locator('#board').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  ok('right-click on the board cancels all premoves', !(await T('get')).q.length && !(await T('board', 'e5')), await T('get'));
  await T('pre', 'e7e5');
  await page.keyboard.press('Escape');
  ok('Escape cancels premoves', !(await T('get')).q.length, await T('get'));
  await T('pre', 'e7e5');
  await page.evaluate(() => clickSquare(T.sq('d4')));
  ok('clicking an empty square with nothing picked up cancels premoves', !(await T('get')).q.length, await T('get'));
  await T('pre', 'e7e5');
  await page.evaluate(() => { clickSquare(T.sq('g8')); clickSquare(T.sq('d4')); });
  ok('…but with a piece picked up, the first click only drops that piece', (await T('get')).q.join() === 'e7e5' && (await T('get')).sel === null, await T('get'));

  console.log('\nWhich squares a premove may go to');
  await T('setup', START_W);
  ok('pawn: one or two forward and both diagonals', JSON.stringify(await T('targets', 'e7')) === '["d6","e5","e6","f6"]', await T('targets', 'e7'));
  ok('knight: its jumps, not onto own pieces', JSON.stringify(await T('targets', 'g8')) === '["f6","h6"]', await T('targets', 'g8'));
  ok('blocked bishop/queen/rook: own pieces block', !(await T('targets', 'f8')).length && !(await T('targets', 'd8')).length && !(await T('targets', 'a8')).length, [await T('targets', 'f8'), await T('targets', 'd8')]);
  await page.evaluate(() => { clickSquare(T.sq('d8')); clickSquare(T.sq('c7')); });
  ok('clicking another own piece switches selection instead of queueing', (await T('get')).sel === 'c7' && !(await T('get')).q.length, await T('get'));
  await page.evaluate(() => clickSquare(T.sq('c7')));

  await T('setup', ['c2c4', 'e7e6', 'g1f3', 'd7d5']);
  const rec = await T('targets', 'e6');
  ok('a recapture onto my own attacked piece is offered (e6 takes back on d5)', rec.includes('d5*'), rec);
  ok('pawns never "recapture" straight ahead', !rec.includes('e5*'), rec);
  const qT = await T('targets', 'd8');
  ok('a slider passes through enemy pieces but stops at its own (Qd8 → d6, d7, not past d5)', qT.includes('d6') && qT.includes('d7') && qT.includes('d5*') && !qT.includes('d4'), qT);
  // recapture by drag (click on an own piece selects it instead)
  const B = await page.locator('#board').boundingBox(), s = B.width / 8;
  const at = (i) => { const j = 63 - i; return [B.x + ((j & 7) + 0.5) * s, B.y + ((j >> 3) + 0.5) * s]; };   // Black's view is flipped
  const drag = async (a, b) => { const [x1, y1] = at(await page.evaluate((q) => T.sq(q), a)), [x2, y2] = at(await page.evaluate((q) => T.sq(q), b)); await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move(x1 + 8, y1 + 8, { steps: 3 }); await page.mouse.move(x2, y2, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(120); };
  await drag('e6', 'd5');
  ok('dragging onto the attacked piece queues the recapture', (await T('get')).q.join() === 'e6d5', await T('get'));
  await opp('c4d5');
  ok('the recapture is played after they take (cxd5 exd5)', (await T('get')).moves === 'cxd5 exd5', await T('get'));
  await drag('g8', 'f6'); await drag('f8', 'd6');
  ok('premoves can also be dragged, in sequence', (await T('get')).q.join() === 'g8f6,f8d6', await T('get'));

  console.log('\nSpecial moves');
  await T('setup', ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'b1c3', 'g8f6', 'd2d3', 'd7d6', 'c1e3', 'c8e6', 'd1d2', 'd8d7', 'f1e2', 'f8e7']);
  ok('castling can be premoved both ways', (await T('targets', 'e8')).includes('g8') && (await T('targets', 'e8')).includes('c8'), await T('targets', 'e8'));
  await T('pre', 'e8g8');
  ok('the premove board shows the rook moved too', (await T('board', 'f8')) === 'bR' && (await T('board', 'g8')) === 'bK', [await T('board', 'f8'), await T('board', 'g8')]);
  await opp('a2a3');
  ok('the castling premove is played', (await T('get')).moves === 'a3 O-O', await T('get'));

  await T('setup', ['e2e4', 'e7e5', 'g1f3', 'g8f6', 'b1c3', 'f8c5']);
  ok('castling is not offered through my own pieces', !(await T('targets', 'e8')).includes('c8'), await T('targets', 'e8'));
  await T('pre', 'e8g8');
  await opp('f1c4');
  ok('castling stays legal here (Bc4 does not cover f8/g8) and is played', (await T('get')).moves === 'Bc4 O-O', await T('get'));
  await T('setup', ['e2e4', 'e7e5', 'g1f3', 'g8f6', 'b2b3', 'g7g6', 'h2h3', 'f8g7']);
  await T('pre', 'e8g8');
  await opp('c1a3');                                                   // Ba3 hits f8: castling through check is illegal
  ok('castling through an attacked square is cancelled', (await T('get')).moves === 'Ba3' && !(await T('get')).q.length, await T('get'));

  await T('setup', ['g1f3', 'd7d5', 'f3g1', 'd5d4']);
  await T('pre', 'd4e3');
  await opp('e2e4');
  ok('en passant can be premoved (dxe3 e.p.)', (await T('get')).moves === 'e4 dxe3', await T('get'));

  await T('setup', ['a2a3', 'h7h5', 'a3a4', 'h5h4', 'b2b3', 'h4h3', 'b3b4', 'h3g2']);
  await T('pre', 'g2h1');
  await opp('c2c3');
  ok('a promotion premove promotes to a queen (gxh1=Q)', /h1=Q/.test((await T('get')).moves), await T('get'));

  console.log('\nGame end and other states');
  await T('setup', ['e2e4', 'f7f6', 'd2d3', 'g7g5']);
  await T('pre', 'a7a6');
  await opp('d1h5');                                                   // checkmate
  ok('premoves are dropped when the game ends', (await T('get')).over && !(await T('get')).q.length && (await T('get')).moves === 'Qh5#', await T('get'));

  await T('setup', [], 'w');
  await T('pre', 'e2e4');
  ok('on my own turn a click-click is a normal move, not a premove', (await T('get')).moves === 'e4' && !(await T('get')).q.length, await T('get'));
  const t2 = await page.evaluate(() => { clickSquare(T.sq('d2')); const r = legal.filter((m) => m.from === T.sq('d2')).length; clickSquare(T.sq('d2')); return r; });
  ok('…and on the opponent\'s turn the same pawn shows premove targets', t2 === 4, t2);

  console.log('\nOnline speed (two players, slow server replies)');
  // Black's move confirmations come back 400ms late (a slow connection). A queued premove must still go out as soon
  // as White's move arrives, not wait for the confirmation of Black's previous move.
  const mk = async () => { const c = await br.newContext(); const p = await c.newPage(); await p.route(/cdn\.jsdelivr\.net/, (r) => r.abort()); await p.goto(`http://localhost:${PORT}/`); await p.waitForTimeout(400); return p; };
  const A = await mk(), W = await mk(), tag = Date.now() % 1e6;
  for (const [p, nm] of [[A, 'pa' + tag], [W, 'pw' + tag]]) await p.evaluate(async (nm) => finishAuth(await api('signup', { email: nm + '@x.io', password: 'password1', username: nm })), nm);
  const code = await A.evaluate(async () => { const r = await api('create', { color: 'b' }); enterGame(r.code, r.snap); return r.code; });
  await W.evaluate(async (code) => { const r = await api('join', { code }); enterGame(r.code, r.snap); }, code);
  await A.waitForTimeout(1200);
  await A.route(/r=move/, async (r) => { const res = await r.fetch(); await new Promise((ok) => setTimeout(ok, 400)); r.fulfill({ response: res }); });
  await A.evaluate(() => { for (const [a, b] of [[12, 28], [1, 18], [5, 26], [6, 21]]) { clickSquare(a); clickSquare(b); } });   // e5 Nc6 Bc5 Nf6
  const waits = [];
  for (const [i, [f, t]] of [[52, 36], [62, 45], [61, 34], [60, 62]].entries()) {                                   // e4 Nf3 Bc4 O-O
    const t0 = Date.now();
    await W.evaluate(([f, t]) => send(f, t), [f, t]);
    await W.waitForFunction((k) => snap.moves.length >= k, 2 * i + 2, { polling: 5, timeout: 5000 });
    waits.push(Date.now() - t0);
  }
  ok('all four premoves are played online', (await W.evaluate(() => snap.moves.join(' '))) === 'e4 e5 Nf3 Nc6 Bc4 Bc5 O-O Nf6', await W.evaluate(() => snap.moves.join(' ')));
  ok(`premove replies do not wait for the previous move's confirmation (ms: ${waits.join(', ')})`, waits.slice(1).every((ms) => ms < 300), waits);

  await br.close(); srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
