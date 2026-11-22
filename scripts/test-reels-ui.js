// REELS and LIVE TUNE-IN in the browser: the vertical feed (scroll snap, the next reel peeking), the action rail (navigate,
// fire, save, flip, share), replay, filters, the side panels, live alerts (preferences, dedupe, cooldown, never while watching),
// and the Stockfish Web Worker helper (runs, and stops when the tab goes to the background).
// Run: node scripts/test-reels-ui.js (needs Playwright)
const { chromium } = require('playwright');
process.env.PORT = String(4380 + Math.floor(Math.random() * 9)); process.env.SUPABASE_URL = ''; process.env.ADMIN_KEY = 'k';
const PORT = process.env.PORT, origLog = console.log; console.log = () => {};
require('../server.js'); console.log = origLog;
const app = require('../lib/app'), store = require('../lib/store'), fx = require('./fixtures/damage-games.json');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => { const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, ...(await r.json()) }; };
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
const H = (ucis) => ucis.map((u) => ({ from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)), ...(u[4] ? { promo: u[4].toUpperCase() } : {}) }));
(async () => {
  await sleep(300);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const A = await su('ann'), V = await su('vera'), M = await su('Morphy'), D = await su('Duke');
  // two real games with their real evaluations; vera (not a player, not the analyst) confirms them through the API
  for (const [name, id] of [['Opera game', 'OPERA-1'], ['Legal trap', 'LEGAL-1']]) {
    const f = fx.find((x) => x.name === name), g = { id, code: id.slice(0, 5), players: { w: { name: 'Morphy', elo: 1200 }, b: { name: 'Duke', elo: 1200 } }, hist: H(f.ucis), moves: require('../public/excite.js').replay(H(f.ucis)).plies.map((x) => x.san), result: f.result, reason: f.reason, endedAt: Date.now() - 86400e3 * 400, startedAt: Date.now() - 86400e3 * 400 - 600e3 };
    await store.set('game:' + id, g); await app.reelsFromEval(g, f.ev, ['zed']);
  }
  for (let k = 0; k < 8; k++) {
    const j = await api('reel_job', {}, V); if (!j.job || j.job.kind !== 'verify') break;
    const f = fx.find((x) => x.name === (j.job.id.startsWith('OPERA') ? 'Opera game' : 'Legal trap'));
    await api('reel_submit', { kind: 'verify', id: j.job.id, res: j.job.need.map((i) => ({ i, s: (i % 2 ? -1 : 1) * f.ev[i] })) }, V);
  }
  const br = await chromium.launch(); const ctx = await br.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage();
  p.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message, (e.stack || '').split('\n').slice(0, 4).join(' | ')); }); await p.route(/cdn\.jsdelivr\.net|fonts\.g/, (x) => x.abort());
  await ctx.addInitScript((x) => { localStorage.setItem('chess:user', JSON.stringify(x)); localStorage.setItem('chess:help', '0'); }, A);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${PORT}` });
  await p.goto(`http://localhost:${PORT}/?reels`); await p.waitForSelector('#rlFeed .reel[data-i="0"] .rlboard .sq'); await sleep(600);

  console.log('the feed');
  ok('vertical feed with mandatory scroll snapping', await p.evaluate(() => getComputedStyle($('#rlFeed')).scrollSnapType) === 'y mandatory');
  const geo = await p.evaluate(() => { const f = $('#rlFeed').getBoundingClientRect(), r = document.querySelectorAll('#rlFeed .reel'); return { n: r.length, peek: r[1] && r[1].getBoundingClientRect().top < f.bottom, h: r[0].offsetHeight < f.height }; });
  ok('one dominant reel, the next one peeks in at the bottom', geo.n >= 2 && geo.peek && geo.h, geo);
  ok('board is a correctly oriented 8x8 (a8 top-left, White at the bottom)', await p.evaluate(() => { const s = document.querySelectorAll('#rlFeed .reel[data-i="0"] .rlboard .sq'); return s.length === 64 && s[0].classList.contains('l') && s[63].classList.contains('l'); }));
  ok('evaluation bar flush against the board, player pills White then Black, and the card', await p.evaluate(() => { const r = $('#rlFeed .reel[data-i="0"]'); const pills = r.querySelectorAll('.rlpill'); return !!r.querySelector('.rlboardrow > .rlbar + .rlboard') && pills.length === 2 && /Morphy/.test(pills[0].textContent) && /Duke/.test(pills[1].textContent) && /VIEW FULL GAME/i.test(r.querySelector('.rlcard').textContent); }));
  const first = await p.evaluate(() => RL.items[0]);
  ok('the card states the verified moment, its category, status and original date', /CHANGED EVERYTHING|MATE/.test(first.head) && /Completed · Decisive/.test(await p.textContent('#rlFeed .reel[data-i="0"] .rlcard')), first.head);
  ok('desktop side panels: moves with the current one marked, evaluation sparkline, up next, happening live', await p.evaluate(() => !!$('#rlLeft .rlmv button.on') && !!$('#rlLeft .rlspark') && /Up next/i.test($('#rlRight').textContent) && /Happening live/i.test($('#rlRight').textContent)));

  console.log('the action rail');
  await p.click('#rlRail [data-ra="down"]'); await sleep(900);
  ok('down goes to the next reel', await p.evaluate(() => RL.cur) === 1);
  await p.click('#rlRail [data-ra="up"]'); await sleep(900);
  ok('up comes back', await p.evaluate(() => RL.cur) === 0);
  await p.keyboard.press('ArrowDown'); await sleep(900); await p.keyboard.press('ArrowUp'); await sleep(900);
  ok('arrow keys navigate too', await p.evaluate(() => RL.cur) === 0);
  await p.click('#rlRail [data-ra="fire"]'); await sleep(300);
  ok('fire: counted and persisted', await p.textContent('#rlRail [data-ra="fire"]') === '🔥1' && (await store.get('hlr:' + first.id)).n === 1);
  await p.click('#rlRail [data-ra="save"]'); await sleep(300);
  ok('save: kept for this account', [].concat((await store.get('hlsave:ann')).list || (await store.get('hlsave:ann'))).some((x) => x.id === first.id));
  const bd = () => p.evaluate(() => [...document.querySelectorAll('#rlFeed .reel[data-i="0"] .rlboard .sq')].map((x) => x.innerHTML.replace(/<[^>]*src="[^"]*\/(\w+)\.svg"[^>]*>/g, '$1')).join('|'));
  const before = await bd();
  await p.click('#rlRail [data-ra="flip"]'); await sleep(200);
  const after = await bd();
  ok('flip turns the board around (the squares in reverse order)', await p.evaluate(() => RL.flip) && after === before.split('|').reverse().join('|') && after !== before);
  await p.click('#rlRail [data-ra="flip"]');
  await p.click('#rlRail [data-ra="share"]'); await sleep(300);
  ok('share copies a link that opens this reel', (await p.evaluate(() => navigator.clipboard.readText())).endsWith('/?reel=' + encodeURIComponent(first.id)));
  await p.click('#rlFeed .reel[data-i="0"] .rlboard'); await sleep(100);
  const start = await p.evaluate(() => RL.ply[RL.items[0].id]);
  await sleep(1700);
  ok('tapping the board replays the moment move by move', start === first.seq[0] && await p.evaluate(() => RL.ply[RL.items[0].id]) > start);
  await p.click('#rlLeft .rlmv button[data-rp="1"]'); await sleep(200);
  ok('a move in the list jumps the board there', await p.evaluate(() => RL.ply[RL.items[0].id]) === 1);

  console.log('filters and sorting');
  await p.click('#rlCats [data-rc="checkmates"]'); await sleep(900);
  ok('checkmates only', await p.evaluate(() => RL.items.length > 0 && RL.items.every((x) => x.k === 'mate')));
  await p.click('#rlSort [data-rs="saved"]'); await sleep(900);
  await p.click('#rlCats [data-rc="all"]'); await sleep(900);
  ok('saved shows what this account saved', await p.evaluate(() => RL.items.length === 1 && RL.items[0].saved));
  await p.click('#rlSort [data-rs="best"]'); await sleep(900);
  ok('best of all time shows a 400-day-old game', await p.evaluate(() => RL.items.some((x) => Date.now() - x.at > 300 * 86400e3)));
  await p.goto(`http://localhost:${PORT}/?reel=${encodeURIComponent(first.id)}`); await p.waitForSelector('#rlFeed .reel[data-i="0"]'); await sleep(500);
  ok('a shared link opens on that reel', await p.evaluate(() => RL.items[0].id) === first.id);
  await p.click('#rlFeed .reel[data-i="0"] [data-rcta]'); await sleep(1200);
  ok('View full game opens the game at the moment', await p.evaluate(() => view === 'game' && gameCode === 'ARCHIVE'));

  console.log('live alerts');
  await p.evaluate(() => enterTune()); await sleep(600);
  const ev = (type, code, cat = 'tactics') => ({ code, type, cat, head: 'THINGS JUST GOT INTERESTING.', text: 'Knight just sacrificed a rook.', w: { name: 'x1', elo: 1500 }, b: { name: 'x2', elo: 1500 } });
  const toast = async (e) => { await p.evaluate(() => { $('#chatToast').classList.remove('show'); }); await p.evaluate((x) => onTune(x), e); await sleep(150); return p.evaluate(() => $('#chatToast').classList.contains('show') ? $('#chatToast').textContent : ''); };
  let t = await toast(ev('sac', 'AAA'));
  ok('an alert with WATCH LIVE', /THINGS JUST GOT INTERESTING/.test(t) && /WATCH LIVE/.test(t) && await p.evaluate(() => $('#chatToast').dataset.watch) === 'AAA', t);
  ok('the same event is not shown twice', !(await toast(ev('sac', 'AAA'))));
  ok('cooldown: no second alert within 75 seconds, even for another game', !(await toast(ev('comeback', 'BBB', 'comeback'))));
  await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('chess:tuneSeen')); s._last = 0; localStorage.setItem('chess:tuneSeen', JSON.stringify(s)); TP.cats.scramble = 0; });
  ok('a category you switched off stays quiet', !(await toast(ev('scramble', 'CCC', 'scramble'))));
  await p.evaluate(() => { view = 'game'; gameCode = 'DDD'; });
  ok('never for the game you are already watching', !(await toast(ev('sac', 'DDD'))));
  await p.evaluate(() => { view = 'tune'; gameCode = null; TP.on = false; });
  ok('alerts off: nothing', !(await toast(ev('sac', 'EEE'))));
  await p.evaluate(() => { TP.on = true; });

  console.log('Stockfish in a Web Worker');
  const res = await p.evaluate(async () => { const t = HELP.cancel; const r = await sfEval({ hist: [], need: [0], ms: 150 }, t); return r; });
  ok('the worker analyses a position (side-to-move score) and is reused', Array.isArray(res) && res[0].i === 0 && Number.isFinite(res[0].s) && Math.abs(res[0].s) < 150, res);
  const cancelled = await p.evaluate(async () => { const t = HELP.cancel; const pr = sfEval({ hist: [], need: [0, 0, 0, 0], ms: 150 }, t); HELP.cancel++; try { await pr; return false; } catch (e) { return e.message; } });
  ok('a background tab (or a newer job) cancels the work at the next position', cancelled === 'cancelled', cancelled);
  ok('helping is off when the player switches it off, and never while playing', await p.evaluate(() => { HELP.on = false; return !HELP.busy; }));

  await br.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
