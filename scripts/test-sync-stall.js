// Sync tests: a request that never gets an answer (a half-open phone/Wi-Fi connection) must not freeze the game.
// Push is switched off, so the page relies on its heartbeat. Run: node scripts/test-sync-stall.js (needs Playwright)
const { spawn } = require('child_process'); const path = require('path'); const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..'), PORT = 3970 + Math.floor(Math.random() * 9), B = `http://localhost:${PORT}`;
const srv = spawn(process.execPath, [ROOT + '/server.js'], { env: { ...process.env, PORT }, stdio: 'ignore' });
const call = async (u, r, b) => (await fetch(`${B}/api?r=${r}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(u ? { 'x-name': u.name, 'x-token': u.token } : {}) }, body: JSON.stringify(b || {}) })).json();
let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const br = await chromium.launch();
  try {
    const mk = async (n) => call(null, 'signup', { email: n + '@x.io', password: 'password1', username: n });
    const a = await mk('alice'), b = await mk('bobby');
    const g = await call(a, 'create', { color: 'w', tc: '600,0' }); await call(b, 'join', { code: g.code });
    const ctx = await br.newContext(); const p = await ctx.newPage();
    await p.route(/cdn\.jsdelivr\.net/, (r) => r.abort());
    await p.route(/\/api\/events/, (r) => r.abort());                      // push down: the page must rely on its heartbeat
    let stall = false, stalled = 0;
    await p.route(/\/api\?r=(sync|move)/, (r) => {
      const kind = /r=move/.test(r.request().url()) ? 'move' : 'sync';
      if (stall === kind) { stalled++; stall = false; return; }          // never answered: like a half-open connection
      r.continue();
    });
    await p.addInitScript(([n, t]) => localStorage.setItem('chess:user', JSON.stringify({ name: n, token: t })), [b.name, b.token]);
    await p.goto(`${B}/?game=${g.code}`); await p.waitForFunction(() => typeof snap !== "undefined" && snap && snap.players && snap.players.b);
    const moves = () => p.evaluate(() => snap.moves.length);

    // 1) a heartbeat stalls, then the opponent moves
    stall = 'sync'; await p.waitForTimeout(2500);
    await call(a, 'move', { code: g.code, from: sq('e2'), to: sq('e4') });
    let t0 = Date.now(); while (Date.now() - t0 < 20000 && (await moves()) < 1) await p.waitForTimeout(250);
    const n1 = await moves();
    ok(`the opponent's move still arrives after a heartbeat stalls (${((Date.now() - t0) / 1000).toFixed(1)}s)`, n1 >= 1, n1);
    if (n1 < 1) { await p.evaluate(() => kick()); await p.waitForTimeout(1500); }   // unfreeze to test the next case

    // 2) my move request stalls: does it still land, and can I keep playing?
    stall = 'move';
    await p.evaluate(([f, t]) => { send(f, t); }, [sq("e7"), sq("e5")]);
    t0 = Date.now(); let landed = false;
    while (Date.now() - t0 < 20000) { const r = await call(a, 'room', { code: g.code }); if (r.moves && r.moves.length >= 2) { landed = true; break; } await p.waitForTimeout(250); }
    ok(`a move whose request stalls still reaches the server (${((Date.now() - t0) / 1000).toFixed(1)}s)`, landed, landed);
    ok('both requests really were stalled', stalled === 2, stalled);
  } finally { await br.close(); srv.kill(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
