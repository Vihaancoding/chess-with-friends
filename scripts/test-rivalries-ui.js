// Rivalries in the browser: the curated home page (insights, featured rivalries with real reasons, around the community,
// all rivalries with filters and sorting, empty states), the head-to-head page (stats, encounters, timeline, seasons,
// archive), community rivalries (their page, profiles, replays), challenges (sent, declined, cancelled, incoming), and
// the result card's rivalry strip with "Best of 3". Runs the server in this process so it can seed months of history.
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
  // around the community: bob and cat, close with the lead changing hands; dan and eve, new and busy
  await seed('bob', 'cat', ['w', 'l', 'l', 'w', 'w', 'l', 'd', 'l', 'w', 'w', 'l', 'l', 'w', 'd', 'w', 'l'], { start: now - 32 * day, gapDays: 2 });
  await seed('dan', 'eve', ['w', 'w', 'l', 'w', 'l', 'w'], { start: now - 6 * day, gapDays: 1 });
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
  await G.waitForSelector('#rvEmpty:not(.hidden)');
  ok('a player with no games gets an invitation, not a blank page', /No rivalries yet/.test(await G.textContent('#rvEmpty')) && await G.isHidden('#rvFeatSec') && await G.isHidden('#rvAllSec'));
  await G.waitForSelector('#rvComm .cmf');
  ok('…and can still discover what the community is playing', /bob|cat/.test(await G.textContent('#rvComm')));
  await shot(G, 'r0-empty', true);
  await G.click('[data-rvlobby]');
  await G.waitForSelector('#lobby:not(.hidden)');
  ok('"Find an opponent" goes to the lobby', true);

  console.log('the curated page');
  const A = await open(P.ann, { width: 1280, height: 900 });
  await A.goto(`http://localhost:${PORT}/?rivals`);
  await A.waitForSelector('#rvFeat .rvfh');
  ok('the featured rivalry is bob: the longest and closest, with the lead in play', (await A.$eval('#rvFeat .rvfh', (x) => x.dataset.rvgo)) === 'bob');
  const why = await A.textContent('#rvFeat .rvfh .rvwhy');
  ok('…with a reason taken from the record', /lost 3 straight|took the lead|Neck and neck|Level|most played/i.test(why), why);
  ok('the featured card puts the score first', /10\s*–\s*12/.test(await A.textContent('#rvFeat .rvfh .rvbig')) && /bob leads by 2/.test(await A.textContent('#rvFeat .rvfh .rvcap')));
  const minis = await A.$$eval('#rvFeat .rvfmn', (x) => x.map((c) => c.dataset.rvgo));
  ok('cat is featured as well; a one-game rivalry is not', minis.includes('cat') && !minis.includes('dan'), minis);
  ok('featured rows are wide, and their button stays on one line', await A.$eval('#rvFeat .rvfmn', (x) => x.getBoundingClientRect().width > 700) && await A.$eval('#rvFeat .rvfmn [data-rva="run"]', (b) => b.getBoundingClientRect().height < 42));
  ok('insights in one strip', /Most played/.test(await A.textContent('#rvInsights')), await A.textContent('#rvInsights'));
  await A.waitForSelector('#rvComm .cmf');
  const cf = await A.$eval('#rvComm .cmf', (x) => x.dataset.rvpub);
  ok('around the community: bob vs cat leads, from real games', cf === 'bob~cat', cf);
  ok('…with why it is interesting', /changed hands|level|Separated by one win|wins apart/i.test(await A.textContent('#rvComm .cmf .cmwhy')), await A.textContent('#rvComm .cmf .cmwhy'));
  ok('…and other matchups beside it', (await A.$$('#rvComm .cmc')).length >= 1 && /dan/.test(await A.textContent('#rvComm .cmrow')), await A.textContent('#rvComm'));
  const rows = await A.$$eval('#rvList .rvr', (x) => x.map((c) => c.dataset.rvgo));
  ok('all rivalries: everyone still there, active ones by default', rows.length === 3 && rows.includes('dan') && !rows.includes('eve'), rows);
  ok('filter counts', /Active 3/.test(await A.textContent('#rvFilter')) && /All 4/.test(await A.textContent('#rvFilter')) && /Archived 1/.test(await A.textContent('#rvFilter')), await A.textContent('#rvFilter'));
  await shot(A, 'r1-home-desktop', true);
  await A.selectOption('#rvSort', 'most');
  await A.waitForFunction(() => document.querySelector('#rvList .rvr') && document.querySelector('#rvList .rvr').dataset.rvgo === 'bob');
  ok('sort by most played', true);
  await A.selectOption('#rvSort', 'losing');
  await A.waitForFunction(() => document.querySelector('#rvList .rvr').dataset.rvgo === 'bob');
  ok('sort by longest losing streak (bob: 3)', true);
  await A.selectOption('#rvSort', 'lead');
  await A.waitForFunction(() => document.querySelector('#rvList .rvr').dataset.rvgo === 'dan');
  ok('sort by biggest lead', true);
  await A.click('#rvFilter [data-f="arch"]');
  await A.waitForFunction(() => document.querySelectorAll('#rvList .rvr').length === 1);
  ok('Archived shows the rivalry nobody has played for months', (await A.$eval('#rvList .rvr', (c) => c.dataset.rvgo)) === 'eve');
  await A.click('#rvFilter [data-f="active"]');
  await A.selectOption('#rvSort', 'recent');
  await A.waitForFunction(() => document.querySelectorAll('#rvList .rvr').length === 3);

  console.log('the main page: rivalries to watch');
  await A.click('#navPlay');
  await A.waitForSelector('#rvwatch:not(.hidden) .rvw', { timeout: 10000 });
  const watch = await A.$$eval('#rvwlist .rvw', (x) => x.map((r) => r.dataset.rvwpub));
  ok('2–3 of the server\'s best matchups, the same for everyone', watch.length >= 2 && watch.length <= 3 && watch.includes('bob~cat'), watch);
  ok('…each with why', /Most competitive|Community favourite|Rising rivalry/.test(await A.textContent('#rvwlist')));
  await shot(A, 'r9-lobby-watch');
  await A.click('#rvwlist [data-rvwpub="bob~cat"]');
  await A.waitForSelector('.cmhero');
  ok('a matchup opens its rivalry page', /bob/.test(await A.textContent('.cmhero')) && /cat/.test(await A.textContent('.cmhero')));
  await A.goto(`http://localhost:${PORT}/?rivals`);
  await A.waitForSelector('#rvFeat .rvfh');

  console.log('challenges');
  await A.click('#rvFeat .rvfmn[data-rvgo="cat"] [data-rva="run"]');
  await A.waitForFunction(() => /Waiting/.test(document.querySelector('.rvfmn[data-rvgo="cat"]').textContent), null, { timeout: 8000 });
  ok('shown as sent only after the server has it', (await api('me', {}, P.cat)).inbox.some((c) => c.from === 'ann'));
  ok('the same rival shows it everywhere it appears', /Waiting/.test(await A.textContent('#rvList .rvr[data-rvgo="cat"]')));
  ok('other rivals cannot be sent a second challenge meanwhile', await A.isDisabled('#rvList .rvr[data-rvgo="dan"] [data-rva="run"]'));
  const inbox = (await api('me', {}, P.cat)).inbox[0];
  ok('the challenge uses the time control you last played', inbox.tc && inbox.tc.base === 180 && inbox.tc.inc === 2, inbox.tc);
  await api('decline', { id: inbox.id }, P.cat);
  await A.waitForFunction(() => /Declined/.test(document.querySelector('.rvfmn[data-rvgo="cat"]').textContent), null, { timeout: 8000 });
  ok('a decline is shown', true);
  await A.click('#rvFeat .rvfh [data-rva="bo3"]');
  await A.waitForFunction(() => /waiting for bob/.test(document.querySelector('.rvfh').textContent), null, { timeout: 8000 });
  ok('Best of 3 from the featured rivalry', (await api('me', {}, P.bob)).inbox.some((c) => c.match && c.match.n === 3));
  await A.click('.rvfh [data-rva="cancel"]');
  await A.waitForFunction(() => !/waiting for bob/.test(document.querySelector('.rvfh').textContent), null, { timeout: 8000 });
  ok('Cancel withdraws it', !(await api('me', {}, P.bob)).inbox.length);
  await api('challenge', { to: 'ann', tc: { base: 300, inc: 0 } }, P.dan);
  await A.waitForFunction(() => /Challenged you/.test(document.querySelector('#rvList .rvr').textContent), null, { timeout: 8000 });
  ok('an incoming challenge puts that rival first in the list', (await A.$eval('#rvList .rvr', (x) => x.dataset.rvgo)) === 'dan');
  await A.click('#rvList .rvr[data-rvgo="dan"] [data-rva="decline"]');
  await A.waitForFunction(() => !/Challenged you/.test(document.querySelector('#rvList').textContent), null, { timeout: 8000 });

  console.log('around the community');
  await A.click('#rvComm .cmf .cmwhy');
  await A.waitForSelector('.cmhero');
  ok("bob vs cat opens: both names, their score, no 'you'", /bob/.test(await A.textContent('.cmhero')) && /cat/.test(await A.textContent('.cmhero')) && !/\byou\b/i.test(await A.textContent('.cmhero')), await A.textContent('.cmhero'));
  ok('their encounters and history', (await A.$$('.rve')).length === 15 && (await A.$$('.rtl li')).length >= 3);
  await shot(A, 'r8-community-rivalry', true);
  await A.click('.cmhero [data-rvprof="cat"]');
  await A.waitForFunction(() => view === 'profile');
  ok('player names open their profiles', /cat/.test(await A.textContent('#pfName')));
  await A.goto(`http://localhost:${PORT}/?rivalry=ann~bob`);
  await A.waitForSelector('.rvhero');
  ok('a community link to your own rivalry opens it as yours', await A.evaluate(() => RV.name === 'bob' && !RV.pub));
  await A.goto(`http://localhost:${PORT}/?rivals`);
  await A.waitForSelector('#rvFeat .rvfh');

  console.log('the head-to-head page');
  await A.click('#rvFeat .rvfh .rvbig');
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
  await A.waitForSelector('#rvList .rvr[data-rvgo="dan"]');
  await A.click('#rvList .rvr[data-rvgo="dan"] .rvrn');
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
  await M.waitForSelector('#rvFeat .rvfh');
  await M.waitForSelector('#rvComm .cmf');
  const noScroll = () => M.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok('the list fits a phone (no sideways scrolling)', await noScroll());
  ok('the featured score stays big', await M.$eval('.rvfh .rvbig .n', (x) => parseFloat(getComputedStyle(x).fontSize) >= 32));
  ok('community picks scroll sideways inside their row', await M.evaluate(() => { const r = document.querySelector('#rvComm .cmrow'); return !r || getComputedStyle(r).overflowX === 'auto'; }));
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
