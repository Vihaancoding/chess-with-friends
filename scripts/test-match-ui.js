// Head-to-head match in the browser: two players in two pages, the scoreboard, the result card and the
// countdown that starts the next game on its own.
// Run: node scripts/test-match-ui.js          (needs Playwright: npm i -g playwright, or NODE_PATH pointing at it)
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 4010 + Math.floor(Math.random() * 9);
const SHOTS = process.env.SHOTS || '';                             // a folder to save screenshots in (optional)
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
process.on('exit', () => { if (srv) srv.kill(); });          // never leave a server behind on the port

(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, SUPABASE_URL: '' }, stdio: 'ignore' });
  await sleep(800);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const ann = await su('ann'), bob = await su('bob');
  const by = { ann, bob };
  const br = await chromium.launch();
  const open = async (u, viewport) => {
    const ctx = await br.newContext({ viewport });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { if (!/outerHTML/.test(e.message)) { failed++; console.log('  ✗ page error:', e.message); } });
    await page.route(/cdn\.jsdelivr\.net/, (r) => r.abort());
    await ctx.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), u);
    return page;
  };
  const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png') });
  const A = await open(ann, { width: 1280, height: 860 }), B = await open(bob, { width: 390, height: 820 });

  console.log('lobby');
  await A.goto(`http://localhost:${PORT}/`);
  await A.waitForSelector('#fmtPick');
  ok('one game by default', (await A.textContent('#create')) === 'Create game');
  await A.click('#fmtPick [data-f="bo3"]');
  ok('picking a format turns it into a match', (await A.textContent('#create')) === 'Create match' && /Up to 3 games/.test(await A.textContent('#fmtDesc')));
  await A.click('#tcgrid [data-v="300,0"]');
  await A.click('.colorpick [data-c="w"]');
  await shot(A, '1-lobby');
  await A.click('#create');
  await A.waitForFunction(() => typeof gameCode === 'string' && gameCode.length === 5);
  const code = await A.evaluate(() => gameCode);
  ok('the match panel shows before the opponent arrives', await A.isVisible('#matchpanel') && /Best of 3/.test(await A.textContent('#mpTitle')));

  await B.goto(`http://localhost:${PORT}/?game=${code}`);
  await B.waitForFunction(() => snap && snap.players.w && snap.players.b);
  await A.waitForFunction(() => snap && snap.players.b);
  ok('game 1 of 3', /Game 1 of 3/.test(await B.textContent('#mpSub')), await B.textContent('#mpSub'));
  ok('three empty squares to play', (await B.$$eval('#mpDots i', (x) => x.length)) === 3);

  console.log('game 1');
  const seats = async () => { const r = await api('room', { code }, ann); return { w: by[r.players.w.name], b: by[r.players.b.name] }; };
  const play = async (ucis) => { const s = await seats(); for (const [i, u] of ucis.entries()) await api('move', { code, from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)) }, i % 2 ? s.b : s.w); };
  await play(MATE);
  await A.waitForSelector('#over:not(.hidden) #omatch:not(.hidden)');
  await B.waitForSelector('#over:not(.hidden) #omatch:not(.hidden)');
  ok('the result card shows the match score', /ann\s*1\s*–\s*bob\s*0/.test(await A.textContent('#omatch .omscore')), await A.textContent('#omatch .omscore'));
  ok('ann is on match point', /Match point for you/.test(await A.textContent('#omatch')), await A.textContent('#omatch'));
  ok('the next game counts down', /Next game in \d+s/.test(await B.textContent('#omatch .omcount')), await B.textContent('#omatch .omcount'));
  ok('the button says Next game', (await B.textContent('#oRematch')) === 'Next game');
  await shot(A, '2-after-game1-desktop'); await shot(B, '2-after-game1-phone');
  await A.click('#omatch [data-mhold]');
  ok('Wait stops the countdown', /when you're ready/.test(await A.textContent('#omatch .omcount')), await A.textContent('#omatch .omcount'));
  await B.click('#oRematch');
  await A.waitForFunction(() => /is ready/.test(document.querySelector('#omatch .omcount').textContent));
  ok('ann sees bob is ready', true);
  await A.click('#oRematch');
  await A.waitForFunction(() => snap && !snap.status.over && snap.players.w.name === 'bob');
  await B.waitForFunction(() => snap && !snap.status.over && snap.you === 'w');
  ok('game 2 starts with colours swapped', true);
  ok('the result card closes', await B.isHidden('#over'));
  ok('the score carries over', /Game 2 of 3/.test(await A.textContent('#mpSub')) && (await A.textContent('#mpScore')).includes('1'));

  console.log('game 2: the countdown starts game 3 by itself');
  await play(MATE);                                                // bob (white) wins: 1–1
  await A.waitForSelector('#over:not(.hidden) #omatch:not(.hidden)');
  ok('1–1', /ann\s*1\s*–\s*bob\s*1/.test(await A.textContent('#omatch .omscore')), await A.textContent('#omatch .omscore'));
  await A.waitForFunction(() => snap && !snap.status.over && snap.moves.length === 0 && snap.players.w.name === 'ann', null, { timeout: 30000 });
  ok('after the countdown game 3 starts without a click', true);

  console.log('game 3: a draw means an Armageddon decider');
  { const s = await seats(); await play(['g1f3', 'g8f6']); await api('draw_offer', { code }, s.w); await api('draw_accept', { code }, s.b); }
  await A.waitForSelector('#over:not(.hidden) #omatch:not(.hidden)');
  ok('the card announces the decider', /Armageddon/.test(await A.textContent('#omatch')), await A.textContent('#omatch'));
  await A.click('#oRematch'); await B.click('#oRematch');
  await B.waitForFunction(() => snap && snap.arma && !snap.status.over);
  ok('the panel says Armageddon', /Armageddon/.test(await B.textContent('#mpSub')) && /draw counts as a win for Black/.test(await B.textContent('#mpNote')), await B.textContent('#mpNote'));
  const clocks = await B.$$eval('.clock', (x) => x.map((e) => e.textContent).sort());
  ok('Black has 4:00, White 5:00', clocks.join() === '4:00,5:00', clocks);
  await shot(B, '3-armageddon-phone');
  { const s = await seats(); await play(['g1f3', 'g8f6']); await api('draw_offer', { code }, s.w); await api('draw_accept', { code }, s.b); }
  const blackName = (await api('room', { code }, ann)).players.b.name;
  const win = blackName === 'ann' ? A : B, lose = blackName === 'ann' ? B : A;
  await win.waitForSelector('#over:not(.hidden) #omatch:not(.hidden)');
  for (const P of [win, lose]) await P.waitForFunction(() => snap.match.done && /match/.test(document.querySelector('#otitle').textContent));
  ok('Black takes the match with the draw', (await win.textContent('#otitle')) === 'You won the match!' && (await lose.textContent('#otitle')) === 'You lost the match', [await win.textContent('#otitle'), await lose.textContent('#otitle')]);
  ok('no countdown once it is decided', (await win.textContent('#omatch .omcount')).trim() === '' && (await win.textContent('#oRematch')) === 'New match');
  await shot(win, '4-match-won');

  console.log('live list');
  await api('rematch', { code }, ann); await api('rematch', { code }, bob);
  const C = await open(await su('cat'), { width: 1280, height: 860 });
  await C.goto(`http://localhost:${PORT}/`);
  await C.waitForSelector('#livelist .mtag');
  ok('a match in progress shows its score in Live games', /Bo3 · 0–0/.test(await C.textContent('#livelist .mtag')), await C.textContent('#livelist .mtag'));

  console.log('pass & play match');
  C.on('dialog', (d) => d.accept());
  await C.click('#modeLocal');
  ok('the format picker is there in pass & play', await C.isVisible('#fmtPick'));
  if (await C.isChecked('#localRated')) await C.click('#localRated');
  await C.fill('#localW', 'Kim'); await C.fill('#localB', 'Lee');
  await C.click('#fmtPick [data-f="bo3"]');
  ok('the start button says match', (await C.textContent('#localStart')) === 'Start pass & play match');
  await C.click('#localStart');
  await C.waitForFunction(() => snap && snap.local && snap.match);
  ok('the match panel shows', await C.isVisible('#matchpanel') && /Game 1 of 3/.test(await C.textContent('#mpSub')));
  const lplay = (ucis) => C.evaluate((u) => { for (const x of u) { const m = Chess.findUci(botGame.state, x); botHumanMove(m.from, m.to, m.promo); } }, ucis);
  await lplay(MATE);                                               // Kim (white) mates
  await C.waitForSelector('#over:not(.hidden) #omatch:not(.hidden)');
  ok('game 1 scored for Kim', /Kim\s*1\s*–\s*Lee\s*0/.test(await C.textContent('#omatch .omscore')), await C.textContent('#omatch .omscore'));
  ok('match point for Kim, by name', /Match point for Kim/.test(await C.textContent('#omatch')), await C.textContent('#omatch'));
  ok('the next game counts down', /Next game in \d+s/.test(await C.textContent('#omatch .omcount')));
  await shot(C, '5-local-after-game1');
  await C.reload();                                                // a reload between games keeps the match
  await C.waitForSelector('#lobby:not(.hidden)');
  await C.click('#modeLocal');
  ok('the lobby offers the match to resume', /Best of 3: Kim 1 – Lee 0/.test(await C.textContent('#localResumeText')), await C.textContent('#localResumeText'));
  await C.click('#localResumeBtn');
  await C.waitForFunction(() => snap && snap.local && snap.match && snap.players.w.name === 'Lee');
  ok('game 2: colours swapped, score kept', /Game 2 of 3/.test(await C.textContent('#mpSub')));
  await lplay(MATE);                                               // Lee (white) mates: 1–1
  await C.waitForSelector('#over:not(.hidden) #omatch:not(.hidden)');
  await C.click('#oRematch');
  await C.waitForFunction(() => snap && !snap.status.over && snap.players.w.name === 'Kim');
  await lplay(['g1f3', 'g8f6']);
  ok('pass & play has a draw button', await C.isVisible('#drawBtn'));
  await C.click('#drawBtn');                                       // the dialog is accepted: both agree
  await C.waitForSelector('#over:not(.hidden) #omatch:not(.hidden)');
  ok('level: Armageddon next', /Armageddon/.test(await C.textContent('#omatch')), await C.textContent('#omatch'));
  await C.click('#oRematch');
  await C.waitForFunction(() => snap && snap.arma && !snap.status.over);
  const lclocks = await C.$$eval('.clock', (x) => x.map((e) => e.textContent).sort());
  ok('Armageddon clocks in pass & play', lclocks.join() === '4:00,5:00', lclocks);
  await lplay(['g1f3', 'g8f6']); await C.click('#drawBtn');
  await C.waitForFunction(() => snap.match.done && /match/.test(document.querySelector('#otitle').textContent));
  ok('Black (Kim) takes it on the draw', (await C.textContent('#otitle')) === 'Kim wins the match!', await C.textContent('#otitle'));
  ok('then a new match', (await C.textContent('#oRematch')) === 'New match');
  await shot(C, '6-local-match-won');
  await C.click('#oRematch');
  await C.waitForFunction(() => snap && snap.match && snap.match.no === 2 && !snap.match.games.length);
  ok('the new match starts at 0–0', true);

  await br.close(); srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
