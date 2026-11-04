// Rivalries in the browser: the list (cards, filters, insights, empty states), the head-to-head page (stats,
// encounters, timeline, seasons, archive), challenges from a card (sent, accepted, declined), and the result card's
// rivalry strip with "Best of 3". Runs the server in this process so it can seed months of history.
// Run: node scripts/test-rivalries-ui.js          (needs Playwright: npm i -g playwright, or NODE_PATH pointing at it)
const path = require('path');
const { chromium } = require('playwright');
process.env.PORT = String(4090 + Math.floor(Math.random() * 9));
process.env.SUPABASE_URL = '';
const PORT = process.env.PORT;
const SHOTS = process.env.SHOTS || '';
const origLog = console.log; console.log = () => {};
require('../server.js');
console.log = origLog;
const store = require('../lib/store');

let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => {
  const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) });
  return { status: r.status, ...(await r.json()) };
};
const sq = (q) => 'abcdefgh'.indexOf(q[0]) + (8 - +q[1]) * 8;
const MATE = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
const OPS = ['Italian Game', 'Sicilian Defense: Najdorf Variation', 'Queen\'s Gambit Declined', 'Caro-Kann Defense', 'Ruy Lopez'];

// archive rows for both players, as the server writes them when a game ends
let seq = 0;
async function seed(a, b, results, { start, gapDays = 1, tc = { base: 300, inc: 0 } }) {
  const add = async (who, rows) => { const k = 'games:' + who; const raw = (await store.get(k)) || { v: 0, list: [] }; const list = [...rows, ...(raw.list || raw)].sort((x, y) => y.at - x.at); await store.set(k, { v: (raw.v || 0) + 1, list }); };
  const ra = [], rb = [];
  results.forEach((res, i) => {
    const at = start + i * gapDays * 86400e3 + (i % 3) * 3600e3, id = `SEED${String(++seq).padStart(4, '0')}-x`, color = i % 2 ? 'b' : 'w';
    const moves = 20 + ((i * 7) % 60), ra0 = 1200 + ((i * 13) % 90), rb0 = 1200 + ((i * 29) % 120), d = res === 'w' ? 8 : res === 'l' ? -8 : 0;
    const base = { code: 'SEEDX', at, cat: 'blitz', tc, moves, dur: (6 + (i % 5)) * 60e3, eco: 'C50', op: OPS[i % OPS.length], rated: true, reason: res === 'd' ? 'agreement' : 'resignation', id };
    ra.push({ ...base, color, opp: b, oppRating: rb0, result: res === 'w' ? 'win' : res === 'l' ? 'loss' : 'draw', before: ra0, after: ra0 + d, delta: d });
    rb.push({ ...base, color: color === 'w' ? 'b' : 'w', opp: a, oppRating: ra0, result: res === 'w' ? 'loss' : res === 'l' ? 'win' : 'draw', before: rb0, after: rb0 - d, delta: -d });
  });
  await add(a, ra); await add(b, rb);
}

