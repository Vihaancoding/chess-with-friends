// Coach difficulty tests: the slider sets the coach's level, and "Adapt to my results" decides whether games move it.
// Run: node scripts/test-coach-difficulty.js          (needs Playwright: npm i -g playwright, or NODE_PATH pointing at it)
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 4020 + Math.floor(Math.random() * 9), BASE = `http://localhost:${PORT}`;
let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, SUPABASE_URL: '' }, stdio: 'ignore' });
  await sleep(800);
  const r = await (await fetch(`${BASE}/api?r=signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dee@x.io', password: 'password1', username: 'dee' }) })).json();
  const br = await chromium.launch();
  for (const [label, viewport] of [['desktop', { width: 1280, height: 860 }], ['phone', { width: 390, height: 800 }]]) {
    console.log(`\n${label}`);
    const page = await br.newPage({ viewport });
    page.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); });
    await page.route(/cdn\.jsdelivr\.net/, (x) => x.abort());
    await page.addInitScript((u) => { if (!sessionStorage.getItem('init')) { localStorage.clear(); sessionStorage.setItem('init', 1); } localStorage.setItem('chess:user', JSON.stringify(u)); }, { name: r.name, token: r.token });
    await page.goto(BASE + '/?coach');
    await page.waitForSelector('#coach:not(.hidden)');
    const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('chess:coach') || 'null'));
    const card = () => page.$eval('#coCards .rcard', (e) => e.innerText.replace(/\s+/g, ' '));

    ok('adaptive by default', await page.isChecked('#coAdapt') && /adapts/.test(await card()), await card());
    await page.$eval('#coLevel', (e) => { e.value = 1800; e.dispatchEvent(new Event('input', { bubbles: true })); });
    ok('slider shows the level and its name', (await page.textContent('#coLevelVal')) === '1800' && (await page.textContent('#coLevelName')) === 'Expert', await page.textContent('#coLevelVal'));
    ok('level card follows the slider', /coach level 1800/i.test(await card()), await card());
    ok('level saved', Math.abs((await stored()).s - 0.875) < 1e-9, await stored());
    await page.$eval('#coLevel', (e) => { e.value = 425; e.dispatchEvent(new Event('input', { bubbles: true })); });
    ok('lowest level', (await page.textContent('#coLevelVal')) === '425' && (await page.textContent('#coLevelName')) === 'Beginner', await page.textContent('#coLevelVal'));
    await page.$eval('#coLevel', (e) => { e.value = 1000; e.dispatchEvent(new Event('input', { bubbles: true })); });

    await page.uncheck('#coAdapt');
    ok('fixed difficulty shown', /fixed difficulty/.test(await card()) && /Stays at this level/.test(await page.textContent('#coLevelHelp')), await card());
    ok('no horizontal page scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), null);

    // a game played at a fixed level: plays at the chosen level, and a win does not change it
    await page.click('#coColor button[data-c="w"]');
    await page.click('#coStart');
    await page.waitForSelector('#game:not(.hidden)');
    ok('game uses the chosen level', /about 1000/.test(await page.textContent('#coLvl')), await page.textContent('#coLvl'));
    const finish = (res) => page.evaluate((res) => {
      botGame.coach.log = Array.from({ length: 6 }, (_, i) => ({ ply: i * 2, c: 'good', acc: 80, tag: null }));
      botEnd(res === 'win' ? botGame.you : botGame.you === 'w' ? 'b' : 'w', 'resignation');
    }, res);
    await finish('win'); await sleep(200);
    ok('fixed: a win keeps the level', coachRatingOf(await stored()) === 1000, await stored());
    ok('fixed: no "play stronger" line', !/play a bit stronger/.test(await page.textContent('#coMsg')), await page.textContent('#coMsg'));

    // adaptive again: a win raises it
    await page.goto(BASE + '/?coach'); await page.waitForSelector('#coach:not(.hidden)');
    ok('fixed level kept after reload', (await page.textContent('#coLevelVal')) === '1000' && !(await page.isChecked('#coAdapt')), await page.textContent('#coLevelVal'));
    await page.check('#coAdapt');
    await page.click('#coStart'); await page.waitForSelector('#game:not(.hidden)');
    await finish('win'); await sleep(200);
    ok('adaptive: a win raises the level', coachRatingOf(await stored()) > 1000, await stored());
    await page.close();
  }
  await br.close(); srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
function coachRatingOf(d) { return Math.round((400 + d.s * 1600) / 25) * 25; }
