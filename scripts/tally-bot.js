// Tally bot: keeps signed-in headless browsers open on the site so the move stats get counted (each browser counts with its own Stockfish,
// and never a game its own account played in, so run two or more accounts). Needs Playwright (npm i playwright; npx playwright install chromium).
//   SITE=https://your-site.vercel.app ACCOUNTS="a@x.io:pass1,b@x.io:pass2" node scripts/tally-bot.js
// Use ordinary accounts (not admin). The credentials stay in the environment; nothing is written to disk.
const { chromium } = require('playwright');
const SITE = String(process.env.SITE || '').replace(/\/$/, ''), ACCOUNTS = String(process.env.ACCOUNTS || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const i = x.indexOf(':'); return { email: x.slice(0, i), password: x.slice(i + 1) }; });
if (!SITE || ACCOUNTS.length < 2) { console.error('Set SITE and ACCOUNTS="email:password,email:password" (at least two accounts).'); process.exit(1); }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(acc, browser) {
  for (;;) {
    let ctx;
    try {
      const r = await fetch(`${SITE}/api?r=login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(acc) });
      const u = await r.json();
      if (!r.ok || !u.token) { log(acc.email, 'login failed:', u.error || r.status); await sleep(10 * 60e3); continue; }
      ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
      await ctx.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), { name: u.name, token: u.token });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => log(u.name, 'page error:', e.message));
      await p.goto(SITE + '/'); await p.waitForSelector('#statscard', { timeout: 60e3 });
      log(u.name, 'counting');
      // reload now and then: keeps the session fresh and picks up new versions of the site
      for (let i = 0; i < 12; i++) {
        await sleep(5 * 60e3);
        const t = await p.textContent('#statsBody').catch(() => '');
        log(u.name, (t.match(/Stockfish[^.]*\.[^.]*\./) || [''])[0].slice(0, 140));
      }
    } catch (e) { log(acc.email, 'restarting:', e.message); await sleep(30e3); }
    finally { if (ctx) await ctx.close().catch(() => {}); }
  }
}
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  log('tally bot on', SITE, 'with', ACCOUNTS.length, 'accounts');
  await Promise.all(ACCOUNTS.map((a, i) => sleep(i * 3000).then(() => run(a, browser))));
})();
