// Quiet online / offline notes: a small note in the corner when players come online or go offline, grouped, never
// during your own game, no note for a reload blip, no repeats within 3 minutes, and a switch to turn them off.
// Run: node scripts/test-presence-ui.js          (needs Playwright: npm i -g playwright, or NODE_PATH pointing at it)
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 4070 + Math.floor(Math.random() * 9);
const SHOTS = process.env.SHOTS || '';
let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => {
  const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) });
  return { status: r.status, ...(await r.json()) };
};
let srv = null;
process.on('exit', () => { if (srv) srv.kill(); });

(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, SUPABASE_URL: '' }, stdio: 'ignore' });
  await sleep(800);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const ann = await su('ann'), bob = await su('bob');
  const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 1280, height: 860 } });
  const A = await ctx.newPage();
  A.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); });
  await A.route(/cdn\.jsdelivr\.net/, (r) => r.abort());
  await ctx.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), ann);

  let r;
  console.log('a real login');
  await A.goto(`http://localhost:${PORT}/`);
  await A.waitForSelector('#onlinelist .orow');
  await sleep(3500);                                                   // a couple of lobby polls: the baseline
  ok('no notes for people already online when the page opens', !(await A.evaluate(() => document.querySelector('#presNote').classList.contains('show'))));
  await api('me', {}, bob);                                            // bob opens the site
  await A.waitForFunction(() => document.querySelector('#presNote').classList.contains('show'), null, { timeout: 15000 });
  ok('a small note: bob is online', /bob is online/.test(await A.textContent('#presNote')), await A.textContent('#presNote'));
  if (SHOTS) await A.screenshot({ path: path.join(SHOTS, 'p1-note.png') });
  await A.waitForFunction(() => !document.querySelector('#presNote').classList.contains('show'), null, { timeout: 8000 });
  ok('it fades away by itself', true);

  console.log('the rules (with a simulated clock)');
  const run = (steps) => A.evaluate((steps) => {
    const real = Date.now, realEvent = presenceEvent, out = [];
    let t = real(), step = null;
    Date.now = () => t;
    PRES.on = new Set(); PRES.offSince.clear(); PRES.last.clear(); PRES.fed = 0; PRES.queue = { on: [], off: [] }; clearTimeout(PRES.flushT);
    presenceEvent = (n, kind, now) => { const before = PRES.last.get(n + ':' + kind); realEvent(n, kind, now); if (PRES.last.get(n + ':' + kind) !== before) step[kind].push(n); };   // record announcements
    for (const [dt, names] of steps) { t += dt; step = { on: [], off: [] }; presenceFeed(names); out.push(step); }
    presenceEvent = realEvent; Date.now = real; clearTimeout(PRES.flushT); PRES.queue = { on: [], off: [] };
    return out;
  }, steps);
  let o = await run([[0, ['bob']], [5e3, ['bob']], [5e3, []], [10e3, ['bob']]]);
  ok('a short absence (a reload) is not news', o.every((x) => !x.on.length && !x.off.length), o);
  o = await run([[0, ['bob']], [5e3, []], [20e3, []], [30e3, []]]);
  ok('gone for real (45 s): "went offline"', o[3].off.join() === 'bob' && !o[2].off.length, o);
  o = await run([[0, []], [5e3, ['bob']], [5e3, []], [50e3, []], [5e3, ['bob']], [200e3 / 4, ['bob']]]);
  ok('nobody is announced the same way twice within 3 minutes', o[1].on.join() === 'bob' && o[3].off.join() === 'bob' && !o[4].on.length, o);
  o = await run([[0, []], [5e3, ['bob', 'cat', 'dan', 'eve']]]);
  ok('several at once are one note', o[1].on.length === 4, o);
  await A.evaluate(() => { PRES.queue = { on: ['bob', 'cat', 'dan', 'eve'], off: [] }; presenceFlush(); });
  ok('…"bob, cat and 2 others are online"', /bob, cat and 2 others are online/.test(await A.textContent('#presNote')), await A.textContent('#presNote'));
  await A.evaluate(() => { hidePresence(); PRES.queue = { on: ['bob'], off: ['cat'] }; presenceFlush(); });
  ok('comings and goings together: "bob is online · cat went offline"', /bob is online · cat went offline/.test(await A.textContent('#presNote')), await A.textContent('#presNote'));
  o = await run([[0, []], [5e3, ['ann']]]);
  ok('never about yourself', !o[1].on.length, o);
  o = await run([[0, ['bob']], [100e3, []]]);
  ok('after a long gap (you were in a game) it starts afresh instead of announcing everything', !o[1].off.length && !o[1].on.length, o);

  console.log('not during your games, and a switch to turn them off');
  await A.evaluate(() => { hidePresence(); view = 'game'; PRES.queue = { on: ['bob'], off: [] }; presenceFlush(); view = 'lobby'; });
  ok('no note while you are in a game', !(await A.evaluate(() => document.querySelector('#presNote').classList.contains('show'))));
  await A.click('#navSkin');
  await A.waitForSelector('#skinModal:not(.hidden)');
  ok('the switch is on by default', await A.isChecked('#presToggle'));
  await A.click('label:has(#presToggle)');
  await A.click('#skinDone');
  await A.evaluate(() => { PRES.queue = { on: ['bob'], off: [] }; presenceFlush(); });
  ok('turned off: no notes', !(await A.evaluate(() => document.querySelector('#presNote').classList.contains('show'))));
  ok('…and it is remembered', await A.evaluate(() => JSON.parse(localStorage.getItem('chess:skin')).presence === false));

  console.log('the presence check');
  r = await api('presence', {}, ann);
  ok('lists who is online', r.status === 200 && r.on.includes('bob') && r.on.includes('ann'), r);

  console.log('browsing tournaments keeps you online');
  await api('tour_list', {}, bob);
  r = await api('presence', {}, ann);
  ok('bob, on the Tournaments page, counts as online', r.on.includes('bob'), r);

  await br.close(); srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
