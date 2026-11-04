// The Damage Report in the browser: the headline and the strip, rotation and pause, keyboard, the hide switch and its
// shortcut (saved to the account), opting out, the empty and loading states, the share window, and a phone-sized page.
// Run: node scripts/test-damage-ui.js          (needs Playwright: npm i -g playwright, or NODE_PATH pointing at it)
const path = require('path');
const { chromium } = require('playwright');
process.env.PORT = String(4110 + Math.floor(Math.random() * 9));
process.env.SUPABASE_URL = '';
process.env.DAMAGE_MOVE_MS = '2000'; process.env.DAMAGE_BUDGET_MS = '60000'; delete process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT;
const SHOTS = process.env.SHOTS || '';
const origLog = console.log; console.log = () => {};
require('../server.js');
console.log = origLog;
const app = require('../lib/app');
const fx = require('./fixtures/damage-games.json');

let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => {
  const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) });
  return { status: r.status, ...(await r.json()) };
};
const sq = (q) => 'abcdefgh'.indexOf(q[0]) + (8 - +q[1]) * 8;

(async () => {
  await sleep(300);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = {};
  for (const n of ['ann', 'bob', 'cat', 'dan', 'eve', 'gus']) P[n] = await su(n);
  const play = async (white, black, ucis, end) => {
    const g = await api('create', { color: 'w', tc: { base: 300, inc: 0 } }, P[white]);
    await api('join', { code: g.code }, P[black]);
    for (const [i, u] of ucis.entries()) { const r = await api('move', { code: g.code, from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)), promo: u[4] ? u[4].toUpperCase() : undefined }, P[i % 2 ? black : white]); if (!r.ok) throw new Error(u + ': ' + r.error); }
    if (end === 'resign') await api('resign', { code: g.code }, P[ucis.length % 2 ? black : white]);
    await sleep(30); await app.damageIdle();
  };

  const br = await chromium.launch();
  const open = async (u, viewport, extra = {}) => {
    const ctx = await br.newContext({ viewport, acceptDownloads: true, ...extra });
    if (extra.perms) await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await ctx.newPage();
    page.reqs = [];
    page.on('request', (r) => { if (/damage_feed/.test(r.url())) page.reqs.push(r.url()); });
    page.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); });
    page.on('dialog', (d) => d.accept());
    await page.route(/cdn\.jsdelivr\.net/, (r) => r.abort());
    await ctx.addInitScript((x) => { localStorage.setItem('chess:user', JSON.stringify(x)); }, u);
    return page;
  };
  const shot = (page, name, full) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: !!full });

  console.log('loading and empty states');
  const G = await open(P.gus, { width: 1280, height: 900 });
  await G.route(/damage_feed/, async (r) => { await sleep(600); r.continue(); });
  await G.goto(`http://localhost:${PORT}/`);
  await G.waitForSelector('#dmgcard:not(.hidden)');
  ok('while it loads there is a skeleton, not a blank hole', await G.isVisible('#dmgbody .dmgskel'));
  await G.waitForSelector('#dmgbody .dmgempty');
  ok('with no games yet, a short dry empty state', /Nobody has been humiliated yet/.test(await G.textContent('#dmgbody')), await G.textContent('#dmgbody'));
  await shot(G, 'd0-empty');

  // real games: three wins by mile, one mate
  await play('ann', 'bob', fx[4].ucis, 'resign');
  await play('dan', 'cat', fx[3].ucis, 'resign');
  await play('eve', 'ann', fx[2].ucis);
  await play('cat', 'eve', fx[8].ucis, 'resign');
  const feed = await api('damage_feed', {}, P.gus);
  ok('four cards exist on the server', feed.headline && feed.strip.length === 3, [feed.headline && feed.headline.id, feed.strip.length]);

  console.log('the section');
  const A = await open(P.ann, { width: 1280, height: 900 }, { perms: true });
  await A.goto(`http://localhost:${PORT}/`);
  await A.waitForSelector('#dmgbody .dmgbig');
  ok('the section sits on the main page with the headline card first', await A.isVisible('#dmgcard') && /Damage Report/i.test(await A.textContent('#dmgcard h2')));
  const hl = await A.$eval('#dmgbody .dmgbig', (x) => ({ score: +x.querySelector('.dmgsc b').textContent, line: x.querySelector('.dmgln').textContent, btn: x.querySelector('[data-dmgview]').textContent, band: x.className }));
  ok('the headline is the most brutal game, with its big score, commentary and button', hl.score === feed.headline.score && hl.line === feed.headline.line && /View the damage/.test(hl.btn), [hl, feed.headline.score]);
  ok('the band shapes the card (a class per band)', new RegExp('b-' + feed.headline.band).test(hl.band), hl.band);
  const nStrip = await A.$$eval('#dmgstrip .dmgcd', (x) => x.length);
  ok('the strip has the other games, one dot each', nStrip === 3 && (await A.$$eval('[data-dmgdot]', (x) => x.length)) === 3, nStrip);
  ok('every card shows avatars, ratings, a result and a detail line', await A.$$eval('#dmgbody .dmgcd', (cs) => cs.every((c) => c.querySelectorAll('.rvcir').length === 2 && c.querySelectorAll('.dmgp small').length === 2 && c.querySelector('.res') && c.querySelector('.dmgdt').textContent.length > 5)));
  await shot(A, 'd1-desktop', true);

  console.log('the strip');
  ok('it starts on the first card', (await A.evaluate(() => DMG.i)) === 0);
  await A.waitForFunction(() => DMG.i === 1, null, { timeout: 12000 });
  ok('it moves along by itself, slowly', true);
  await A.click('#dmgPause');
  ok('the pause button says it is paused', (await A.textContent('#dmgPause')) === 'Play' && (await A.getAttribute('#dmgPause', 'aria-pressed')) === 'true');
  await sleep(7500);
  ok('and then it stays put', (await A.evaluate(() => DMG.i)) === 1);
  await A.click('#dmgPause');
  await A.focus('#dmgstrip');
  await A.keyboard.press('ArrowRight');
  ok('arrow keys move it when focused', (await A.evaluate(() => DMG.i)) === 2 && (await A.$$eval('[data-dmgdot].on', (x) => x.length)) === 1);
  await A.keyboard.press('ArrowLeft'); await A.keyboard.press('ArrowLeft'); await A.keyboard.press('ArrowLeft');
  ok('…and wrap around at the start', (await A.evaluate(() => DMG.i)) === 2, await A.evaluate(() => DMG.i));
  await A.click('[data-dmgdot="0"]'); await sleep(500);
  ok('the dots jump to a card', (await A.evaluate(() => DMG.i)) === 0 && (await A.$eval('#dmgstrip', (s) => s.scrollLeft)) < 5);
  await A.evaluate(() => { const s = document.querySelector('#dmgstrip'); s.scrollTo({ left: s.scrollWidth, behavior: 'instant' }); });
  await sleep(400);
  ok('swiping (scrolling) updates which card is current', (await A.evaluate(() => DMG.i)) >= 1, await A.evaluate(() => DMG.i));
  ok('hovering stops the drift', await (async () => { await A.evaluate(() => { DMG.i = 0; DMG.until = 0; }); await A.hover('#dmgstrip .dmgcd'); const i0 = await A.evaluate(() => DMG.i); await sleep(7200); const i1 = await A.evaluate(() => DMG.i); await A.mouse.move(5, 5); return i0 === i1; })());

  console.log('view and share');
  const id0 = await A.$eval('#dmgbody .dmgbig [data-dmgview]', (b) => b.dataset.dmgview);
  await A.click('#dmgbody .dmgbig [data-dmgview]');
  await A.waitForFunction(() => view === 'game', null, { timeout: 8000 });
  ok('"View the damage" opens the replay of that game', A.url().includes('archive=' + encodeURIComponent(id0)), A.url());
  await A.goto(`http://localhost:${PORT}/`);
  await A.waitForSelector('#dmgbody .dmgbig');
  await A.click('#dmgbody .dmgbig [data-dmgshare]');
  ok('Share opens a window with the picture', await A.isVisible('#dmgModal') && /damage_img/.test(await A.getAttribute('#dmgPv', 'src')));
  await A.waitForFunction(() => document.querySelector('#dmgPv').naturalWidth > 0, null, { timeout: 15000 });
  ok('the picture loads (portrait by default: 1080 wide)', (await A.$eval('#dmgPv', (i) => i.naturalWidth)) === 1080 && (await A.$eval('#dmgPv', (i) => i.naturalHeight)) === 1350);
  await shot(A, 'd2-share');
  await A.click('[data-dfmt="wide"]');
  await A.waitForFunction(() => document.querySelector('#dmgPv').naturalWidth === 1200, null, { timeout: 15000 });
  ok('wide is 1200 by 630', (await A.$eval('#dmgPv', (i) => i.naturalHeight)) === 630);
  const dl = A.waitForEvent('download');
  await A.click('#dmgDl');
  const dld = await dl;
  ok('download gives a PNG file', /\.png$/.test(dld.suggestedFilename()), dld.suggestedFilename());
  await A.click('#dmgCopyLink');
  const clip = await A.evaluate(() => navigator.clipboard.readText());
  ok('copy link puts the share page address on the clipboard', new RegExp('/d/' + id0.replace(/[-]/g, '\\-') + '$').test(clip) || clip.includes('/d/'), clip);
  const page = await fetch(clip.replace(/^https?:\/\/[^/]+/, `http://localhost:${PORT}`), { headers: { accept: 'text/html' } });
  const html = await page.text();
  ok('…and that page carries the card line for link previews', page.status === 200 && html.includes('og:image') && html.includes('og:description'), page.status);
  await A.click('#dmgCopyImg');
  await sleep(500);
  ok('copy image says something either way', (await A.textContent('#dmgShareMsg')).length > 3, await A.textContent('#dmgShareMsg'));
  await A.keyboard.press('Escape');
  ok('Escape closes it', await A.isHidden('#dmgModal'));

  console.log('hide it (saved to the account)');
  const before = A.reqs.length;
  await A.click('#dmgHide');
  ok('the whole section goes', await A.isHidden('#dmgcard'));
  await sleep(300);
  ok('and it is saved to the account', (await api('me', {}, P.ann)).user.dmgHide === true);
  const S = await open(P.ann, { width: 1280, height: 900 });
  await S.goto(`http://localhost:${PORT}/`);
  await S.waitForSelector('#lobby:not(.hidden)'); await sleep(1500);
  ok('on another device it is hidden too, and its data is not even fetched', await S.isHidden('#dmgcard') && S.reqs.length === 0, S.reqs.length);
  await A.focus('#chatIn'); await A.keyboard.press('Shift+D');
  ok('Shift+D typed into a text box does nothing to it', await A.isHidden('#dmgcard') && (await api('me', {}, P.ann)).user.dmgHide === true);
  await A.evaluate(() => document.activeElement.blur());
  await A.keyboard.press('Shift+D');
  await A.waitForSelector('#dmgcard:not(.hidden)');
  ok('Shift+D brings it back', true);
  await sleep(300);
  ok('…and saves that', (await api('me', {}, P.ann)).user.dmgHide === false);
  await A.keyboard.press('Shift+D');
  ok('Shift+D hides it again from anywhere on the page', await A.isHidden('#dmgcard'));
  await sleep(300);
  await A.keyboard.press('Shift+D'); await A.waitForSelector('#dmgcard:not(.hidden)');

  console.log('opting out');
  await A.click('#navSkin');
  await A.waitForSelector('#skinModal:not(.hidden)');
  ok('the settings show both switches', await A.isChecked('#dmgShowToggle') && await A.isChecked('#dmgOutToggle'));
  await A.uncheck('#dmgOutToggle'); await sleep(400);
  const cf = await api('damage_feed', {}, P.gus);
  ok('with ann opted out none of the games with ann show up for anyone', [cf.headline, ...cf.strip].filter(Boolean).every((x) => x.w !== 'ann' && x.b !== 'ann') && (await api('me', {}, P.ann)).user.dmgOut === true, cf.strip.length);
  await A.check('#dmgOutToggle'); await sleep(400);
  ok('and opting back in brings them back', ([(await api('damage_feed', {}, P.gus)).headline].length === 1) && (await api('me', {}, P.ann)).user.dmgOut === false);
  await A.click('#skinDone');

  console.log('a phone');
  const M = await open(P.cat, { width: 390, height: 800 }, { hasTouch: true, isMobile: true });
  await M.goto(`http://localhost:${PORT}/`);
  await M.waitForSelector('#dmgbody .dmgbig');
  ok('no sideways scrolling on a phone', await M.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), await M.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  ok('the headline card fits the screen', await M.$eval('#dmgbody .dmgbig', (c) => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; }));
  ok('long names do not push the card wider', await (async () => { await M.evaluate(() => { document.querySelectorAll('.dmgp b').forEach((b) => b.textContent = 'AVeryLongUsername12'); }); return M.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1); })());
  ok('buttons are big enough to tap', await M.$eval('[data-dmgview]', (b) => b.getBoundingClientRect().height >= 30));
  await shot(M, 'd3-phone', true);
  const Tt = await open(P.cat, { width: 820, height: 1000 });
  await Tt.goto(`http://localhost:${PORT}/`);
  await Tt.waitForSelector('#dmgbody .dmgbig');
  ok('tablet fits too', await Tt.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

  await br.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
