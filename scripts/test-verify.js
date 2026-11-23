// Email verification: every account (old ones too) must confirm its email with a 6-digit code before it can use the site.
// API checks, then the screen in a browser. Run: node scripts/test-verify.js (the browser part needs Playwright).
process.env.PORT = String(4320 + Math.floor(Math.random() * 9)); process.env.SUPABASE_URL = ''; process.env.ADMIN_KEY = 'k'; process.env.VERIFY_DEV = '1';
delete process.env.SMTP_USER; delete process.env.RESEND_API_KEY;
const codes = {}, origLog = console.log;
console.log = (...a) => { const m = /verification code for (\S+) <[^>]*>: (\d{6})/.exec(a.join(' ')); if (m) codes[m[1]] = m[2]; };
require('../server.js');
const store = require('../lib/store');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; origLog('  ✓', n); } else { failed++; origLog('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => { const r = await fetch(`http://localhost:${process.env.PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, ...(await r.json()) }; };

(async () => {
  await sleep(300);
  const su = await api('signup', { email: 'ann@x.io', password: 'password1', username: 'ann' }), ann = { name: su.name, token: su.token };
  ok('a new account has to verify', su.needVerify === true, su);
  const blocked = await api('create', { color: 'w', tc: { base: 600, inc: 0 } }, ann);
  ok('until then it cannot play: 403, flagged verify', blocked.status === 403 && blocked.verify === true, blocked);
  ok('it can still load its account', (await api('me', {}, ann)).status === 200);
  let s = await api('verify_send', {}, ann);
  ok('a code is sent to the account email', s.sent && s.email === 'ann@x.io' && /^\d{6}$/.test(codes.ann || ''), s);
  s = await api('verify_send', {}, ann);
  ok('one email a minute', s.sent === false, s);
  const wrong = codes.ann === '000000' ? '111111' : '000000';
  ok('a wrong code is refused', (await api('verify_email', { code: wrong }, ann)).status === 400);
  const v = await api('verify_email', { code: codes.ann.slice(0, 3) + ' ' + codes.ann.slice(3) }, ann);
  ok('the right code verifies (spaces are fine)', v.status === 200 && v.needVerify === false, v);
  ok('now it can play', (await api('create', { color: 'w', tc: { base: 600, inc: 0 } }, ann)).status === 200);

  console.log('old accounts, wrong addresses, guessing');
  const bs = await api('signup', { email: 'bob@x.io', password: 'password1', username: 'bob' }), bob = { name: bs.name, token: bs.token };
  ok('an existing account without the flag is asked too', (await api('resume', bob)).needVerify === true);
  ok('moving to an address another account uses is refused', (await api('verify_send', { email: 'ann@x.io' }, bob)).status === 409);
  s = await api('verify_send', { email: 'bob2@x.io' }, bob);
  ok('fixing a wrong address sends the code there at once', s.sent && s.email === 'bob2@x.io', s);
  ok('...and the account logs in with the new address, not the old', (await api('login', { email: 'bob2@x.io', password: 'password1' })).status === 200 && (await api('login', { email: 'bob@x.io', password: 'password1' })).status === 401);
  for (let i = 0; i < 5; i++) await api('verify_email', { code: codes.bob === '000000' ? '111111' : '000000' }, bob);
  const lock = await api('verify_email', { code: codes.bob }, bob);
  ok('after 5 wrong codes even the right one needs a new email', lock.status === 429, lock);
  const cs = await api('signup', { email: 'cat@x.io', password: 'password1', username: 'cat' });
  const cu = await store.get('user:cat'); await store.set('user:cat', { ...cu, admin: true });
  ok('admins are not locked out', (await api('create', { color: 'w', tc: { base: 600, inc: 0 } }, { name: cs.name, token: cs.token })).status === 200);

  console.log('the screen');
  let chromium; try { ({ chromium } = require('playwright')); } catch { origLog('  (Playwright missing: browser part skipped)'); }
  if (chromium) {
    await api('signup', { email: 'dan@x.io', password: 'password1', username: 'dan' });
    const br = await chromium.launch(), p = await (await br.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    p.on('pageerror', (e) => { failed++; origLog('  ✗ page error:', e.message); }); await p.route(/cdn\.jsdelivr\.net|fonts\.g/, (x) => x.abort());
    await p.goto(`http://localhost:${process.env.PORT}/`);
    await p.click('#tabIn'); await p.fill('#emailIn', 'dan@x.io'); await p.fill('#passIn', 'password1'); await p.click('#go');
    await p.waitForSelector('#verifyBox:not(.hidden)', { timeout: 8000 }).catch(() => {});
    ok('logging in shows the verify screen, not the lobby', await p.isVisible('#verifyBox') && !(await p.isVisible('#lobby')));
    await sleep(500);
    ok('it says where the code went', /dan@x\.io/.test(await p.textContent('#vfOk')), await p.textContent('#vfOk'));
    if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT + '-verify.png' });
    await p.fill('#vfCode', '000000' === codes.dan ? '111111' : '000000'); await p.click('#vfGo'); await sleep(500);
    ok('a wrong code shows an error', /not right/.test(await p.textContent('#vfErr')));
    await p.fill('#vfCode', codes.dan); await p.click('#vfGo');
    await p.waitForSelector('#lobby:not(.hidden)', { timeout: 8000 }).catch(() => {});
    ok('the right code goes into the lobby', await p.isVisible('#lobby'));
    await p.reload(); await sleep(1500);
    ok('and it stays verified after a reload', await p.isVisible('#lobby') && !(await p.isVisible('#verifyBox')));
    await br.close();
  }
  origLog(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { origLog(e); process.exit(1); });
