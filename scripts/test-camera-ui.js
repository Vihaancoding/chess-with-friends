// Camera / Chat tabs: two real browsers with fake cameras connect over WebRTC. Run: node scripts/test-camera-ui.js (needs Playwright)
const { chromium } = require('playwright');
process.env.PORT = String(4150 + Math.floor(Math.random() * 9)); process.env.SUPABASE_URL = ''; process.env.ADMIN_KEY = 'k';
const PORT = process.env.PORT, origLog = console.log; console.log = () => {};
require('../server.js'); console.log = origLog;
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => { const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, ...(await r.json()) }; };
(async () => {
  await sleep(300);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = {}; for (const n of ['ann', 'bob', 'cat']) P[n] = await su(n);
  const g = await api('create', { color: 'w', tc: { base: 300, inc: 0 } }, P.ann); await api('join', { code: g.code }, P.bob);

  console.log('the server');
  ok('a spectator cannot send video signals', (await api('cam_signal', { code: g.code, t: 'who' }, P.cat)).status === 403, null);
  ok('a player can, and bad types are refused', (await api('cam_signal', { code: g.code, t: 'who' }, P.ann)).ok && (await api('cam_signal', { code: g.code, t: 'nope' }, P.ann)).status === 400, null);
  ok('spectators cannot read or write the chat while the game is on', (await api('game_chat', { code: g.code }, P.cat)).status === 403 && (await api('game_chat_send', { code: g.code, text: 'hi' }, P.cat)).status === 403, null);
  ok('the players can chat', (await api('game_chat_send', { code: g.code, text: 'hello bob' }, P.ann)).ok && (await api('game_chat', { code: g.code }, P.bob)).msgs.length === 1, null);

  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
  const br = await chromium.launch({ args });
  const open = async (u, perms = ['camera']) => { const ctx = await br.newContext({ viewport: { width: 1280, height: 900 }, permissions: perms }); const p = await ctx.newPage(); p.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); }); await p.route(/cdn\.jsdelivr\.net/, (r) => r.abort()); await ctx.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), u); return p; };
  const A = await open(P.ann), B = await open(P.bob);
  for (const p of [A, B]) await p.goto(`http://localhost:${PORT}/?game=${g.code}`);
  await A.waitForSelector('#tabCam:not(.hidden)'); await B.waitForSelector('#tabCam:not(.hidden)');
  ok('both players have CAMERA and CHAT tabs, chat is the default', (await A.getAttribute('#tabChat', 'aria-selected')) === 'true' && (await A.isVisible('#gclog')), null);
  const spec = await open(P.cat); await spec.goto(`http://localhost:${PORT}/?game=${g.code}`); await sleep(1200);
  ok('a spectator sees no CAMERA tab and the chat box is off', !(await spec.isVisible('#tabCam')) && (await spec.isDisabled('#gcIn')), null);

  console.log('camera');
  await A.click('#tabCam'); await B.click('#tabCam');
  ok('the camera tab shows two tiles, camera off, the board stays visible', (await A.isVisible('#camPane')) && /Camera off/.test(await A.textContent('#camMe')) && (await A.isVisible('#board, #boardwrap')), null);
  await A.click('#camToggle');
  await A.waitForSelector('#camMe.live');
  ok('turning on my camera shows my preview', (await A.textContent('#camToggle')) === 'Turn camera off', null);
  await B.waitForSelector('#camOpp.live', { timeout: 20000 });
  await B.waitForFunction(() => document.querySelector('#camOpp video').videoWidth > 0, null, { timeout: 20000 });
  ok('the opponent sees my video (WebRTC, one-way: their camera is off)', true);
  await B.click('#camToggle'); await B.waitForSelector('#camMe.live'); await A.waitForSelector('#camOpp.live', { timeout: 20000 });
  ok('both cameras on: each sees the other', true);
  if (process.env.SHOT) { await sleep(800); await A.screenshot({ path: process.env.SHOT + '-desktop.png' }); await A.setViewportSize({ width: 390, height: 844 }); await sleep(500); await A.screenshot({ path: process.env.SHOT + '-phone.png', fullPage: true }); await A.setViewportSize({ width: 1280, height: 900 }); }
  const media = await A.evaluate(() => ({ audioTracks: CAM.stream.getAudioTracks().length, kinds: CAM.pc.getTransceivers().map((t) => t.receiver.track.kind + '/' + (t.sender.track ? t.sender.track.kind : '-')), max: CAM.pc.getSenders().map((s) => s.getParameters().encodings[0].maxBitrate) }));
  ok('no audio anywhere: no audio track, only video senders and receivers', media.audioTracks === 0 && media.kinds.every((k) => k === 'video/video'), media);
  ok('the bitrate is capped low', media.max.every((m) => m && m <= 150000), media.max);

  console.log('chat and tabs');
  await api('game_chat_send', { code: g.code, text: 'gg so far' }, P.bob); await sleep(800);
  ok('a message arriving on the camera tab lights the dot', !(await A.isHidden('#chatDot')), null);
  await A.click('#tabChat');
  ok('chat is still there, with the history, and the dot clears', /hello bob/.test(await A.textContent('#gclog')) && /gg so far/.test(await A.textContent('#gclog')) && (await A.isHidden('#chatDot')), null);
  await A.click('#tabCam'); await A.click('#tabChat');
  ok('switching tabs never reset the chat', /hello bob/.test(await A.textContent('#gclog')), null);
  const mv = await api('move', { code: g.code, from: 52, to: 36 }, P.ann);
  await sleep(500);
  ok('the game goes on while the camera runs', mv.ok && (await B.evaluate(() => snap.moves.length)) === 1, mv);

  console.log('camera off, reconnect, declined');
  await A.click('#tabCam'); await A.click('#camToggle');
  await B.waitForFunction(() => /Camera off/.test(document.querySelector('#camOpp').textContent) && !document.querySelector('#camOpp').classList.contains('live'), null, { timeout: 15000 });
  ok('when they turn it off I see a camera-off placeholder', true);
  await A.reload(); await A.waitForSelector('#tabCam:not(.hidden)'); await A.click('#tabCam');
  ok('after a reload my camera stays off until I choose (and the chat comes back)', (await A.textContent('#camToggle')) === 'Turn camera on', null);
  await A.click('#camToggle'); await B.waitForSelector('#camOpp.live', { timeout: 20000 });
  ok('and it reconnects when I turn it on again', true);
  const D = await open(P.ann, []); const brNo = await chromium.launch(); // no fake device, no permission
  await D.close(); const ctxNo = await brNo.newContext({ permissions: [] }); const N = await ctxNo.newPage();
  await ctxNo.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), P.bob); await N.route(/cdn\.jsdelivr\.net/, (r) => r.abort());
  await N.goto(`http://localhost:${PORT}/?game=${g.code}`); await N.waitForSelector('#tabCam:not(.hidden)'); await N.click('#tabCam'); await N.click('#camToggle');
  await N.waitForFunction(() => /Chat still works/.test(document.querySelector('#camNote').textContent), null, { timeout: 10000 });
  await N.click('#tabChat'); await N.fill('#gcIn', 'still here'); await N.click('#gcForm button');
  await sleep(600);
  ok('declining the camera leaves chat fully working', /still here/.test(await N.textContent('#gclog')), null);
  await brNo.close(); await br.close();
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
