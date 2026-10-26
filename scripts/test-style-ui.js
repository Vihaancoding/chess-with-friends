// "Play against a style" UI tests: plays real games through the API, then in a headless browser builds a friend's
// playstyle profile, plays their clone, and checks the post-game comparison, on a desktop and a phone-sized screen.
// Run: node scripts/test-style-ui.js          (needs Playwright: npm i -g playwright, or NODE_PATH pointing at it)
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 4020 + Math.floor(Math.random() * 9), BASE = `http://localhost:${PORT}`;
let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };
const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: path.join(process.env.SHOTS, name + '.png'), fullPage: true }) : null);   // SHOTS=dir to look at the pages
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => {
  const r = await fetch(`${BASE}/api?r=${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) });
  return { status: r.status, ...(await r.json()) };
};
const sq = (q) => 'abcdefgh'.indexOf(q[0]) + (8 - +q[1]) * 8;
async function game(w, b, tc, ucis, loser) {
  const c = await api('create', { color: 'w', tc }, w);
  await api('join', { code: c.code }, b);
  for (const [i, u] of ucis.entries()) {
    const r = await api('move', { code: c.code, from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)) }, i % 2 ? b : w);
    if (r.status !== 200) throw new Error(`${u}: ${r.error}`);
  }
  if (loser) await api('resign', { code: c.code }, loser);
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, SUPABASE_URL: '' }, stdio: 'ignore' });
  await sleep(800);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const alice = await su('alice'), bob = await su('bob'), newbie = await su('newbie');
  // bob always opens 1.e4 as White and answers 1.d4 with the Englund
  const ITALIAN = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'c2c3', 'g8f6', 'd2d3', 'd7d6', 'e1g1', 'e8g8'];
  await game(bob, alice, { base: 300, inc: 0 }, ITALIAN, alice);
  await game(bob, alice, { base: 180, inc: 2 }, ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7']);
  await game(alice, bob, null, ['d2d4', 'e7e5', 'd4e5', 'b8c6', 'g1f3', 'd8e7', 'c1f4', 'e7b4', 'f4d2', 'b4b2'], alice);
  await game(bob, alice, { base: 600, inc: 0 }, ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6'], alice);
  for (let i = 0; i < 60 && (await api('style_games', { name: 'bob' }, bob)).games.length < 4; i++) await sleep(50);

  const br = await chromium.launch();
  for (const [label, viewport] of [['desktop', { width: 1280, height: 860 }], ['phone', { width: 390, height: 800 }]]) {
    console.log(`\n${label}`);
    const page = await br.newPage({ viewport });
    page.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); });
    await page.route(/cdn\.jsdelivr\.net/, (r) => r.abort());
    await page.addInitScript((u) => localStorage.setItem('chess:user', JSON.stringify(u)), alice);
    await page.goto(BASE + '/');
    await page.waitForSelector('#lobby:not(.hidden)');

    // ----- the profile -----
    await page.click('#modeClone');
    ok('clone tab opens with your own name filled in', (await page.inputValue('#clName')) === 'alice' && await page.isVisible('#cloneOnly'));
    await page.fill('#clName', 'newbie'); await page.click('#clLoad');
    await page.waitForFunction(() => /no archived games/.test($('#clStatus').textContent));
    ok('a player with no games gets told why', !(await page.isVisible('#clPlay')));
    await page.fill('#clName', 'nobody'); await page.click('#clLoad');
    await page.waitForFunction(() => /no player called/.test($('#clStatus').textContent));
    ok('unknown player', true);
    await page.fill('#clName', 'Bob'); await page.click('#clLoad');
    await page.waitForSelector('#clPlay:not(.hidden)', { timeout: 60000 });
    const prof = await page.evaluate(() => ({ text: $('#clProfile').innerText, status: $('#clStatus').textContent, btn: $('#clStart').textContent, P: CL.P }));
    ok('profile built from the 4 games', /Built from 4 games/.test(prof.status) && prof.P.name === 'bob', prof.status);
    ok('summary tags and style bars', prof.P.tags.length >= 2 && /Aggression/.test(prof.text) && /Tactical/.test(prof.text) && /Risk-taking/.test(prof.text), prof.text);
    await page.click('#clProfile summary');
    const full = await page.innerText('#clProfile');
    ok('full profile: openings as White and Black', /Openings as White/i.test(full) && /Italian Game/.test(full) && /1\.e4 \(3\)/.test(full) && /vs 1\.d4: 1…e5/.test(full), full);
    ok('full profile: tactics, endgames, habits, time', /Tactics they use/i.test(full) && /Checkmate/.test(full) && /Endgames they reach/i.test(full) && /Castles/.test(full) && /Average per move/.test(full), full);
    ok("someone else's weak spots are hidden", /only shown to them/.test(full) && /Only bob can see this/.test(full) && !/Blunders/.test(full) && !/Moves in time trouble/.test(full) && !/accuracy/i.test(full) && !/1× · 100%/.test(full) && !/Blunder-prone|Gets into time trouble/.test(full), full);
    await shot(page, label + '-profile');
    ok('says how well the model fits (or why it can\'t test yet)', /predicted exactly|Play 5\+ games for an accuracy test|Not enough analysed moves/.test(prof.text), prof.text);
    ok('play button names the friend', prof.btn === "Play bob's clone", prof.btn);
    ok('profile is cached on this device', await page.evaluate(() => !!localStorage.getItem('chess:style:bob')));
    ok('no horizontal page scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));

    // ----- the game -----
    await page.click('#clDiff [data-d="sharp"]');
    ok('difficulty picker', /deep tactics/.test(await page.textContent('#clDiffDesc')));
    ok('move speed defaults to realistic', await page.evaluate(() => $('#clSpeed [data-s="real"]').classList.contains('on')) && /as long as they/.test(await page.textContent('#clSpeedDesc')));
    await page.click('#clSpeed [data-s="instant"]');
    ok('instant can be picked (and is remembered)', /as soon as it has picked/.test(await page.textContent('#clSpeedDesc')) && await page.evaluate(() => localStorage.getItem('chess:cloneSpeed') === 'instant'));
    await page.click('#colorRow [data-c="b"]');
    await page.click('#tcgrid [data-v="0,0"]');
    await page.click('#clStart');
    await page.waitForFunction(() => isClone() && botGame.moves.length >= 1, null, { timeout: 15000 });
    const g = await page.evaluate(() => ({ first: botGame.moves[0], why: botGame.clone.why, top: $('#top').innerText, panel: $('#clonepanel').innerText, hidden: $('#clonepanel').classList.contains('hidden'), sub: $('#sub').textContent }));
    ok("the clone opens with bob's 1.e4 from his book", g.first === 'e4' && g.why === 'book', g);
    ok('opponent shown as bob\'s bot with his rating', /bob's bot/.test(g.top) && !g.hidden && /bob's bot · On form/.test(g.panel), g);
    ok('status names the difficulty', /On form/.test(g.sub), g.sub);
    const sp = await page.evaluate(() => ({ speed: botGame.clone.speed, btn: $('#clpSpeed').textContent, wait: cloneThink(botGame, 5000) }));
    ok('the game starts at instant speed: no waiting', sp.speed === 'instant' && sp.btn === 'Instant moves' && sp.wait === 0, sp);
    await page.click('#clpSpeed');
    const sp2 = await page.evaluate(() => ({ speed: botGame.clone.speed, btn: $('#clpSpeed').textContent, wait: cloneThink(botGame, 5000) }));
    ok('switch to realistic mid-game: it takes the time the player would', sp2.speed === 'real' && sp2.btn === 'Realistic speed' && sp2.wait === 5000, sp2);
    // a reply already waiting is cut short by switching to instant
    const cut = await page.evaluate(() => new Promise((res) => {
      const b = botGame; let fired = 0;
      b.go = () => { clearTimeout(b.wait); b.go = null; fired++; }; b.wait = setTimeout(b.go, 10000);
      $('#clpSpeed').click(); setTimeout(() => res({ fired, speed: b.clone.speed }), 50);
    }));
    ok('switching to instant ends a wait that is already running', cut.fired === 1 && cut.speed === 'instant', cut);
    // answer 1…e5 and let it reply from its book again (Nf3 in bob's Italian, or Bc4)
    await page.evaluate(() => botHumanMove(12, 28));
    await page.waitForFunction(() => botGame.moves.length >= 3, null, { timeout: 15000 });
    const second = await page.evaluate(() => ({ m: botGame.moves[2], why: botGame.clone.why }));
    ok('second move also from his repertoire', ['Nf3', 'Bc4'].includes(second.m) && second.why === 'book', second);
    await page.evaluate(() => botHumanMove(1, 18));
    await page.waitForFunction(() => botGame.moves.length >= 5, null, { timeout: 15000 });
    // the game is saved and can be resumed
    ok('game in progress is saved, with its speed', await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('chess:clone')); return d && d.clone.name === 'bob' && d.clone.diff === 'sharp' && d.clone.speed === 'instant' && d.hist.length === 5; }));

    // ----- resign: the comparison -----
    if (label === 'phone') await page.route(/r=clone_played/, (r) => r.abort());   // the alert can't get through: it must wait on the device
    await page.evaluate(() => botEnd('w', 'resignation'));
    await page.waitForFunction(() => botGame.clone.cmp && botGame.clone.cmp.report, null, { timeout: 30000 });
    const rep = await page.innerText('#clonepanel');
    await page.click('#oClose'); await shot(page, label + '-comparison');
    ok('style match score', /\d+%\s*style match/.test(rep), rep);
    ok('predicted share of your moves', /predicted \d+ of 2 of your moves/.test(rep), rep);
    ok('you vs the bot table: aggression, tactics, risk, accuracy, blunders', /You vs bob's bot/i.test(rep) && /Aggression/.test(rep) && /Tactical/.test(rep) && /Risk-taking/.test(rep) && /Accuracy/.test(rep) && /Blunders/.test(rep) && /bob usually/i.test(rep), rep);
    ok("bob's usual mistake rates are hidden in the comparison", /Blunders\s+\d+\s+\d+\s+hidden/.test(rep), rep);
    ok('who was more aggressive', /more aggressively|about equally aggressive/.test(rep), rep);
    ok('opening choices', /This game/.test(rep) && /Bot followed bob's repertoire/.test(rep), rep);
    ok('tactical tendencies', /Tactical tendencies/i.test(rep) && /Forcing moves/.test(rep), rep);
    ok('moments: predicted or differed', /bob would have played that too|Where your decisions differed/i.test(rep), rep);
    ok('over card says not rated', /Not rated/.test(await page.innerText('#over')));
    ok('over card says bob will be told', /bob gets a note that you played their clone/.test(await page.innerText('#over')), await page.innerText('#over'));
    const moment = await page.$('#clonepanel [data-ply]');
    if (moment) { await moment.click(); ok('click a moment to see the position', await page.evaluate(() => viewPly !== null)); }
    ok('saved game cleared once it ended', await page.evaluate(() => !localStorage.getItem('chess:clone')));
    ok('no horizontal scroll on the game screen', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      await page.evaluate(() => [document.documentElement.scrollWidth, [...document.querySelectorAll('#game *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && e.offsetParent).slice(0, 5).map((e) => e.tagName + '#' + e.id + '.' + e.className)]));

    if (label === 'phone') {
      await page.waitForFunction(() => unsentClones().length === 1, null, { timeout: 8000 });
      ok('a failed alert is kept on the device', (await api('me', {}, bob)).clones[0].games === 1);
      await page.unroute(/r=clone_played/);
      await page.evaluate(() => { $('#over').classList.add('hidden'); enterLobby(); });
      await page.waitForFunction(() => unsentClones().length === 0, null, { timeout: 8000 });
      ok('…and sent when they go back to the lobby', true);
    }
    let told = null;
    for (let i = 0; i < 40 && !told; i++) { const me = await api('me', {}, bob); told = me.clones && me.clones[0]; if (!told) await sleep(100); }
    ok('bob gets an alert: alice, resignation, On form', told && told.from === 'alice' && told.reason === 'resignation' && told.diff === 'sharp' && told.result === 'w' && told.games === (label === 'desktop' ? 1 : 2), told);
    // ----- from a profile page -----
    await page.evaluate(() => enterProfile('bob'));
    await page.waitForSelector('#pfClone');
    await page.click('#pfClone');
    await page.waitForSelector('#clPlay:not(.hidden)', { timeout: 30000 });
    ok('"Play their style" on a profile opens the clone tab with that player (cached profile)', (await page.inputValue('#clName')) === 'bob' && /Built from 4 games/.test(await page.textContent('#clStatus')));
    // your own profile shows everything
    await page.fill('#clName', 'alice'); await page.click('#clLoad');
    await page.waitForFunction(() => CL.P && CL.P.name === 'alice' && !$('#clPlay').classList.contains('hidden'), null, { timeout: 60000 });
    await page.click('#clProfile summary');
    const mineFull = await page.innerText('#clProfile');
    ok('your own profile shows your weak spots', /Blunders/.test(mineFull) && /Moves in time trouble/.test(mineFull) && /accuracy/i.test(mineFull) && /× · \d+%/.test(mineFull) && !/Only alice can see this/.test(mineFull), mineFull);
    await page.close();
  }
  // ----- bob sees it in his lobby -----
  console.log('\nthe player whose clone it was');
  const bp = await br.newPage({ viewport: { width: 1280, height: 860 } });
  bp.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); });
  await bp.route(/cdn\.jsdelivr\.net/, (r) => r.abort());
  await bp.addInitScript((u) => localStorage.setItem('chess:user', JSON.stringify(u)), bob);
  await bp.goto(BASE + '/');
  await bp.waitForSelector('#cloneBanners .banner');
  const ban = await bp.innerText('#cloneBanners');
  ok('lobby banner: alice played your clone 2 times, latest game lost to it by resignation', /alice played your clone 2 times\. Latest game \(On form\): they lost to it by resignation/.test(ban) && /Challenge alice/.test(ban), ban);
  await bp.click('#cloneBanners [data-c="dismiss"]');
  await sleep(300);
  ok('OK dismisses it for good', (await bp.$$('#cloneBanners .banner')).length === 0 && (await api('me', {}, bob)).clones.length === 0);
  // a live alert while bob is elsewhere on the site
  await bp.click('#navProfile'); await bp.waitForSelector('#profile:not(.hidden)');
  await api('clone_played', { name: 'bob', gid: 'live1', color: 'w', diff: 'true', moves: ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'] }, alice);
  await bp.waitForFunction(() => $('#chatToast').classList.contains('show'), null, { timeout: 8000 }).catch(() => {});
  ok('pop-up when bob is elsewhere on the site', /alice played your clone/.test(await bp.innerText('#chatToast')), await bp.innerText('#chatToast'));
  await bp.close();
  await br.close(); srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
