// KING OF THE SERVER in two browsers: the crown beside the name, the Kingslayer cinematic for everyone online, never during your own
// game (it waits until the game is over), the frenzy countdown agreeing across clients, the pinned feed card, skip, and no replay on
// reload. Run: node scripts/test-king-ui.js (needs Playwright). SHOT=/path/prefix saves screenshots.
const { chromium } = require('playwright');
process.env.PORT = String(4300 + Math.floor(Math.random() * 9)); process.env.SUPABASE_URL = ''; process.env.ADMIN_KEY = 'k';
const PORT = process.env.PORT, origLog = console.log; console.log = () => {};
require('../server.js'); console.log = origLog;
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => { const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) }); return r.json(); };
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
const MV = ['e2e4', 'a7a6', 'f1c4', 'a6a5', 'd1h5', 'a5a4', 'a2a3', 'b7b6', 'h2h3', 'b6b5', 'h5f7'];
(async () => {
  await sleep(300);
  const P = {}; for (const n of ['ann', 'bob', 'cat', 'dan', 'eve', 'fay', 'gus', 'hal']) { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); P[n] = { name: r.name, token: r.token }; }
  const win = async (w, b) => { const g = await api('create', { color: 'w', tc: { base: 600, inc: 0 } }, P[w]); await api('join', { code: g.code }, P[b]); for (let i = 0; i < MV.length; i++) await api('move', { code: g.code, from: sq(MV[i].slice(0, 2)), to: sq(MV[i].slice(2, 4)) }, i % 2 ? P[b] : P[w]); await sleep(300); return g.code; };
  for (const o of ['bob', 'cat', 'dan', 'eve', 'fay']) await win('ann', o);         // ann: 5 in a row, King of the Server

  const br = await chromium.launch();
  const open = async (who, url) => {
    const ctx = await br.newContext({ viewport: { width: 1280, height: 900 } }), p = await ctx.newPage();
    p.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); }); await p.route(/cdn\.jsdelivr\.net|fonts\.g/, (x) => x.abort());
    await ctx.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), P[who]);
    await p.goto(`http://localhost:${PORT}/${url || ''}`); return p;
  };
  const lobby = await open('cat');
  await lobby.waitForSelector('#shcard', { timeout: 15000 }); await sleep(2500);
  const crown = await lobby.evaluate(() => { const e = [...document.querySelectorAll('.plink')].find((x) => x.dataset.name === 'ann'); return e ? getComputedStyle(e, '::after').backgroundImage : null; });
  ok('the King wears a crown beside their name', crown && /svg/.test(crown), crown);

  // gus is in the middle of a game against eve
  const live = await api('create', { color: 'w', tc: { base: 600, inc: 0 } }, P.gus); await api('join', { code: live.code }, P.eve);
  await api('move', { code: live.code, from: sq('e2'), to: sq('e4') }, P.gus); await api('move', { code: live.code, from: sq('e7'), to: sq('e5') }, P.eve);
  const player = await open('gus', `?game=${live.code}`); await player.waitForSelector('#board .sq');
  // hal watches a 1-minute game between dan and fay: a time scramble
  const sc = await api('create', { color: 'w', tc: { base: 60, inc: 0 } }, P.dan); await api('join', { code: sc.code }, P.fay);
  await api('move', { code: sc.code, from: sq('e2'), to: sq('e4') }, P.dan); await api('move', { code: sc.code, from: sq('e7'), to: sq('e5') }, P.fay);
  const watcher = await open('hal', `?game=${sc.code}`); await watcher.waitForSelector('#board .sq'); await sleep(1500);

  await win('bob', 'ann');                                                         // bob, with no streak, beats the King
  await lobby.waitForSelector('#kingFx.ks', { timeout: 10000 }).catch(() => {});
  const txt = (await lobby.textContent('#kingFx').catch(() => '')) || '';
  ok('everyone online sees the Kingslayer cinematic', /AN UPSET FOR THE AGES/.test(txt) && /THE KINGSLAYER/.test(txt) && /bob/.test(txt) && /ann/.test(txt), txt);
  await sleep(2350); if (process.env.SHOT) await lobby.screenshot({ path: process.env.SHOT + '-ks-impact.png' });
  await sleep(850); if (process.env.SHOT) await lobby.screenshot({ path: process.env.SHOT + '-kingslayer.png' });
  ok('a player mid-game is not interrupted', !(await player.$('#kingFx')));
  ok('nor is someone watching a game in a time scramble (under 2 minutes)', !(await watcher.$('#kingFx')));
  await sleep(3500);
  ok('it ends by itself in about 6 seconds', !(await lobby.$('#kingFx')));
  const [t1, t2] = [await lobby.textContent('#navFrenzy .fz-t'), await player.textContent('#navFrenzy .fz-t')];
  const secs = (t) => { const [m, s] = t.split(':').map(Number); return m * 60 + s; };
  ok('the frenzy countdown shows on both clients and agrees', (await lobby.isVisible('#navFrenzy')) && Math.abs(secs(t1) - secs(t2)) <= 1 && secs(t1) > 100, [t1, t2]);
  ok('the event is pinned in the feed with a link to the game', /AN UPSET FOR THE AGES/.test(await lobby.textContent('#shFeed .kpin')) && !!(await lobby.$('#shFeed .kpin [data-shg]')), null);
  const sword = await lobby.evaluate(() => { const e = [...document.querySelectorAll('.plink')].find((x) => x.dataset.name === 'bob'); return e ? getComputedStyle(e, '::after').backgroundImage : null; });
  ok('bob now carries the Kingslayer mark', sword && /svg/.test(sword), sword);
  if (process.env.SHOT) await lobby.screenshot({ path: process.env.SHOT + '-frenzy.png' });

  await api('resign', { code: live.code }, P.eve);                                // gus's game ends: now he sees it
  await player.waitForSelector('#kingFx', { timeout: 10000 }).catch(() => {});
  ok('the player sees it once their game is over', !!(await player.$('#kingFx')));
  await player.click('#kingFx .kf-skip').catch(() => {}); await sleep(600);
  ok('it can be skipped', !(await player.$('#kingFx')));

  await api('resign', { code: sc.code }, P.fay);                                  // the scramble ends: the watcher sees it
  await watcher.waitForSelector('#kingFx', { timeout: 10000 }).catch(() => {});
  ok('the watcher sees it once the scramble is over', !!(await watcher.$('#kingFx')));
  if (process.env.SHOT) {                                                         // frames of a normal fall, played as a replay
    await lobby.evaluate(() => kingPlay({ id: 'x', type: 'fall', fallen: 'cat', streak: 9, by: 'dan', heir: 'eve', heirStreak: 7 }, true));
    await sleep(1450); await lobby.screenshot({ path: process.env.SHOT + '-fall-impact.png' });
    await sleep(3300); await lobby.screenshot({ path: process.env.SHOT + '-fall-end.png' });
    await sleep(1500);
  }
  await lobby.reload(); await sleep(3500);
  ok('reloading does not play it again', !(await lobby.$('#kingFx')));
  ok('...but the frenzy is still on after the reload', await lobby.isVisible('#navFrenzy'));
  await br.close(); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
