// Tournaments in the browser: create one, others join, the organizer starts it, a player plays their group match from
// the lobby banner, results fill the tables, the organizer settles the rest and the bracket plays out to a champion.
// Run: node scripts/test-tournament-ui.js          (needs Playwright: npm i -g playwright, or NODE_PATH pointing at it)
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 4030 + Math.floor(Math.random() * 9);
const SHOTS = process.env.SHOTS || '';
let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => {
  const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) });
  return { status: r.status, ...(await r.json()) };
};
const sq = (q) => 'abcdefgh'.indexOf(q[0]) + (8 - +q[1]) * 8;
const MATE = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
let srv = null;
process.on('exit', () => { if (srv) srv.kill(); });

(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, SUPABASE_URL: '', ADMIN_KEY: 'test-admin-key' }, stdio: 'ignore' });
  await sleep(800);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = {};
  for (const n of ['ann', 'bob', 'cat', 'dan', 'eve', 'fay']) P[n] = await su(n);
  await api('admin_claim', { key: 'test-admin-key' }, P.ann);              // only admins create tournaments
  const br = await chromium.launch();
  const open = async (u, viewport) => {
    const ctx = await br.newContext({ viewport });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); });
    page.on('dialog', (d) => d.accept());
    await page.route(/cdn\.jsdelivr\.net/, (r) => r.abort());
    await ctx.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), u);
    return page;
  };
  const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
  const A = await open(P.ann, { width: 1280, height: 900 });

  console.log('create');
  await A.goto(`http://localhost:${PORT}/`);
  await A.waitForSelector('#lobby:not(.hidden)');
  await A.click('#navTour');
  await A.waitForSelector('#tourHome:not(.hidden)');
  ok('an empty list to start with', /No tournaments yet/.test(await A.textContent('#tourList')));
  await A.selectOption('#tnKind', 'gko'); await A.selectOption('#tnSize', '3');
  ok('the form explains the format', /groups of about 3/.test(await A.textContent('#tnDesc')));
  await A.selectOption('#tnKind', 'rr');
  ok('round robin hides the knockout options', await A.isHidden('#tnKnL') && await A.isHidden('#tnGroupOpts'));
  await A.selectOption('#tnKind', 'gko');
  await A.fill('#tnName', 'Autumn Cup');
  await A.click('#tourNew button[type=submit]');
  await A.waitForSelector('#tourView:not(.hidden) .tvtop');
  const id = await A.evaluate(() => tourId);
  ok('opens the new tournament', (await A.textContent('#tvHead')).includes('Autumn Cup') && /Sign-ups open/.test(await A.textContent('#tvHead')));
  ok('the organizer is signed up, and cannot start alone', /ann/.test(await A.textContent('#tvBody')) && await A.isDisabled('[data-tact="start"]'));

  console.log('players get an invitation on the main page');
  const B = await open(P.bob, { width: 390, height: 820 });
  await B.goto(`http://localhost:${PORT}/?tours`);
  await B.waitForSelector('#tourList .tl');
  ok('players have no create form', await B.isHidden('#tourNew') && await B.isVisible('#tourAdminNote'));
  await B.goto(`http://localhost:${PORT}/`);
  await B.waitForSelector('#tourBanners .tinvite', { timeout: 15000 });
  ok('the invitation shows in the lobby', /invited: Autumn Cup/.test(await B.textContent('#tourBanners')), await B.textContent('#tourBanners'));
  await shot(B, 't0-invite-phone');
  await B.click('#tourBanners [data-tbhide]');
  ok('"Not now" hides it', !(await B.$('#tourBanners .tinvite')));
  await B.evaluate(() => { localStorage.removeItem('chess:tourHidden'); tourHidden.clear(); tourBanSig = ''; renderTourNext(tourLastNext, tourLastOpen); });

  console.log('join and start');
  await B.click('#tourBanners [data-tbjoin]');
  await B.waitForSelector('[data-tact="leave"]');
  ok('bob joins from a link', /bob/.test(await B.textContent('#tvBody')));
  for (const n of ['cat', 'dan', 'eve', 'fay']) await api('tour_join', { id }, P[n]);
  await A.waitForFunction(() => /6 \/ 12 players/.test(document.querySelector('#tvHead').textContent), null, { timeout: 8000 });
  ok('the organizer sees the players arrive', true);
  await shot(A, 't1-signup');
  await A.click('[data-tact="start"]');
  await A.waitForSelector('.tgroups');
  ok('two groups with tables', (await A.$$('.tgroups > .panel')).length === 2);
  ok('ann has a match to play', (await A.$$('#tvMine .banner')).length >= 1);

  console.log('play a group match from the lobby banner');
  await B.goto(`http://localhost:${PORT}/`);
  const t = (await api('tour_get', { id }, P.bob)).tour;
  const bf = t.groups.flatMap((g) => g.fixtures).find((f) => Tour_ready(f) && (f.a === 'bob' || f.b === 'bob'));
  function Tour_ready(f) { return f.a && f.b && !f.res; }
  if (bf) {
    await B.waitForSelector('#tourBanners .banner', { timeout: 15000 });
    ok('the lobby shows the waiting tournament match', /Autumn Cup/.test(await B.textContent('#tourBanners')));
    await B.click(`#tourBanners [data-fx="${bf.id}"]`);
    await B.waitForFunction(() => snap && snap.tour && snap.players.w && snap.players.b);
    ok('the game screen names the tournament', /Autumn Cup/.test(await B.textContent('#mpTitle')), await B.textContent('#mpTitle'));
    ok('no "End match" in a tournament', await B.isHidden('#mpEnd'));
    const code = await B.evaluate(() => gameCode), room = await api('room', { code }, P.bob);
    for (const [i, u] of MATE.entries()) await api('move', { code, from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)) }, P[i % 2 ? room.players.b.name : room.players.w.name]);
    await B.waitForSelector('#over:not(.hidden) #omatch:not(.hidden)', { timeout: 15000 });
    ok('the result card goes back to the tournament', (await B.textContent('#oRematch')) === 'Back to the tournament' && /Autumn Cup/.test(await B.textContent('#omatch')), await B.textContent('#oRematch'));
    await B.click('#oRematch');
    await B.waitForSelector('#tourView:not(.hidden) .tgroups');
    ok('the table counts it', /1 \/ 3 played/.test(await B.textContent('.tgroups')), await B.textContent('.tgroups'));
    await shot(B, 't2-groups-phone');
  } else ok('bob has a group match', false, t.groups);

  console.log('the organizer settles the rest; the bracket fills in');
  for (;;) {
    const tt = (await api('tour_get', { id }, P.ann)).tour;
    if (tt.phase === 'done') break;
    const f = (tt.groups || []).flatMap((g) => g.fixtures).concat(tt.ko ? tt.ko.rounds.flat() : []).find(Tour_ready);
    if (!f) break;
    if (tt.phase === 'ko' && !A.__shot) { A.__shot = 1; await A.waitForSelector('.bracket', { timeout: 8000 }); await shot(A, 't3-bracket'); }
    await api('tour_award', { id, fx: f.id, res: 'a' }, P.ann);
  }
  await A.waitForSelector('.tchamp', { timeout: 8000 });
  ok('a champion is crowned', /Champion/.test(await A.textContent('.tchamp')));
  ok('the bracket shows the final', /Final/.test(await A.textContent('.bracket')) && /Semi-finals/.test(await A.textContent('.bracket')));
  ok('the group stage stays visible', (await A.$$('.tgroups > .panel')).length === 2);
  await shot(A, 't4-done');
  await A.click('#tvBack');
  await A.waitForSelector('#tourList .tl');
  ok('the list shows the winner', /Finished/.test(await A.textContent('#tourList')) && /🏆/.test(await A.textContent('#tourList')));

  await br.close(); srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
