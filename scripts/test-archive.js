// Game archive tests: finished games are saved from the server's own record and listed for both players.
// Drives the real API in-process with in-memory storage. Run: node scripts/test-archive.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
const handler = require('../lib/app');
const store = require('../lib/store');

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
const sq = (q) => 'abcdefgh'.indexOf(q[0]) + (8 - +q[1]) * 8;
async function play(code, ucis, players) {
  for (const [i, u] of ucis.entries()) {
    const r = await call('move', { code, from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)), promo: u[4] ? u[4].toUpperCase() : undefined }, players[i % 2]);
    if (!r.ok) throw new Error(`move ${u} failed: ${r.error}`);
  }
}
async function newGame(a, b, tc) {
  const c = await call('create', { color: 'w', tc }, a);
  await call('join', { code: c.code }, b);
  return c.code;
}
// background work (settling, archiving) runs after the response; wait for it to land
async function until(fn, ms = 3000) { const t = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t > ms) return v; await sleep(25); } }

(async () => {
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const alice = await su('alice'), bob = await su('bob');

  console.log('rated game ending in checkmate');
  const c1 = await newGame(alice, bob, { base: 300, inc: 0 });
  await play(c1, ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'], [alice, bob]);
  const ga = await until(async () => { const r = await call('games', { name: 'alice' }, alice); return r.games.length && r.games[0].after != null ? r : null; });
  const row = ga && ga.games[0];
  ok('listed for the winner', row && row.result === 'win' && row.opp === 'bob' && row.color === 'w', row);
  ok('row has rating change, time control, moves and opening', row && row.rated && row.delta > 0 && row.cat === 'blitz' && row.moves === 7 && /^C\d\d$/.test(row.eco) && /Italian|Bishop|Scholar|King's Pawn/.test(row.op), row);
  const gb = await call('games', { name: 'bob' }, bob);
  ok('listed for the loser with the same id', gb.games[0] && gb.games[0].id === row.id && gb.games[0].result === 'loss' && gb.games[0].delta < 0, gb.games[0]);
  const g = await call('game_get', { id: row.id }, bob);
  ok('full game has the authoritative moves', g.status === 200 && g.game.hist.length === 7 && g.game.moves[6] === 'Qxf7#' && g.game.result === 'w' && g.game.reason === 'checkmate', g.game && { moves: g.game.moves, r: g.game.result, why: g.game.reason, ok: g.ok, n: g.game.hist.length });
  ok('full game has ratings for both sides', g.game.ratings && g.game.ratings.w.delta === row.delta && g.game.ratings.b.delta === gb.games[0].delta, g.game.ratings);
  const room = await until(async () => { const r = await store.get('room:' + c1); return r && r.archived ? r : null; });
  ok('room is marked archived', room && room.archived === row.id, room && room.archived);

  console.log('reading the archive changes nothing');
  const before = JSON.stringify([await store.get('user:alice'), await store.get('room:' + c1), await store.get('lb')]);
  await call('games', { name: 'alice' }, alice); await call('game_get', { id: row.id }, alice); await call('game_get', { id: row.id }, bob);
  ok('accounts, ratings and the room are untouched', before === JSON.stringify([await store.get('user:alice'), await store.get('room:' + c1), await store.get('lb')]));

  console.log('archiving is idempotent');
  room.archived = null; room.endedAt -= 5000;                         // pretend the "archived" mark was lost
  await store.set('room:' + c1, room);
  handler.archiveTried.clear();                                       // and that the per-instance retry throttle has passed
  await call('room', { code: c1 }, alice);                            // a heartbeat takes the recovery path
  const re = await until(async () => { const r = await store.get('room:' + c1); return r && r.archived ? r : null; });
  ok('recovery re-marks the room', re && re.archived === row.id, re && re.archived);
  const again = await call('games', { name: 'alice' }, alice);
  ok('no duplicate rows', again.games.filter((x) => x.id === row.id).length === 1, again.games.length);
  ok('saved game is unchanged', JSON.stringify((await call('game_get', { id: row.id }, bob)).game) === JSON.stringify(g.game));

  console.log('unrated game (resigned after one move)');
  const c2 = await newGame(bob, alice, null);
  await play(c2, ['d2d4'], [bob, alice]);
  await call('resign', { code: c2 }, alice);
  const ub = await until(async () => { const r = await call('games', { name: 'bob' }, bob); return r.games.length === 2 ? r : null; });
  const u0 = ub && ub.games[0];
  ok('unrated game is saved too', u0 && u0.result === 'win' && u0.reason === 'resignation' && u0.rated === false && u0.delta == null && u0.cat === 'classical', u0);
  ok('newest first', ub && ub.games[1].id === row.id, ub && ub.games.map((x) => x.id));

  console.log('game with no moves is not archived');
  const c3 = await newGame(alice, bob, null);
  await call('resign', { code: c3 }, bob);
  await sleep(100);
  ok('not listed', (await call('games', { name: 'alice' }, alice)).games.length === 2);

  console.log('rematch in the same room is a separate game');
  const c4 = await newGame(alice, bob, null);
  await play(c4, ['e2e4', 'e7e5'], [alice, bob]);
  await call('resign', { code: c4 }, alice);
  await until(async () => (await call('games', { name: 'alice' }, alice)).games.length === 3);
  await call('rematch', { code: c4 }, alice); await call('rematch', { code: c4 }, bob);
  await play(c4, ['g1f3', 'g8f6'], [bob, alice]);                      // colours swapped
  await call('draw_offer', { code: c4 }, bob); await call('draw_accept', { code: c4 }, alice);
  const rm = await until(async () => { const r = await call('games', { name: 'alice' }, alice); return r.games.length === 4 ? r : null; });
  ok('both games of the room are kept', rm && rm.games[0].code === c4 && rm.games[1].code === c4 && rm.games[0].id !== rm.games[1].id, rm && rm.games.map((x) => x.id));
  ok('draw by agreement, alice as black', rm && rm.games[0].result === 'draw' && rm.games[0].color === 'b' && rm.games[0].reason === 'agreement', rm && rm.games[0]);

  console.log('bad requests');
  ok('unknown id is a 404', (await call('game_get', { id: 'ABCDE-zz' }, alice)).status === 404);
  ok('malformed id is a 400', (await call('game_get', { id: '../user:alice' }, alice)).status === 400);
  ok('needs sign-in', (await call('games', { name: 'alice' })).status === 401);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
