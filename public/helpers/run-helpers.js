// Keep headless Chrome browsers on the site so they do the analysis (live games, finished games, Reels checks and the
// backfill) with Stockfish, exactly like players' browsers do. Use at least 2 DIFFERENT accounts: a highlight is only
// published after a second account's browser confirms it, and an account never confirms its own work.
// Use accounts that don't play while this runs (a browser stops helping in its player's own games).
//
//   HELPER_URL=https://your-site.vercel.app HELPER_ACCOUNTS='a@x.com:password1,b@x.com:password2' node scripts/run-helpers.js
//   On Windows: download chess-helpers.bat from the Admin panel and double-click it.
//
// Runs until you stop it (Ctrl+C). Every minute it prints what the browsers did. Needs Playwright (npm i playwright).
const { chromium } = require('playwright');
const URL_ = (process.env.HELPER_URL || 'http://localhost:3000').replace(/\/$/, '');
const accounts = String(process.env.HELPER_ACCOUNTS || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const i = x.indexOf(':'); return { email: x.slice(0, i).trim(), password: x.slice(i + 1).trim() }; });   // stray spaces from typing are ignored
if (accounts.length < 1 || accounts.some((a) => !a.email || !a.password)) {
  console.error("Set HELPER_ACCOUNTS='email:password,email:password' (2 or more different accounts) and HELPER_URL.");
  process.exit(1);
}
if (accounts.length < 2) console.warn('Only one account: it can analyse, but highlights need a second account to be confirmed.');

(async () => {
  const browser = await chromium.launch();
  const counts = {};
  for (const a of accounts) {
    const r = await fetch(`${URL_}/api?r=login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a) });
    const user = await r.json().catch(() => ({}));
    if (!r.ok || !user.token) { console.error(`Login failed for ${a.email}: ${user.error || r.status}`); continue; }
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript((u) => { localStorage.setItem('chess:user', JSON.stringify(u)); localStorage.setItem('chess:help', '1'); }, user);
    const page = await ctx.newPage();
    page.on('request', (q) => { const m = q.url().match(/[?&]r=(live_eval|stats_submit|reel_submit)\b/); if (m) counts[m[1]] = (counts[m[1]] || 0) + 1; });
    page.on('pageerror', (e) => console.warn(`[${user.name}] page error: ${e.message}`));
    await page.goto(URL_ + '/');
    console.log(`Helping as ${user.name}`);
  }
  if (!Object.keys(browser.contexts()).length) { await browser.close(); process.exit(1); }
  setInterval(() => {
    const t = new Date().toLocaleTimeString();
    console.log(`${t}  live positions: ${counts.live_eval || 0} · finished-game slices: ${counts.stats_submit || 0} · Reels checks/slices: ${counts.reel_submit || 0}`);
  }, 60000);
  const stop = async () => { await browser.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
})();
