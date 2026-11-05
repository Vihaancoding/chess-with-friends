// The fair-play detector wired into the server: the live check, investigations, the post-game analysis, history, recovery.
// The engine is replaced by canned rows (fairDeps.analyse) so the test is fast; the statistics are the real model.
// Run: node scripts/test-fairdetect.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
process.env.ADMIN_KEY = 'test-admin-key'; delete process.env.ANTHROPIC_API_KEY;
const handler = require('../lib/app');
const store = require('../lib/store');
const M = require('../lib/fairmodel');
const fx = require('./fixtures/damage-games.json');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function call(route, body, who) {
  return new Promise((resolve) => {
    const req = { method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body };
    handler(req, { setHeader() {}, writeHead(code) { this.code = code; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } });
  });
}
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
const LONG = fx[9].ucis;                                           // 50 plies

// canned analysis rows for a whole game: white plays like an engine for the first `engineShare` of its positions, black like a person
let seed = 5; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const gaps = [10, 60, 130, 300];
const personRow = (i, c) => { const x = rnd(), loss = x < 0.3 ? 0 : x < 0.7 ? 20 + rnd() * 50 : x < 0.92 ? 70 + rnd() * 80 : 200 + rnd() * 200; return { i, c, u: 'x', ev: 20, rank: x < 0.3 ? 1 : 2, loss: Math.round(loss), gap: gaps[i % 4], nl: 30, tact: i % 3 === 0, d: 12, t: 800 + Math.round(rnd() * 9000) }; };
const engineRow = (i, c) => ({ i, c, u: 'x', ev: 20, rank: 1, loss: 0, gap: gaps[i % 4], nl: 30, tact: i % 3 === 0, d: 12, t: 3000 + Math.round(rnd() * 200) });
const rowsFor = (n, whiteKind) => { const rows = []; for (let i = 10; i < n; i++) { const c = i % 2 ? 'b' : 'w'; rows.push(c === 'w' && whiteKind === 'engine' ? engineRow(i, c) : personRow(i, c)); } return rows; };
let mode = { white: 'engine', done: true };
handler.fairDeps = { analyse: async (hist) => ({ rows: rowsFor(hist.length, mode.white), done: mode.done }) };

