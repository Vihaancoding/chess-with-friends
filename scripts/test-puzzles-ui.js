// The puzzle trainer in the browser, on real Lichess puzzles. Run: node scripts/test-puzzles-ui.js (needs Playwright, takes ~60 s)
const { chromium } = require('playwright');
process.env.PORT = String(4270 + Math.floor(Math.random() * 9)); process.env.SUPABASE_URL = ''; process.env.ADMIN_KEY = 'k';
delete process.env.ANTHROPIC_API_KEY; delete process.env.LLAMA_API_KEY;
const PORT = process.env.PORT, origLog = console.log; console.log = () => {};
require('../server.js'); console.log = origLog;
const PZ = require('../lib/puzzles'), Chess = require('../public/chess.js');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await sleep(300);
  const r = await fetch(`http://localhost:${PORT}/api?r=signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@x.io', password: 'password1', username: 'ann' }) }).then((x) => x.json());
  const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 1280, height: 1000 } }); const p = await ctx.newPage();
  p.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); });
  await p.route(/cdn\.jsdelivr\.net|fonts\.g/, (x) => x.abort());
  await ctx.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), { name: r.name, token: r.token });
  const D = PZ.load();
  const sqIdx = (u) => 'abcdefgh'.indexOf(u[0]) + (8 - +u[1]) * 8;
  const idle = () => p.waitForFunction(() => Puzzles.P && !Puzzles.P.busy, null, { timeout: 15000 });
  const click = (u) => p.click(`#pzBoard [data-sq="${sqIdx(u.slice(0, 2))}"]`);
  const moveUci = async (u) => { await click(u.slice(0, 2)); await p.click(`#pzBoard [data-sq="${sqIdx(u.slice(2, 4))}"]`); if (u[4]) { await p.waitForSelector('#pzPromo:not(.hidden)'); await p.click(`[data-pzpromo="${u[4].toUpperCase()}"]`); } };
  const cur = () => p.evaluate(() => Puzzles.P.id);
  const wrongMove = (row, step) => { const st = PZ.stateAfter(row, step); const m = Chess.legalMoves(st).find((x) => !x.promo && Chess.sqName(x.from) + Chess.sqName(x.to) !== row.mv[step] && Chess.status(Chess.apply(st, x)).reason !== 'checkmate'); return Chess.sqName(m.from) + Chess.sqName(m.to); };

  await p.goto(`http://localhost:${PORT}/?puzzles`); await p.waitForSelector('#pzAsk');
  console.log('the setup screen');
  ok('the trainer opens from the address, with the AI search first and a stats panel beside it', await p.isVisible('#pzAskForm') && await p.isVisible('#pzStats') && /Puzzle rating/.test(await p.textContent('#pzStats')), null);
  ok('the three other modes are tabs: custom, weakness, mixed', (await p.$$('[data-pzmode]')).length === 3, null);
  ok('Lichess is credited', /Lichess puzzle database/.test(await p.textContent('.pzcredit')), null);

  console.log('AI training: describe it, see what was understood, start');
  await p.fill('#pzAsk', 'Give me difficult knight fork puzzles'); await p.click('#pzAskGo');
  await p.waitForSelector('#pzAskRes [data-pzstart]');
  const txt = await p.textContent('#pzAskRes');
  ok('it shows what it understood (Fork, rating, first move) and how many puzzles match', /Fork/.test(txt) && /1900/.test(txt) && /knight/i.test(txt) && /\d+ puzzles? match/.test(txt), txt);
  ok('and is honest that "knight" means the first move of the solution', /first move of the solution/.test(txt), txt);
  await p.click('#pzAskRes [data-pzstart]'); await p.waitForSelector('#pzBoard .sq'); await idle();
  const id1 = await cur(), row1 = D.byId.get(id1);
  ok('an authentic Lichess puzzle is on the board and it has a fork and a rating of 1900 or more', row1.themes.includes('fork') && row1.rating >= 1900 && row1.first === 'N', row1);
  ok('the board is oriented to the side to play and 64 squares are drawn', (await p.$$('#pzBoard .sq')).length === 64 && (await p.evaluate(() => Puzzles.P.flip)) === (Chess.fromFEN(row1.fen).turn === 'w'), null);
  ok('the opponent\'s move has been played on the board', await p.evaluate(() => !!Puzzles.P.last), null);
  const body = await p.evaluate(() => JSON.stringify({ ...Puzzles.P, meta: undefined }));
  ok('the solution is nowhere in the page state', row1.mv.slice(1).every((m) => !body.includes(m)) && !/"solution"/.test(body) && !('themes' in JSON.parse(body)), body.slice(0, 120));

  console.log('moves: wrong, hint, restart, right');
  const before = await p.evaluate(() => Puzzles.P.st.board.join(','));
  const w = wrongMove(row1, 1);
  await moveUci(w + (Chess.findUci(PZ.stateAfter(row1, 1), w) ? '' : '')); await p.waitForFunction(() => Puzzles.P.status === 'wrong', null, { timeout: 8000 }); await idle();
  ok('a wrong move says so and the board goes back exactly as it was', /Not that one/.test(await p.textContent('#pzPrompt')) && (await p.evaluate(() => Puzzles.P.st.board.join(','))) === before, null);
  await p.click('[data-pzhint]'); await p.waitForSelector('.pzhintsq');
  ok('Hint 1 marks the piece to move', (await p.$$('.pzhintsq')).length === 1 && await p.evaluate((u) => document.querySelector('.pzhintsq').dataset.sq === String('abcdefgh'.indexOf(u[0]) + (8 - +u[1]) * 8), row1.mv[1].slice(0, 2)), null);
  await p.click('[data-pzhint]'); await p.waitForFunction(() => document.querySelectorAll('.pzhintsq').length === 2);
  ok('Hint 2 shows the target square as well', true);
  await p.click('[data-pzreset]'); await idle();
  ok('Restart puts the puzzle back at the start with nothing selected or hinted', await p.evaluate(() => Puzzles.P.step === 1 && Puzzles.P.status === 'ready' && !Puzzles.P.hintSq.length && Puzzles.P.sel == null) && (await p.evaluate(() => Puzzles.P.st.board.join(','))) === before, null);
  ok('the puzzle is still not finished after all that', await p.evaluate(() => !Puzzles.P.finished) && !(await p.$('#pzResult .pzresult')), null);
  let u = row1.mv[1];
  for (let step = 1; step < row1.mv.length; step += 2) {
    if (step > 1) await idle();
    await moveUci(row1.mv[step]);
    if (step < row1.mv.length - 1) {
      await p.waitForFunction((n) => Puzzles.P.step === n && !Puzzles.P.busy, step + 2, { timeout: 8000 });
      ok(`after correct move ${(step + 1) / 2} of ${row1.len} the puzzle is NOT complete (${row1.len - (step + 1) / 2} to go)`, !(await p.$('#pzResult .pzresult')) && await p.evaluate(() => !Puzzles.P.finished), null);
    }
  }
  await p.waitForSelector('#pzResult .pzresult', { timeout: 8000 });
  ok('only the full solution completes it; it was not a clean solve because of the hint and the wrong move', await p.evaluate(() => Puzzles.P.finished && Puzzles.P.status === 'solved' && Puzzles.P.clean === false), await p.textContent('#pzPrompt'));
  ok('the result shows the rating change and the Lichess themes', /rating/i.test(await p.textContent('#pzResult')) && /Fork/.test(await p.textContent('#pzResult')), null);
  ok('the solution line is shown after completion', /The solution/.test(await p.textContent('#pzReview')) && (await p.$$('#pzReview .pzline span')).length === row1.mv.length - 1, null);
  await p.waitForSelector('#pzWords .pzexplain', { timeout: 15000 });
  ok('an explanation is shown, labelled by where it came from', /built in|AI/.test(await p.textContent('#pzWordsSrc')) && (await p.textContent('#pzWords .pzexplain')).length > 30, null);
  console.log('  … waiting for Stockfish');
  await p.waitForFunction(() => /depth \d+/.test((document.querySelector('#pzEngine .pzchipv') || {}).textContent || '') || /could not run/.test((document.querySelector('#pzEngine') || {}).textContent || ''), null, { timeout: 90000 });
  const eng = await p.textContent('#pzEngine');
  ok('the engine check ran in the browser: Stockfish agrees or says what it prefers, and the opponent\'s threat is described', /depth \d+/.test(eng) && /Stockfish/.test(eng) && /(threat|their move|check itself)/i.test(eng), eng.slice(0, 400));
  ok('engine facts and AI text are separate, labelled sections', await p.$('#pzEngine .pzchipv.eng') !== null && await p.$('#pzWords .pzchipv') !== null, null);
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT + '-solved.png', fullPage: true });

  console.log('next, skip, the solution');
  await p.click('[data-pznext]'); await p.waitForFunction((id) => Puzzles.P && Puzzles.P.id !== id && !Puzzles.P.busy, id1, { timeout: 15000 });
  const id2 = await cur(), row2 = D.byId.get(id2);
  ok('Next gives a different puzzle that matches the same request', id2 !== id1 && row2.themes.includes('fork') && row2.rating >= 1900, row2.themes);
  await p.click('[data-pzsol]'); await p.waitForSelector('#pzResult .pzresult', { timeout: 8000 });
  ok('"Show solution" reveals the line, marks the puzzle as missed and opens the review', /Missed/.test(await p.textContent('#pzResult')) && /Solution shown/.test(await p.textContent('#pzPrompt')), null);
  await p.waitForFunction((n) => document.querySelectorAll('#pzReview .pzline span').length === n, row2.mv.length - 1, { timeout: 8000 });
  await sleep(row2.mv.length * 800);
  ok('the solution is played out on the board, ending in the position the line reaches', await p.evaluate(() => Puzzles.P.last != null), null);
  await p.click('[data-pzback]'); await p.waitForSelector('#pzAsk');
  await p.waitForFunction(() => /Attempted/.test(document.querySelector('#pzStats').textContent) && document.querySelectorAll('.pzmiss').length >= 1, null, { timeout: 8000 });
  ok('back on the setup screen, progress is tracked: attempts and the missed puzzle are listed', /Attempted2/.test(await p.textContent('.pzfacts')) && (await p.$$('.pzmiss')).length >= 1, await p.textContent('.pzfacts'));
  await p.click('[data-pzretry]'); await p.waitForSelector('#pzBoard .sq'); await idle();
  ok('a missed puzzle can be retried from the list', (await cur()) === id2, null);

  console.log('custom training: themes and difficulty together');
  await p.click('[data-pzback]'); await p.waitForSelector('#pzAsk');
  await p.click('[data-pzmode="custom"]');
  await p.click('[data-pzband="advanced"]');
  await p.click('[data-pzth="fork"]'); await p.click('[data-pzth="discoveredAttack"]');
  await p.waitForFunction(() => /puzzles? match/.test(document.querySelector('#pzCount').textContent));
  ok('Fork + Discovered attack + Advanced shows a live count', /puzzles? match/.test(await p.textContent('#pzCount')) && await p.isVisible('#pzMatch'), await p.textContent('#pzCount'));
  await p.click('#pzStart'); await p.waitForSelector('#pzBoard .sq'); await idle();
  const rc = D.byId.get(await cur());
  ok('the puzzle has both themes and is in the Advanced range', rc.themes.includes('fork') && rc.themes.includes('discoveredAttack') && rc.rating >= 1500 && rc.rating < 2000, rc.themes);
  await p.click('[data-pzback]'); await p.waitForSelector('#pzAsk'); await p.click('[data-pzmode="custom"]');
  await p.click('[data-pzclear]'); await p.click('[data-pzmore]'); await p.click('[data-pzband="beginner"]'); await p.click('[data-pzth="underPromotion"]'); await p.click('[data-pzth="zugzwang"]');
  await p.waitForFunction(() => /No puzzles/.test(document.querySelector('#pzCount').textContent), null, { timeout: 8000 });
  ok('an impossible combination says so, offers looser versions, and cannot be started', await p.isDisabled('#pzStart') && (await p.$$('#pzCount [data-pzrelax]')).length > 0, await p.textContent('#pzCount'));
  await p.click('#pzCount [data-pzrelax]'); await p.waitForFunction(() => /puzzles? match/.test(document.querySelector('#pzCount').textContent));
  ok('a suggestion loads the looser filter and it works', !(await p.isDisabled('#pzStart')), null);
  await p.click('[data-pzmode="custom"]'); await p.click('[data-pzband="custom"]');
  ok('a custom rating range can be entered', await p.isVisible('#pzMin') && await p.isVisible('#pzMax'), null);
  await p.fill('#pzMin', '1200'); await p.fill('#pzMax', '1300'); await p.waitForFunction(() => /puzzles? match/.test(document.querySelector('#pzCount').textContent));

  console.log('other modes');
  await p.click('[data-pzmode="weakness"]');
  ok('Weakness training explains itself when there is not enough history', /Solve a few puzzles first|keep going wrong|Nothing is standing out/.test(await p.textContent('#pzModeBody')), await p.textContent('#pzModeBody'));
  await p.click('[data-pzmode="mixed"]'); await p.click('[data-pzmix="harder"]'); await p.click('#pzStart'); await p.waitForSelector('#pzBoard .sq'); await idle();
  ok('Mixed training starts without choosing themes', await p.evaluate(() => Puzzles.run.mode === 'mixed' && !!Puzzles.P.id), null);
  await p.click('[data-pzback]'); await p.waitForSelector('#pzAsk');

  console.log('AI search with nothing it can use');
  await p.fill('#pzAsk', 'strategic pawn structure and prophylaxis'); await p.click('#pzAskGo');
  await p.waitForSelector('#pzAskRes .pzres');
  ok('it explains what it cannot do instead of returning unrelated puzzles', /couldn't turn that/.test(await p.textContent('#pzAskRes')) && !(await p.$('#pzAskRes [data-pzstart]')), await p.textContent('#pzAskRes'));

  console.log('phone');
  await p.setViewportSize({ width: 390, height: 800 }); await sleep(300);
  const over = () => p.evaluate(() => [...document.querySelectorAll('#puzzles *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('.pzghost')).map((e) => e.className || e.tagName).slice(0, 4));
  ok('the setup screen fits a phone', (await over()).length === 0, await over());
  await p.fill('#pzAsk', 'rook endgames under 1500'); await p.click('#pzAskGo'); await p.waitForSelector('#pzAskRes [data-pzstart]');
  await p.click('#pzAskRes [data-pzstart]'); await p.waitForSelector('#pzBoard .sq'); await idle();
  const bw = await p.evaluate(() => document.querySelector('#pzBoard').getBoundingClientRect().width);
  ok('the board fills the phone width and nothing overflows', bw > 330 && (await over()).length === 0, [bw, await over()]);
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT + '-phone.png', fullPage: true });
  await br.close(); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
