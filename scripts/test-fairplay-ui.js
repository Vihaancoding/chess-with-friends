// Fair play in the browser: what the board watcher reports during an online game, and the admin panel's list.
// Run: node scripts/test-fairplay-ui.js          (needs Playwright: npm i -g playwright, or NODE_PATH pointing at it)
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 4030 + Math.floor(Math.random() * 9);
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

  // A game on the board that the watcher treats as online: a computer game under another code, with reports caught.
  await page.evaluate(() => {
    window.botThink = () => {};
    window.sent = [];
    const real = api;
    api = (route, body) => (route === 'fair_report' ? (sent.push(body.what), Promise.resolve({ ok: true })) : real(route, body));
    user = { name: 'Tester' };
    enterBot(makeBot(Object.keys(BOT_LEVELS)[0], 'w', null));
  });
  const run = (online = true) => page.evaluate((on) => { gameCode = on ? 'ONLINE1' : 'BOT'; fpCheck(); gameCode = 'BOT'; return sent.slice(); }, online);
  const add = (html, where = 'body') => page.evaluate(([h, w]) => { const t = w === 'body' ? document.body : document.querySelector(w); t.insertAdjacentHTML('beforeend', h); }, [html, where]);

  console.log('\nThe board watcher');
  ok('a clean board reports nothing', (await run()).length === 0, await run());
  await page.evaluate(() => { arrows = [{ from: 52, to: 36, color: 'green' }]; marks = [{ sq: 12, color: 'red' }]; drawOverlay(); });
  await page.evaluate(() => { const g = document.createElement('div'); g.className = 'dragghost'; document.body.appendChild(g); });
  ok('our own arrows, circles and drag ghost report nothing', (await run()).length === 0, await run());
  await add('<div id="sf-overlay" style="position:fixed;inset:0;pointer-events:none"></div>');
  let r = await run();
  ok('a layer over the board is reported', r.some((x) => /layer over the board: div#sf-overlay/.test(x)), r);
  await add('<div class="best-move-hl"></div>', '#board .sq');
  r = await run();
  ok('something added to a square is reported', r.some((x) => /added to a square: div\.best-move-hl/.test(x)), r);
  await add('<div id="stockfish-panel" style="position:fixed;left:-500px;top:0;width:10px;height:10px"></div>');
  r = await run();
  ok('an engine helper elsewhere on the page is reported by its name', r.some((x) => /engine helper on the page: div#stockfish-panel/.test(x)), r);
  const n = r.length;
  ok('each finding is reported once per game', (await run()).length === n, await run());
  await page.evaluate(() => { sent.length = 0; FP.sent.clear(); });
  ok('nothing is reported in a game against the computer', (await run(false)).length === 0, await run(false));

  console.log('\nThe admin list');
  await page.evaluate(() => paintFair([
    { name: 'clean', fair: { ext: 0, verdict: { games: 3, match: 48, acpl: 41, flag: null }, pending: 0 } },
    { name: 'sus', fair: { ext: 2, verdict: { games: 3, match: 84, acpl: 9, flag: 'engine-like over 3 games (84% top move, 9 average loss)' }, pending: 0 } },
    { name: 'new', fair: { ext: 0, verdict: null, pending: 2 } },
  ]));
  const rows = await page.$$eval('#adfair tr', (t) => t.map((x) => [...x.cells].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' ')));
  ok('flagged players come first, with the reason', /^sus possible engine engine-like over 3 games/.test(rows[0]) && /2/.test(rows[0]), rows);
  ok('ordinary players show their numbers', rows.some((x) => /^clean 48% top move · 41 avg loss · 3 games 0/.test(x)), rows);
  ok('players with unchecked games show progress', rows.some((x) => /^new checking…/.test(x)), rows);

  console.log(`\n${passed} passed, ${failed} failed`);
  await br.close(); srv.kill();
  process.exit(failed ? 1 : 0);
})();