(async () => {
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = {}; for (const n of ['ann', 'bob', 'cat', 'dan', 'eve', 'fay']) P[n] = await su(n);
  await call('admin_claim', { key: 'test-admin-key' }, P.dan);
  const start = async (w, b) => { const g = await call('create', { color: 'w', tc: { base: 300, inc: 0 } }, P[w]); await call('join', { code: g.code }, P[b]); return g.code; };
  const mv = (code, u, who) => call('move', { code, from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)), promo: u[4] ? u[4].toUpperCase() : undefined }, P[who]);
  const play = async (code, w, b, n) => { for (let i = 0; i < n; i++) await mv(code, LONG[i], i % 2 ? b : w); await sleep(400); };

  console.log('a live game: the engine-like side is forfeited, the other is not');
  const g1 = await start('ann', 'bob'); await play(g1, 'ann', 'bob', 44);
  const r1 = await call('room', { code: g1 }, P.cat);
  ok('the game ended by fair-play forfeit against ann', r1.status.over && r1.status.reason === 'fair play forfeit' && r1.status.result === 'b' && r1.fp && r1.fp.name === 'ann', r1.status);
  const c1 = await handler.fairCase(r1.fp.id);
  ok('the case records level, probability and a plain evidence explanation', c1.level === 4 && c1.p < 1e-4 && c1.evidence.reasons.length >= 5 && c1.evidence.reasons.some((x) => /legitimate player/.test(x)), [c1.level, c1.p, c1.evidence.reasons]);
  ok('bob (human-like) has no case', !(await handler.fairCase(r1.fp.id + 'x')), null);

  console.log('a person is never forfeited, whatever the engine says about the other side');
  mode.white = 'person';
  const g2 = await start('cat', 'eve'); await play(g2, 'cat', 'eve', 30);
  const r2 = await call('room', { code: g2 }, P.dan);
  ok('a genuine-looking game goes on', !r2.status.over && !r2.fp, r2.status);
  await call('resign', { code: g2 }, P.cat);

  console.log('exceptions still apply');
  mode.white = 'engine';
  await call('admin_fair_exempt', { name: 'fay', on: true }, P.dan);
  const g3 = await start('fay', 'eve'); await play(g3, 'fay', 'eve', 44);
  ok('an exempt player is not forfeited by the new detector either', !(await call('room', { code: g3 }, P.dan)).status.over, null);
  await call('resign', { code: g3 }, P.fay);
  await call('admin_fair_exempt', { name: 'fay', on: false }, P.dan);

  console.log('post-game analysis: history, and Suspicious games go to admins only');
  // find how much engine play lands at Suspicious (level 3) with the real model
  let lvl3 = null;
  for (let share = 0.4; share <= 0.95 && !lvl3; share += 0.05) {
    seed = 77; const rows = []; for (let k = 0; k < 22; k++) rows.push(rnd() < share ? { ...engineRow(10 + 2 * k, 'w'), t: 800 + Math.round(rnd() * 9000) } : personRow(10 + 2 * k, 'w'));
    const a = M.assess(rows, { rating: 1200, tc: 'blitz' }); if (a.level === 3) lvl3 = rows;
  }
  ok('the model produces a Suspicious (level 3) game from partial engine play', !!lvl3, null);
  if (lvl3) {
    handler.fairDeps = { analyse: async (hist) => ({ rows: [...lvl3.map((r, k) => ({ ...r, i: 10 + 2 * k })), ...rowsFor(hist.length, 'person').filter((r) => r.c === 'b')], done: true }) };
    const g4 = await start('ann', 'eve'); await play(g4, 'ann', 'eve', 46); await call('resign', { code: g4 }, P.eve); await sleep(600);
    const inv = await call('admin_fair_inv', {}, P.dan);
    ok('an investigation is open for admins', inv.ok && inv.items.some((x) => x.name === 'ann' && x.level === 3 && x.evidence.length >= 4), inv.items);
    ok('players cannot see investigations', (await call('admin_fair_inv', {}, P.cat)).status >= 400, null);
    ok('nothing was enforced or announced', !(await call('room', { code: g4 }, P.cat)).fp && (await call('me', {}, P.cat)).chat.filter((m) => m.fp).length === 1, null);
    const hist = await call('admin_fair', { name: 'ann' }, P.dan);
    ok('the player profile carries the detector summary and history', hist.det && hist.det.level >= 3 && hist.det.history.length >= 1 && hist.det.last && hist.det.last.evidence.length, hist.det);
    const it = inv.items.find((x) => x.name === 'ann');
    const v = await call('admin_fair_inv_act', { id: it.id, act: 'vote' }, P.dan);
    ok('an admin can turn it into a community vote', v.ok && v.caseId, v);
    ok('and it is no longer waiting', !(await call('admin_fair_inv', {}, P.dan)).items.some((x) => x.id === it.id), null);
    const dis = await call('admin_fair_inv_act', { id: 'nope', act: 'dismiss' }, P.dan);
    ok('unknown investigations are refused', dis.status === 404, dis);
  }

  console.log('analysis that is cut short is picked up again');
  mode = { white: 'person', done: false };
  handler.fairDeps = { analyse: async (hist) => ({ rows: rowsFor(hist.length, mode.white), done: mode.done }) };
  const g5 = await start('eve', 'fay'); await play(g5, 'eve', 'fay', 30); await call('resign', { code: g5 }, P.fay); await sleep(500);
  const lst = (v) => (v && v.list) || (Array.isArray(v) ? v : []);
  const q = lst(await store.get('fq'));
  ok('an unfinished analysis is queued', q.length >= 1, q);
  mode.done = true;
  await call('fair_cases', {}, P.cat); await sleep(500);
  ok('the lobby refresh finishes it and the player gets a history entry', (await store.get('fhist:eve') || []).length >= 1 && !lst(await store.get('fq')).length, [await store.get('fhist:eve'), await store.get('fq')]);

  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