(async () => {
  await sleep(300);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = {};
  for (const n of ['ann', 'bob', 'cat', 'dan', 'eve', 'gus']) P[n] = await su(n);
  const day = 86400e3, now = Date.now();
  // bob: a long, swinging rivalry over two months (ann lost the last game, bob just took the lead)
  await seed('ann', 'bob', ['w', 'w', 'l', 'd', 'w', 'l', 'l', 'w', 'w', 'w', 'l', 'd', 'l', 'w', 'l', 'w', 'l', 'w', 'l', 'd', 'l', 'w', 'l', 'l', 'l'], { start: now - 50 * day, gapDays: 2 });
  // cat: cat leads clearly; dan: one game; eve: played long ago (archived)
  await seed('ann', 'cat', ['l', 'w', 'l', 'l', 'w', 'l', 'l', 'd'], { start: now - 20 * day, gapDays: 2, tc: { base: 180, inc: 2 } });
  await seed('ann', 'eve', ['w', 'l', 'w'], { start: now - 120 * day, gapDays: 3 });
  // and a real game with dan, so a replay exists
  const g = await api('create', { color: 'w', tc: { base: 600, inc: 0 } }, P.ann);
  await api('join', { code: g.code }, P.dan);
  for (const [i, u] of MATE.entries()) await api('move', { code: g.code, from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)) }, i % 2 ? P.dan : P.ann);
  await sleep(300);

  const br = await chromium.launch();
  const open = async (u, viewport) => {
    const ctx = await br.newContext({ viewport });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); });
    page.on('dialog', (d) => d.accept());
    await page.route(/cdn\.jsdelivr\.net/, (r) => r.abort());
    await ctx.addInitScript((x) => { localStorage.setItem('chess:user', JSON.stringify(x)); }, u);
    return page;
  };
  const shot = (page, name, full) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: !!full });

  console.log('empty state');
  const G = await open(P.gus, { width: 1280, height: 860 });
  await G.goto(`http://localhost:${PORT}/`);
  await G.waitForSelector('#lobby:not(.hidden)');
  await G.click('#navRivals');
  await G.waitForSelector('#rvList .rvempty');
  ok('a player with no games gets an invitation, not a blank page', /No rivalries yet/.test(await G.textContent('#rvList')) && !!(await G.$('[data-rvlobby]')));
  await G.click('[data-rvlobby]');
  await G.waitForSelector('#lobby:not(.hidden)');
  ok('"Find an opponent" goes to the lobby', true);

  console.log('the list');
  const A = await open(P.ann, { width: 1280, height: 900 });
  await A.goto(`http://localhost:${PORT}/?rivals`);
  await A.waitForSelector('#rvList .rvc');
  const names = await A.$$eval('#rvList .rvc', (x) => x.map((c) => c.dataset.rv));
  ok('active rivalries, most recent first; the old one is not here', names.join() === 'dan,cat,bob' || names.join() === 'dan,bob,cat', names);
  ok('filter counts', /Active 3/.test(await A.textContent('#rvFilter')) && /All 4/.test(await A.textContent('#rvFilter')) && /Archived 1/.test(await A.textContent('#rvFilter')), await A.textContent('#rvFilter'));
  const bob = await A.$eval('.rvc[data-rv="bob"]', (c) => c.textContent.replace(/\s+/g, ' '));
  ok('bob: head-to-head score, draws, tier, who leads', /10\s*–\s*12/.test(bob) && /3 draws/.test(bob) && /Nemeses/.test(bob) && /bob leads by 2/.test(bob), bob);
  ok('…the latest results and the streak', (await A.$$('.rvc[data-rv="bob"] .rstrip i')).length === 8 && /L3/.test(bob), bob);
  ok('the button fits the story: ann lost last, so "Settle the score"', /Settle the score/.test(bob), bob);
  const cat = await A.$eval('.rvc[data-rv="cat"]', (c) => c.textContent.replace(/\s+/g, ' '));
  ok('cat leads: said in words, not just colour', /cat leads by 3/.test(cat), cat);
  ok('insights only where there are enough games', /Most played/.test(await A.textContent('#rvInsights')) && /bob/.test(await A.textContent('#rvInsights')), await A.textContent('#rvInsights'));
  await shot(A, 'r1-list-desktop');
  await A.click('#rvFilter [data-f="arch"]');
  await A.waitForFunction(() => document.querySelectorAll('#rvList .rvc').length === 1);
  ok('Archived shows the rivalry nobody has played for months', (await A.$eval('#rvList .rvc', (c) => c.dataset.rv)) === 'eve');
  await A.click('#rvFilter [data-f="active"]');
  await A.waitForFunction(() => document.querySelectorAll('#rvList .rvc').length === 3);

  console.log('challenges from a card');
  await A.click('.rvc[data-rv="cat"] [data-rva="run"]');
  await A.waitForFunction(() => /Challenge sent · waiting for cat/.test(document.querySelector('.rvc[data-rv="cat"]').textContent), null, { timeout: 8000 });
  ok('shown as sent only after the server has it', (await api('me', {}, P.cat)).inbox.some((c) => c.from === 'ann'));
  ok('other cards cannot send a second challenge meanwhile', await A.isDisabled('.rvc[data-rv="bob"] [data-rva="run"]'));
  const inbox = (await api('me', {}, P.cat)).inbox[0];
  ok('the challenge uses the time control you last played', inbox.tc && inbox.tc.base === 180 && inbox.tc.inc === 2, inbox.tc);
  await api('decline', { id: inbox.id }, P.cat);
  await A.waitForFunction(() => /cat declined/.test(document.querySelector('.rvc[data-rv="cat"]').textContent), null, { timeout: 8000 });
  ok('a decline is shown on the card', true);
  await A.click('.rvc[data-rv="dan"] [data-rva="bo3"]');
  await A.waitForFunction(() => /waiting for dan/.test(document.querySelector('.rvc[data-rv="dan"]').textContent), null, { timeout: 8000 });
  await A.click('.rvc[data-rv="dan"] [data-rva="cancel"]');
  await A.waitForFunction(() => !/waiting for dan/.test(document.querySelector('.rvc[data-rv="dan"]').textContent), null, { timeout: 8000 });
  ok('Cancel withdraws it', !(await api('me', {}, P.dan)).inbox.length);
  await api('challenge', { to: 'ann', tc: { base: 300, inc: 0 } }, P.bob);
  await A.waitForFunction(() => /bob challenged you/.test(document.querySelector('.rvc[data-rv="bob"]').textContent), null, { timeout: 8000 });
  ok('an incoming challenge shows on that rival\'s card, first in the list', (await A.$$eval('#rvList .rvc', (x) => x[0].dataset.rv)) === 'bob');
  await shot(A, 'r2-incoming');
  await A.click('.rvc[data-rv="bob"] [data-rva="decline"]');
  await A.waitForFunction(() => !/bob challenged you/.test(document.querySelector('.rvc[data-rv="bob"]').textContent), null, { timeout: 8000 });

  console.log('the head-to-head page');
  await A.click('.rvc[data-rv="bob"] .rvscore');
  await A.waitForSelector('.rvhero');
  ok('the page opens with the matchup', /10\s*–\s*12/.test(await A.textContent('.rvhero .rvscore')) && /bob/.test(await A.textContent('.rvhero')));
  ok('statistics: games, score, streaks, opening', /Games\s*25/.test((await A.textContent('.rvstats')).replace(/\s+/g, ' ')) && /Most played opening/.test(await A.textContent('.rvstats')), await A.textContent('.rvstats'));
  ok('encounters, newest first, 15 at a time', (await A.$$('.rve')).length === 15 && !!(await A.$('[data-rvmore]')));
  await A.click('[data-rvmore]');
  ok('…and the rest on request', (await A.$$('.rve')).length === 25);
  ok('a timeline of moments', (await A.$$('.rtl li')).length >= 5 && /took the lifetime lead/.test(await A.textContent('.rtl')), await A.textContent('.rtl'));
  ok('tier and what the next one needs', /Rivals|Nemeses/.test(await A.textContent('.rvtierrow')), await A.textContent('.rvtierrow'));
  await shot(A, 'r3-detail-desktop', true);
  await A.click('[data-rva="season-start"]');
  await A.waitForFunction(() => /Season 1/.test(document.querySelector('.rvseason').textContent), null, { timeout: 8000 });
  ok('a season starts: 0–0, with days left', /0 – 0/.test(await A.textContent('.rvseason')) && /left/.test(await A.textContent('.rvseason')));
  await A.click('[data-rva="season-end"]');
  await A.waitForFunction(() => /Start a season/.test(document.querySelector('.rvseason').textContent), null, { timeout: 8000 });
  ok('ending it keeps it in the list', /Season 1/.test(await A.textContent('.rvpast')));
  await A.click('[data-rva="archive"]');
  await A.waitForFunction(() => /Unarchive/.test(document.querySelector('[data-rva="archive"]').textContent), null, { timeout: 8000 });
  ok('Archive', true);
  await A.click('[data-rva="archive"]');
  await A.waitForFunction(() => /^Archive$/.test(document.querySelector('[data-rva="archive"]').textContent.trim()), null, { timeout: 8000 });

  console.log('replays from the history');
  await A.click('[data-rvhome]');
  await A.waitForSelector('.rvc[data-rv="dan"]');
  await A.click('.rvc[data-rv="dan"] .rvp.them');
  await A.waitForSelector('.rve [data-rvgame]');
  await A.click('.rve [data-rvgame]');
  await A.waitForFunction(() => typeof isArchive === 'function' && isArchive() && snap && snap.hist && snap.hist.length === 7, null, { timeout: 10000 });
  ok('Replay opens the real game', true);
  await A.click('#leave');
  await A.waitForSelector('.rvhero');
  ok('…and Back returns to the rivalry', /dan/.test(await A.textContent('.rvhero')));

  console.log('after a game: the result card');
  const g2 = await api('create', { color: 'w', tc: { base: 300, inc: 0 } }, P.ann);
  await api('join', { code: g2.code }, P.bob);
  await A.goto(`http://localhost:${PORT}/?game=${g2.code}`);
  await A.waitForFunction(() => snap && snap.players.b);
  for (const [i, u] of MATE.entries()) await api('move', { code: g2.code, from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)) }, i % 2 ? P.bob : P.ann);
  await A.waitForSelector('#over:not(.hidden) #orival:not(.hidden)', { timeout: 15000 });
  await A.waitForFunction(() => /You 11 – 12 bob/.test(document.querySelector('#orival').textContent), null, { timeout: 10000 }).catch(() => {});
  ok('the rivalry, including this game', /Rivalry with bob/.test(await A.textContent('#orival')) && /You 11 – 12 bob/.test(await A.textContent('#orival')), await A.textContent('#orival'));
  ok('the rematch button speaks to it, and Best of 3 is right there', /Run it back|Defend your lead|Settle the score/.test(await A.textContent('#oRematch')) && await A.isVisible('#oBo3'), await A.textContent('#oRematch'));
  await shot(A, 'r4-result-card');
  await A.click('#oBo3');
  const B = await open(P.bob, { width: 390, height: 820 });
  await B.goto(`http://localhost:${PORT}/?game=${g2.code}`);
  await B.waitForFunction(() => snap && snap.rematchSeries === 'bo3', null, { timeout: 10000 });
  await B.evaluate(() => { showOver(snap); });
  await B.waitForFunction(() => /Accept best of 3/.test(document.querySelector('#oRematch').textContent));
  ok('bob is offered the best of 3', true);
  await B.click('#oRematch');
  await A.waitForFunction(() => snap && snap.match && snap.match.n === 3 && !snap.status.over, null, { timeout: 10000 });
  ok('…and the series starts for both', /Best of 3/.test(await A.textContent('#mpTitle')));

  console.log('phones');
  const M = await open(P.ann, { width: 375, height: 812 });
  await M.goto(`http://localhost:${PORT}/?rivals`);
  await M.waitForSelector('#rvList .rvc');
  const noScroll = () => M.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok('the list fits a phone (no sideways scrolling)', await noScroll());
  ok('the score stays readable', await M.$eval('.rvc .rvscore .n', (x) => parseFloat(getComputedStyle(x).fontSize) >= 22));
  await shot(M, 'r5-list-phone', true);
  await M.goto(`http://localhost:${PORT}/?rival=bob`);
  await M.waitForSelector('.rvhero');
  ok('the head-to-head page fits a phone', await noScroll());
  ok('the rematch button is easy to reach', await M.isVisible('.rvhero [data-rva="run"]'));
  await shot(M, 'r6-detail-phone', true);
  const T = await open(P.ann, { width: 820, height: 1100 });
  await T.goto(`http://localhost:${PORT}/?rival=bob`);
  await T.waitForSelector('.rvhero');
  ok('tablet fits too', await T.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await shot(T, 'r7-detail-tablet', true);

  await br.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
