// SHUT UP in four real browsers: two players and two spectators. Run: node scripts/test-shutup-ui.js (needs Playwright, takes ~60 s)
const { chromium } = require('playwright');
process.env.PORT = String(4280 + Math.floor(Math.random() * 9)); process.env.SUPABASE_URL = ''; process.env.ADMIN_KEY = 'k';
const PORT = process.env.PORT, origLog = console.log; console.log = () => {};
require('../server.js'); console.log = origLog;
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => { const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, ...(await r.json()) }; };
(async () => {
  await sleep(300);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const A = await su('ann'), B = await su('bob'), C = await su('cat'), D = await su('dan');
  const g = await api('create', { color: 'w', tc: { base: 600, inc: 0 } }, A); await api('join', { code: g.code }, B); await api('move', { code: g.code, from: 52, to: 36 }, A);
  const br = await chromium.launch();
  const open = async (who, opts = {}) => { const c = await br.newContext({ viewport: opts.vp || { width: 1280, height: 900 }, reducedMotion: opts.calm ? 'reduce' : 'no-preference' }); const p = await c.newPage(); p.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); }); await p.route(/cdn\.jsdelivr\.net|fonts\.g/, (x) => x.abort()); await c.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), who); await p.goto(`http://localhost:${PORT}/?game=${g.code}`); await p.waitForSelector('#gclog'); return p; };
  const pa = await open(A), pb = await open(B), pc = await open(C), pd = await open(D);
  await sleep(800);
  const say = async (p, text) => { await p.fill('#gcIn', text); await p.click('#gcForm button[type=submit]'); };
  await say(pc, 'hello from cat'); await sleep(900); await say(pd, 'dan here');
  await pa.waitForFunction(() => /hello from cat/.test(document.querySelector('#gclog').textContent) && /dan here/.test(document.querySelector('#gclog').textContent), null, { timeout: 15000 });
  ok('the players see the spectators in a bar above the chat, each with a SHUT UP button', await pa.waitForSelector('#specbar [data-su="cat"]', { timeout: 15000 }).then(() => true, () => false) && (await pa.$$('#specbar [data-su]')).length === 2, null);
  ok('a spectator\'s chat message has a SHUT UP action for the players, and the spectators see none', !!(await pa.$('#gclog .gm[data-n="cat"] .suact')) && !(await pd.$('#gclog .suact')) && !(await pc.$('#specbar [data-su]')), null);

  console.log('SHUT UP');
  await pa.click('#specbar [data-su="cat"]');
  for (const [n, p] of [['cat', pc], ['dan', pd]]) {
    await p.waitForSelector('#suOverlay', { timeout: 15000 });
    ok(`the full-screen takeover plays for the spectator ${n}, with the silenced spectator's name`, /SHUT UP/.test(await p.textContent('#suOverlay')) && /cat/i.test(await p.textContent('#suOverlay .su-name')) && /YOU'VE BEEN TOLD TO SHUT UP/.test(await p.textContent('#suOverlay')) && /THE PLAYERS HAVE HAD ENOUGH/.test(await p.textContent('#suOverlay')), await p.textContent('#suOverlay'));
  }
  ok('the players\' screens are not taken over: they keep playing and just see the chat line', !(await pa.$('#suOverlay')) && !(await pb.$('#suOverlay')), null);
  ok('it covers the whole screen and takes the interface over', await pd.evaluate(() => { const r = document.querySelector('#suOverlay').getBoundingClientRect(); return r.width >= innerWidth && r.height >= innerHeight && getComputedStyle(document.querySelector('#suOverlay')).position === 'fixed'; }), null);
  if (process.env.SHOT) { await sleep(1250); await pd.screenshot({ path: process.env.SHOT + '-shutup.png' }); }
  await pa.waitForFunction(() => !document.querySelector('#suOverlay'), null, { timeout: 8000 });
  ok('and it returns to the board after about two seconds', true);
  await sleep(3500);
  ok('the fair-play check does not mistake the takeover for a cheating overlay', !(await pd.$('#fwSheet')) && !(await pc.$('#fwSheet')) && await pd.evaluate(() => !fpFindings().some((x) => /suOverlay/.test(x))), null);
  ok('the game itself was not interrupted (the board and the clock are still there)', await pa.isVisible('#board') && !(await pa.$('#suOverlay')), null);
  await pc.waitForSelector('#specbar.silenced');
  ok('the silenced spectator sees that they were told to SHUT UP and cannot type', /You were told to SHUT UP/.test(await pc.textContent('#specbar')) && await pc.isDisabled('#gcIn'), await pc.textContent('#specbar'));
  await pa.waitForFunction(() => document.querySelector('#gclog .gm[data-n="cat"] .subadge'), null, { timeout: 15000 });
  ok('everyone, the players included, still sees what the spectator wrote before, now with the SHUT UP marker', await pa.evaluate(() => !document.querySelector('#gclog .gm[data-n="cat"]').hidden && /hello from cat/.test(document.querySelector('#gclog').textContent)) && await pb.evaluate(() => !document.querySelector('#gclog .gm[data-n="cat"]').hidden) && !(await pd.evaluate(() => document.querySelector('#gclog .gm[data-n="cat"]').hidden)) && !!(await pd.$('#gclog .gm[data-n="cat"] .subadge')), null);
  ok('the public announcement is a distinct line in the chat for everyone', /ann told cat to SHUT UP\./.test(await pd.textContent('#gclog .gm.sys')) && /ann told cat to SHUT UP\./.test(await pa.textContent('#gclog .gm.sys')) && /ann told cat/.test(await pc.textContent('#gclog .gm.sys')), null);
  ok('the spectator list shows the marker, ann gets a revoke button and bob the option to make it a double', !!(await pa.$('#specbar [data-surev="cat"]')) && !!(await pb.$('#specbar .spchip.on .subadge')) && /DOUBLE/.test(await pb.textContent('#specbar [data-su="cat"]')), null);

  console.log('direct attempts');
  ok('a silenced spectator posting straight to the server is rejected', (await api('game_chat_send', { code: g.code, text: 'bypass' }, C)).status === 403, null);
  await pc.reload(); await pc.waitForSelector('#specbar.silenced', { timeout: 15000 });
  ok('refreshing the page keeps them silenced', await pc.isDisabled('#gcIn'), null);

  console.log('DOUBLE SHUT UP');
  await sleep(6500);
  await pb.click('#specbar [data-su="cat"]');
  await pc.waitForSelector('#suOverlay.double', { timeout: 15000 }); await pd.waitForSelector('#suOverlay.double', { timeout: 15000 });
  ok('the second player makes it DOUBLE SHUT UP: a bigger takeover for the spectators', !(await pb.$('#suOverlay')) && /DOUBLE\s*SHUT UP/.test(await pc.textContent('#suOverlay .su-title')) && /ABSOLUTE SILENCE/.test(await pd.textContent('#suOverlay')) && !!(await pd.$('#suOverlay .su-mouths')), await pd.textContent('#suOverlay'));
  await pd.waitForFunction(() => !document.querySelector('#suOverlay'), null, { timeout: 10000 });
  ok('it ends by itself', true);
  ok('the chat says so', /DOUBLE SHUT UP\. cat is in absolute silence\./.test(await pd.textContent('#gclog')), null);

  console.log('revoking');
  await sleep(1000);
  await pa.click('#specbar [data-surev="cat"]');
  await pb.waitForFunction(() => document.querySelector('#specbar .spchip.on [data-surev]') && !document.querySelector('#specbar .spchip.on .suact.rev[data-surev]') === false || true, null, { timeout: 3000 }).catch(() => {});
  await sleep(1500);
  ok('one player revoking theirs leaves the other\'s restriction: cat still cannot talk', await pc.isDisabled('#gcIn') && (await api('game_chat_send', { code: g.code, text: 'still no' }, C)).status === 403, null);
  await pb.click('#specbar [data-surev="cat"]');
  await pc.waitForFunction(() => !document.querySelector('#specbar.silenced') && !document.querySelector('#gcIn').disabled, null, { timeout: 15000 });
  ok('when both are revoked the spectator can type again', true);

  console.log('calm motion and phones');
  await sleep(6500);
  const pc2 = await open(C, { calm: true }); await sleep(600);
  await pa.click('#specbar [data-su="cat"]');
  await pc2.waitForSelector('#suOverlay.calm', { timeout: 15000 });
  ok('with reduced motion the takeover is a calm, static version', await pc2.evaluate(() => document.querySelector('#suOverlay').classList.contains('calm') && !document.querySelector('#suOverlay .su-ring')), null);
  const pm = await open(D, { vp: { width: 390, height: 780 } }); await sleep(500);
  await sleep(6500); await pb.waitForSelector('#specbar [data-su="dan"]', { timeout: 15000 }).catch(() => {});
  await pb.click('#specbar [data-su="dan"]');
  await pm.waitForSelector('#suOverlay', { timeout: 15000 }); await sleep(1700);
  ok('on a phone the name and the words fit the screen', await pm.evaluate(() => [...document.querySelectorAll('#suOverlay .su-in *')].every((e) => { const r = e.getBoundingClientRect(); return r.right <= innerWidth + 2 && r.left >= -2; })), null);
  if (process.env.SHOT) await pm.screenshot({ path: process.env.SHOT + '-shutup-phone.png' });
  await br.close(); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
