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
  ok('join news shows in the tournament chat', /dan joined/.test(await A.textContent('#tcLog')), await A.textContent('#tcLog'));
  await A.fill('#tcIn', 'Welcome everyone, good luck!');
  await A.click('#tcForm button');
  await B.waitForFunction(() => /Welcome everyone/.test(document.querySelector('#tcLog').textContent), null, { timeout: 8000 });
  ok('a chat message reaches the other players', true);
  await shot(A, 't1-signup');
  await A.click('[data-tact="start"]');
  await A.waitForSelector('.tgroups');
  ok('two groups with tables', (await A.$$('.tgroups > .panel')).length === 2);
  ok('ann has a match to play', (await A.$$('#tvMine .banner')).length >= 1);
  ok('the chat announces the start', /has started: 6 players/.test(await A.textContent('#tcLog')));
  { const tt = (await api('tour_get', { id }, P.ann)).tour, f = tt.groups[1].fixtures.find((x) => x.a !== 'ann' && x.b !== 'ann' && x.a !== 'bob' && x.b !== 'bob');
    if (f) {
      await api('tour_play', { id, fx: f.id }, P[f.a]);
      await A.waitForSelector('#tvLive .tlive', { timeout: 8000 });
      ok('a game being played shows under Live now', new RegExp(`${f.a} vs ${f.b}`).test(await A.textContent('#tvLive')), await A.textContent('#tvLive'));
      await shot(A, 't2b-live-chat');
    } }

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
    if (tt.phase === 'ko' && !A.__shot) { A.__shot = 1; await A.waitForSelector('.kb', { timeout: 8000 }); await shot(A, 't3-bracket'); }
    await api('tour_award', { id, fx: f.id, res: 'a' }, P.ann);
  }
  await A.waitForSelector('.tchamp', { timeout: 8000 });
  ok('a champion is crowned', /Champion/.test(await A.textContent('.tchamp')));
  ok('with confetti', (await A.$$('.confetti')).length > 0);
  ok('and the news in the chat', /🏆 .* wins Autumn Cup/.test(await A.textContent('#tcLog')));
  ok('the bracket shows the final', /Final/.test(await A.textContent('.kb')) && /Semi-finals/.test(await A.textContent('.kb')));
  ok('and the champion slot', /Champion/.test(await A.textContent('.kchamp.on')) || /🏆/.test(await A.textContent('.kchamp.on')));
  ok('the group stage stays visible', (await A.$$('.tgroups > .panel')).length === 2);
  await shot(A, 't4-done');
  await A.click('#tvBack');
  await A.waitForSelector('#tourList .tl');

  console.log('scheduled start');
  await A.fill('#tnName', 'Timed Cup');
  await A.selectOption('#tnTc', '300,0');
  await A.fill('#tnStart', await A.evaluate(() => { const d = new Date(Date.now() + 2 * 3600e3 + 120e3), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }));
  await A.click('#tourNew button[type=submit]');
  await A.waitForSelector('#tvHead .tcount');
  ok('the page counts down to the start', /Starts in 2h 0[01]m/.test(await A.textContent('#tvHead')), await A.textContent('#tvHead'));
  await A.click('#tvBack');
  await A.waitForSelector('#tourList .tcount');
  ok('the list shows when it starts', /starts in 2h/.test(await A.textContent('#tourList')));
  await A.fill('#tnStart', '');

  console.log('time control by vote');
  await A.selectOption('#tnTc', 'poll');
  ok('picking "Players vote" shows the options', await A.isVisible('#tnPoll') && (await A.$$('#tnPollOpts input:checked')).length === 3);
  await A.fill('#tnName', 'Vote Cup'); await A.selectOption('#tnKind', 'ko');
  await A.click('#tourNew button[type=submit]');
  await A.waitForSelector('.tpoll');
  const vid = await A.evaluate(() => tourId);
  ok('the page shows the vote', /Vote: time control/.test(await A.textContent('#tvBody')) && (await A.$$('.tpo')).length === 3);
  await A.click('.tpo[data-tvote="1"]');
  await A.waitForSelector('.tpo.mine[data-tvote="1"]');
  ok('ann votes', /your vote/.test(await A.textContent('.tpo[data-tvote="1"]')));
  await B.goto(`http://localhost:${PORT}/?tour=${vid}`);
  await B.waitForSelector('.tpoll');
  ok('players must join before voting', await B.isDisabled('.tpo[data-tvote="0"]') && /Join the tournament to vote/.test(await B.textContent('#tvBody')));
  await B.click('[data-tact="join"]');
  await B.waitForSelector('.tpo[data-tvote="0"]:not([disabled])');
  await B.click('.tpo[data-tvote="0"]');
  await B.waitForSelector('.tpo.mine[data-tvote="0"]');
  await shot(B, 't5-vote-phone');
  await api('tour_vote', { id: vid, i: 1 }, P.bob);              // bob changes his mind: 2 votes for option 1
  await A.click('[data-tact="start"]');
  await A.waitForSelector('.tpo.won');
  ok('starting locks in the winner', /won the vote/.test(await A.textContent('#tvBody')) && /🏆/.test(await A.textContent('.tpo[data-tvote="1"]')) && /5 \+ 0/.test(await A.textContent('#tvHead')), await A.textContent('#tvHead'));
  ok('the list shows the winner', /Finished/.test(await A.textContent('#tourList')) && /🏆/.test(await A.textContent('#tourList')));

  console.log('Tournaments card on the main page');
  const mc = await api('tour_create', { name: 'Lobby Cup', tc: { base: 300, inc: 0 }, cfg: { kind: 'ko' } }, P.ann);
  await B.goto(`http://localhost:${PORT}/`);
  await B.waitForSelector('#tourmini .tl');
  const mini = await B.textContent('#tourmini');
  ok('the main page lists tournaments', /Lobby Cup/.test(mini) && /Sign-ups open/.test(mini) && /Autumn Cup/.test(mini), mini);
  ok('finished ones show the champion', /🏆/.test(mini));
  await shot(B, 't7-lobby-card');
  await B.click(`#tourmini [data-tmjoin="${mc.tour.id}"]`);
  await B.waitForSelector('#tourView:not(.hidden) [data-tact="leave"]');
  ok('Join from the card signs you up and opens it', (await api('tour_get', { id: mc.tour.id }, P.ann)).tour.players.some((p) => p.name === 'bob'));
  await B.click('#navPlay');
  await B.waitForFunction((id) => /you're in/.test(document.querySelector('#tourmini').textContent) && document.querySelector(`#tourmini [data-tmopen="${id}"]`), mc.tour.id, { timeout: 15000 });
  ok('then it says you are in, with Open', true);
  await B.click('#tcAll');
  await B.waitForSelector('#tourHome:not(.hidden) #tourList .tl');
  ok('See all opens the Tournaments page', true);

  console.log('clean group view and the waiting room');
  {
    const P2 = {}; for (const n of ['gil', 'hal', 'ivy', 'jon', 'kim']) P2[n] = await su(n);
    const who = (n) => P[n] || P2[n];
    const wc = await api('tour_create', { name: 'Clean Cup', tc: { base: 300, inc: 0 }, cfg: { kind: 'rr' } }, P.ann);
    const wid = wc.tour.id;
    for (const n of ['bob', ...Object.keys(P2)]) await api('tour_join', { id: wid }, who(n));
    await api('tour_start', { id: wid }, P.ann);
    await A.goto(`http://localhost:${PORT}/?tour=${wid}`);
    await A.waitForSelector('.fxround');
    ok('games are grouped by round', /Round 1/.test(await A.textContent('.fxl')) && /Round 2/.test(await A.textContent('.fxl')));
    ok('no result buttons until the organizer asks for them', !(await A.$('[data-taward]')));
    ok('exactly one "Your next game", with Play', (await A.$$('.fxr .ytag')).length === 1 && (await A.$$('.fxr .fx-act .primary')).length === 1, await A.$$eval('.fxr .fx-act button', (x) => x.map((b) => b.textContent)));
    ok('one next-game banner, not a pile', (await A.$$('#tvMine .banner')).length === 1 && /more after this/.test(await A.textContent('#tvMine')), await A.textContent('#tvMine'));
    await shot(A, 't8-clean-groups');
    await A.click('[data-tact="edit"]');
    await A.waitForSelector('[data-taward]');
    ok('Edit results shows the result buttons', (await A.$$('.fxedit')).length > 3 && (await A.textContent('[data-tact="edit"]')) === 'Done editing');
    await shot(A, 't9-edit-mode');
    await A.click('[data-tact="edit"]');
    await A.waitForFunction(() => !document.querySelector('[data-taward]'));
    const tt = (await api('tour_get', { id: wid }, P.ann)).tour;
    const first = await A.evaluate((t) => Tour.myFixtures(t, 'ann')[0], tt), opp = first.a === 'ann' ? first.b : first.a;
    const O = await open(who(opp), { width: 390, height: 820 });
    await O.goto(`http://localhost:${PORT}/`);
    await O.waitForSelector('#lobby:not(.hidden)');
    await A.click('#tvMine [data-tplay]');
    await A.waitForFunction(() => snap && snap.tour && snap.players.w && snap.players.b);
    await A.waitForFunction(() => /Waiting for/.test(document.querySelector('#status').textContent), null, { timeout: 10000 }).catch(() => {});
    ok('the waiting room says who it is waiting for', new RegExp(`Waiting for ${opp}`).test(await A.textContent('#status')) && /notification/.test(await A.textContent('#sub')), [await A.textContent('#status'), await A.textContent('#sub')]);
    ok('with a Remind button', await A.isVisible('#mpRemind'));
    await A.click('#mpRemind');
    await A.waitForFunction(() => /Reminded|Just reminded/.test(document.querySelector('#mpRemind').textContent));
    ok('Remind answers', true);
    await shot(A, 't10-waiting-room');
    await O.waitForSelector('#tourBanners .twait', { timeout: 15000 });
    ok("the opponent's lobby says ann is waiting", /ann is waiting for you/.test(await O.textContent('#tourBanners')), await O.textContent('#tourBanners'));
    await O.evaluate((code) => onUserPing({ why: 'tourwait', from: 'ann', name: 'Clean Cup', stage: 'Round robin', code, id: 'x' }), await A.evaluate(() => gameCode));
    ok('the push shows a pop-up that takes them to the game', /ann is waiting for you/.test(await O.textContent('#chatToast')) && await O.evaluate(() => document.querySelector('#chatToast').classList.contains('show')));
    await shot(O, 't11-opponent-popup');
    await O.click('#chatToast');
    await O.waitForFunction(() => snap && snap.tour);
    await A.waitForFunction(() => !/Waiting for/.test(document.querySelector('#status').textContent), null, { timeout: 15000 });
    ok('once they arrive the waiting message goes away', !(await A.isVisible('#mpRemind')));
  }

  console.log('match length and the knockout bracket');
  {
    await A.goto(`http://localhost:${PORT}/?tours`);
    await A.waitForSelector('#tnLen');
    await A.selectOption('#tnKind', 'ko');
    await A.selectOption('#tnLen', '3');
    await A.fill('#tnName', 'Bracket Cup');
    await A.click('#tourNew button[type=submit]');
    await A.waitForSelector('#tourView:not(.hidden) .tvtop');
    const bid = await A.evaluate(() => tourId);
    ok('created as best of 3', (await api('tour_get', { id: bid }, P.ann)).tour.cfg.kn === 3);
    ok('the organizer sees the match length control', (await A.$eval('[data-tlen]', (x) => x.value)) === '3');
    const P3 = {}; for (const n of ['lia', 'max', 'ned', 'oli', 'pia', 'quin']) P3[n] = await su(n);
    for (const n of ['bob', ...Object.keys(P3)]) await api('tour_join', { id: bid }, P[n] || P3[n]);
    await api('tour_start', { id: bid }, P.ann);
    let tt = (await api('tour_get', { id: bid }, P.ann)).tour;
    for (const f of tt.ko.rounds[0].slice(0, 3)) await api('tour_award', { id: bid, fx: f.id, res: 'a' }, P.ann);
    tt = (await api('tour_get', { id: bid }, P.ann)).tour;
    const lv = tt.ko.rounds[0][3];
    const lvp = P[lv.a] || P3[lv.a];
    await api('tour_play', { id: bid, fx: lv.id }, lvp);
    await A.goto(`http://localhost:${PORT}/?tour=${bid}`);
    await A.waitForSelector('.kb .km');
    ok('quarter-finals, semis, final and a champion slot', /Quarter-finals/.test(await A.textContent('.kb')) && /Semi-finals/.test(await A.textContent('.kb')) && /Final/.test(await A.textContent('.kb')) && !!(await A.$('.kchamp')));
    ok('round headers show the match length', /Best of 3/i.test(await A.textContent('.kround h3')));
    ok('winners are marked and their path is lit', (await A.$$('.kslot.won')).length === 3 && (await A.$$('.kp.w')).length === 3);
    ok('a game in progress shows Live', /Live/.test(await A.textContent('.kb')));
    await shot(A, 't12-bracket-desktop');
    await A.selectOption('[data-tlen]', '1');
    await A.waitForFunction(() => /1 game/.test(document.querySelector('.kround:nth-child(2) h3').textContent), null, { timeout: 8000 });
    ok('changing the match length updates the rounds still to play', /Best of 3/i.test(await A.textContent('.kround:first-child h3')));
    const Q = await open(P.bob, { width: 390, height: 820 });
    await Q.goto(`http://localhost:${PORT}/?tour=${bid}`);
    await Q.waitForSelector('.kb .km');
    await shot(Q, 't13-bracket-phone');
    ok('on a phone the bracket scrolls sideways, not the page', await Q.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.querySelector('.kb').scrollWidth > document.querySelector('.kb').clientWidth));
  }

  console.log('9-player knockout: qualifying groups, then a full bracket (no byes)');
  {
    const N9 = {}; for (const n of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']) N9[n] = await su(n);
    const who = (n) => P[n] || N9[n];
    const nc = await api('tour_create', { name: 'Nine Cup', tc: { base: 600, inc: 0 }, cfg: { kind: 'ko' } }, P.ann);
    for (const n of Object.keys(N9)) await api('tour_join', { id: nc.tour.id }, N9[n]);
    const nt = (await api('tour_start', { id: nc.tour.id }, P.ann)).tour;
    ok('9 players start in 3 qualifying groups', nt.phase === 'groups' && nt.groups.length === 3, nt.groups && nt.groups.map((g) => g.players));
    await A.goto(`http://localhost:${PORT}/?tour=${nc.tour.id}`);
    await A.waitForSelector('.tgroups .panel');
    ok('the tables are called qualifying groups', (await A.$$eval('.tgroups h2', (x) => x.map((h) => h.textContent))).every((h) => /Qualifying group/.test(h)));
    ok('it says who goes through', /8 go through to the quarter-finals: the top 2 of each group and the 2 best third-placed players/.test(await A.textContent('.tqinfo')), await A.textContent('.tqinfo'));
    await shot(A, 't14-qualifying');

    // the screenshot's situation: White has moved, Black never opened the game
    const qf = nt.groups[0].fixtures.find((f) => f.a !== 'ann' && f.b !== 'ann');
    const pr = await api('tour_play', { id: nc.tour.id, fx: qf.id }, who(qf.a));
    const rm = await api('room', { code: pr.code }, who(qf.a));
    await api('move', { code: pr.code, from: 52, to: 36 }, who(rm.players.w.name));
    const S = await open(P.cat, { width: 1280, height: 860 });
    await S.goto(`http://localhost:${PORT}/?game=${pr.code}`);
    await S.waitForFunction(() => snap && snap.you === 's' && snap.moves.length === 1);
    await S.waitForFunction(() => /to join/.test(document.querySelector('#status').textContent), null, { timeout: 10000 }).catch(() => {});
    ok('a spectator sees who hasn\'t joined, not "Black to move"', /Waiting for .* to join/.test(await S.textContent('#status')) && /hasn't|haven't/.test(await S.textContent('#sub')), [await S.textContent('#status'), await S.textContent('#sub')]);
    await shot(S, 't15-spectator-wait');

    let tt = (await api('tour_get', { id: nc.tour.id }, P.ann)).tour;
    for (const f of tt.groups.flatMap((g) => g.fixtures)) await api('tour_award', { id: nc.tour.id, fx: f.id, res: 'a' }, P.ann);
    await A.goto(`http://localhost:${PORT}/?tour=${nc.tour.id}`);
    await A.waitForSelector('.kb .km');
    const first = await A.$eval('.kround:first-child', (x) => ({ h: x.querySelector('h3').textContent, cards: x.querySelectorAll('.km').length }));
    ok('then quarter-finals with 8 players and no byes', /Quarter-finals/.test(first.h) && first.cards === 4 && !(await A.$('.kbyetag')) && !(await A.$('.kslot.kbye')), first);
    await shot(A, 't16-quarters');
  }

  await br.close(); srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
