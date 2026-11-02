// Fair play tests: the engine check of finished games, and the admin and report routes.
// Drives the real API in-process with in-memory storage. Run: node scripts/test-fairplay.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
process.env.ADMIN_KEY = 'test-admin-key';
const handler = require('../lib/app');
const Chess = require('../public/chess.js');
const Engine = require('../public/engine.js');
const Fair = require('../lib/fairplay');

let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function call(route, body, who) {
  return new Promise((resolve) => {
    const req = { method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body };
    const res = { writeHead(code) { this.code = code; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } };
    handler(req, res);
  });
}
async function until(fn, ms = 4000) { const t = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t > ms) return v; await sleep(25); } }
// Both sides are fixed-depth searches, so the game is the same every run. The engine side searches deep; the
// human-like side searches shallow and often takes its second or third choice, as people do.
const engineMove = (st) => { Engine.clear(); return Engine.analyze(st, 1e9, 5).best; };
let ply = 0;
const humanMove = (st) => { Engine.clear(); const sc = Engine.analyze(st, 1e9, 3).scores; return sc[Math.min(sc.length - 1, [0, 0, 1, 0, 2][ply++ % 5])].m; };

(async () => {
  console.log('verdict');
  const g = (match, acpl, n = 20, cv = null) => ({ n, match, acpl, cv });
  ok('no games, no flag', Fair.verdict([]).flag === null, Fair.verdict([]));
  ok('ordinary play is not flagged', Fair.verdict([g(45, 60), g(55, 40), g(50, 70), g(60, 35)]).flag === null, Fair.verdict([g(45, 60), g(55, 40), g(50, 70), g(60, 35)]));
  ok('one brilliant-but-short game is not flagged', Fair.verdict([g(95, 3, 10)]).flag === null, Fair.verdict([g(95, 3, 10)]));
  ok('one long game played exactly like the engine is flagged', /almost exactly/.test(Fair.verdict([g(94, 4)]).flag), Fair.verdict([g(94, 4)]));
  ok('several engine-like games are flagged', /over 3 games/.test(Fair.verdict([g(80, 15), g(85, 12), g(79, 17)]).flag), Fair.verdict([g(80, 15), g(85, 12), g(79, 17)]));
  ok('steady move times are mentioned', /steady/.test(Fair.verdict([g(94, 4, 20, 0.2)]).flag), Fair.verdict([g(94, 4, 20, 0.2)]));

  console.log('\nan online game: one side plays the engine\'s moves');
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const cheat = await su('cheat'), honest = await su('honest'), boss = await su('boss');
  const c = await call('create', { color: 'w', tc: { base: 600, inc: 0 } }, cheat);
  await call('join', { code: c.code }, honest);
  let st = Chess.initial();
  for (let i = 0; i < 80 && !Chess.status(st).over; i++) {
    const m = st.turn === 'w' ? engineMove(st) : humanMove(st);
    const r = await call('move', { code: c.code, from: m.from, to: m.to, promo: m.promo }, st.turn === 'w' ? cheat : honest);
    if (!r.ok) throw new Error('move failed: ' + r.error);
    st = Chess.apply(st, Chess.legalMoves(st).find((x) => x.from === m.from && x.to === m.to && (x.promo || null) === (m.promo || null)));
  }
  if (!Chess.status(st).over) await call('resign', { code: c.code }, honest);
  const archived = await until(async () => { const r = await call('games', { name: 'cheat' }, cheat); return r.games.length ? r : null; });
  ok('the game is archived', archived && archived.games.length === 1, archived);
  console.log('    (' + archived.games[0].moves + ' plies, ' + archived.games[0].reason + ')');

  console.log('\nadmin routes');
  let r = await call('admin_fair', { name: 'cheat' }, honest);
  ok('players cannot see fair play data', r.status === 403, r);
  await call('admin_claim', { key: 'test-admin-key' }, boss);
  r = await call('admin_overview', {}, boss);
  const sumOf = (n) => r.users.find((u) => u.name === n).fair;
  ok('the overview lists games waiting for a check', sumOf('cheat').pending === 1 && sumOf('cheat').verdict === null, sumOf('cheat'));
  r = await call('admin_fair', { name: 'cheat', scan: true }, boss);
  const cs = r.games[0] && r.games[0].scan;
  ok('the engine side matches the engine most of the time and loses little', r.pending === 0 && cs && cs.match >= 70 && cs.acpl <= 15, r.games);
  const h = await call('admin_fair', { name: 'honest', scan: true }, boss);
  const hs = h.games[0] && h.games[0].scan;
  ok('the human-like side matches far less and loses far more', hs && hs.match < cs.match - 15 && hs.acpl > cs.acpl + 20, h.games);
  r = await call('admin_overview', {}, boss);
  ok('after the check the overview has the verdict and nothing pending', sumOf('cheat').pending === 0 && sumOf('cheat').verdict && sumOf('cheat').verdict.games === 1, sumOf('cheat'));
  r = await call('admin_fair', { name: 'cheat', scan: true }, boss);
  ok('a checked game is not checked again', r.pending === 0 && r.games.length === 1, r);

  console.log('\nreports from the browser');
  r = await call('fair_report', { code: c.code, what: 'a layer over the board: div#sf-arrows' }, cheat);
  ok('a player\'s browser can report', r.ok, r);
  await call('fair_report', { code: c.code, what: 'a layer over the board: div#sf-arrows' }, cheat);
  r = await call('fair_report', { code: c.code, what: '' }, cheat);
  ok('an empty report is refused', r.status === 400, r);
  r = await call('admin_fair', { name: 'cheat' }, boss);
  ok('admins see the report once, with its game', r.ext.length === 1 && r.ext[0].game === c.code && /sf-arrows/.test(r.ext[0].what), r.ext);
  r = await call('admin_overview', {}, boss);
  ok('the overview counts it', sumOf('cheat').ext === 1 && sumOf('honest').ext === 0, sumOf('cheat'));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
