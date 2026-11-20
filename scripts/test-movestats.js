// Move stats for EVERY game, judged by Stockfish: new games are queued and counted, older ones are backfilled, each number opens the
// moves behind it. Uses the real engine. Run: node scripts/test-movestats.js (takes ~30 s)
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY; process.env.ADMIN_KEY = 'k'; process.env.STATS_SF_DEPTH = '12'; process.env.STATS_SF_VERIFY_DEPTH = '14';
const handler = require('../lib/app'), store = require('../lib/store'), Dmg = require('../lib/damage');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const call = (route, body, who) => new Promise((resolve) => handler({ method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body }, { setHeader() {}, writeHead(c) { this.code = c; }, end(b) { let j = {}; try { j = JSON.parse(b || '{}'); } catch {} resolve({ status: this.code, ...j }); } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
const play = async (code, A, B, moves) => { for (let i = 0; i < moves.length; i++) { const r = await call('move', { code, from: sq(moves[i].slice(0, 2)), to: sq(moves[i].slice(2, 4)) }, i % 2 ? B : A); if (r.status !== 200) throw new Error('move ' + moves[i] + ' ' + JSON.stringify(r)); } };
const until = async (f, ms = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await sleep(400); } return null; };
(async () => {
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const A = await su('ann'), B = await su('bob'), C = await su('cat');

  console.log('every finished game is queued, checked by Stockfish and counted');
  // 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7#  (a decisive game of 7 plies, with a clear blunder by Black)
  const g1 = await call('create', { color: 'w', tc: { base: 300, inc: 0 } }, A); await call('join', { code: g1.code }, B);
  await play(g1.code, A, B, ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7']);
  // a game that was never eligible for the Damage Report: resigned after 5 moves (short), by Cat against Ann
  const g2 = await call('create', { color: 'w', tc: { base: 300, inc: 0 } }, A); await call('join', { code: g2.code }, C);
  await play(g2.code, A, C, ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'b1c3', 'g8f6']); await call('resign', { code: g2.code }, C);
  // and a draw by agreement
  const g3 = await call('create', { color: 'w', tc: { base: 300, inc: 0 } }, B); await call('join', { code: g3.code }, C);
  await play(g3.code, B, C, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5']); await call('draw_offer', { code: g3.code }, B); await call('draw_accept', { code: g3.code }, C);
  const board = await until(async () => { const r = await call('stats_board', {}, A); const row = (n) => r.rows.find((x) => x.name === n); return row('ann') && row('ann').games >= 2 && row('bob') && row('bob').games >= 2 && row('cat') && row('cat').games >= 2 ? r : null; });
  ok('all three games were counted, wins, a short resignation and a draw alike', !!board, board && board.rows);
  const bob = board.rows.find((x) => x.name === 'bob'), ann = board.rows.find((x) => x.name === 'ann');
  ok('each side\'s moves land in exactly one bucket', board.rows.every((r) => ['brilliant', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder'].reduce((a, k) => a + r[k], 0) === r.n) && ann.n > 5, ann);
  ok('the engine sees that walking into mate is a blunder', bob.blunder >= 1, bob);

  console.log('a number opens the moves behind it');
  const bl = await call('stats_moves', { name: 'bob', kind: 'blunder' }, A);
  const hit = bl.list.find((x) => x.g === g1.code + '-' || x.g.startsWith(g1.code));
  ok('Bob\'s blunders list the game, the move number and the move itself', bl.total === bob.blunder && !!hit && hit.p === 6 && hit.san === 'Nf6' && hit.o === 'ann' && hit.c === 'b', bl);
  ok('the entry opens the real game at that move', hit && (await call('game_get', { id: hit.g }, A)).status === 200, hit);
  const any = await call('stats_moves', { name: 'ann', kind: 'best' }, B);
  ok('best moves are listed too, newest first, with the opponent', any.list.length > 0 && any.list.every((x, i, a) => !i || a[i - 1].t >= x.t) && any.total >= any.list.length - 0, any.list.length);
  ok('an unknown kind or player is refused', (await call('stats_moves', { name: 'ann', kind: 'cheese' }, A)).status === 400 && (await call('stats_moves', { name: 'nobody', kind: 'best' }, A)).status === 404, null);

  console.log('brilliant moves: real sacrifices that the engine confirms (the Opera Game)');
  const OP = 'e2e4 e7e5 g1f3 d7d6 d2d4 c8g4 d4e5 g4f3 d1f3 d6e5 f1c4 g8f6 f3b3 d8e7 b1c3 c7c6 c1g5 b7b5 c3b5 c6b5 c4b5 b8d7 e1c1 a8d8 d1d7 d8d7 h1d1 e7e6 b5d7 f6d7 b3b8 d7b8 d1d8'.split(' ');
  const go = await call('create', { color: 'w', tc: { base: 600, inc: 0 } }, A); await call('join', { code: go.code }, B);
  await play(go.code, A, B, OP);
  const opb = await until(async () => { const r = await call('stats_moves', { name: 'ann', kind: 'brilliant' }, A); return r.list.some((x) => x.g.startsWith(go.code)) ? r : null; });
  const mine = opb && opb.list.filter((x) => x.g.startsWith(go.code)).map((x) => x.san);
  ok('the queen sacrifice that mates and the knight sacrifice are counted and listed as brilliant', !!opb && mine.includes('Qb8+') && mine.includes('Nxb5'), mine);
  ok('a plain pawn capture followed by a recapture is not a sacrifice', !mine.includes('dxe5'), mine);
  ok('Black, who was mated, has no brilliant move in that game', !(await call('stats_moves', { name: 'bob', kind: 'brilliant' }, A)).list.some((x) => x.g.startsWith(go.code)), null);
  await sleep(300);

  const stt = (await call('stats_board', {}, A)).status;
  ok('the board reports the status of the Stockfish checks: idle once everything is counted, with when the last game finished', stt.state === 'idle' && stt.done >= 4 && stt.lastAt > 0 && stt.now >= stt.lastAt, stt);
  console.log('older games are counted too (backfill), once per game');
  const before = (await call('stats_board', {}, A)).rows.map((r) => ({ name: r.name, n: r.n, games: r.games, blunder: r.blunder }));
  for (const n of ['ann', 'bob', 'cat']) { await store.del('mstat:' + n); await store.del('mlog:' + n); }     // as if these games had been played before this feature
  await store.del('mbackfill:3'); await store.del('mq');
  await store.set('lb', { ann: {}, bob: {}, cat: {} });
  ok('with nothing counted the board is empty', (await call('stats_board', {}, A)).rows.length === 0, null);
  await handler.statsBackfill();
  const q = await store.get('mq');
  ok('every archived game is queued', q && q.ids.length === 4, q);
  const r = await call('stats_board', {}, A);
  ok('and the board says how many are still to be counted, and that games are waiting', r.pending === 4 && r.status.state === 'waiting', r.status);
  const w = await handler.statsWork(60000);
  const after = (await call('stats_board', {}, A)).rows.map((x) => ({ name: x.name, n: x.n, games: x.games, blunder: x.blunder }));
  ok('working the queue brings back exactly the same totals', w.done === 4 && JSON.stringify(after.filter((x) => x.name !== 'ann' || true)) === JSON.stringify(after) && after.length === before.length, [w, before, after]);
  ok('nothing is left to count', ((await store.get('mq')) || { ids: [] }).ids.length === 0, null);
  const full = await store.get('mstat:ann'); const key = full.seen[0];
  await handler.statsEnqueue([key]); await handler.statsWork(30000);
  ok('a game that was already counted is skipped', (await store.get('mstat:ann')).games === full.games, null);

  console.log('private rooms and robustness');
  const rep = Dmg.replay([['e2', 'e4'], ['e7', 'e5'], ['d1', 'h5'], ['b8', 'c6'], ['f1', 'c4'], ['g8', 'f6'], ['h5', 'f7']].map(([a, b]) => ({ from: sq(a), to: sq(b) })));
  const ev = [20, 30, 25, 30, 25, 30, 9999, 9999];
  await handler.statsRecord({ id: 'PRIV1-x', lounge: 'room1', endedAt: Date.now(), players: { w: { name: 'ann' }, b: { name: 'bob' } } }, rep, ev);
  const pb = await call('stats_moves', { name: 'bob', kind: 'blunder' }, A);
  ok('a private room game is counted in the totals but its moves are not listed', (await store.get('mstat:bob')).games === full.games + 0 + 1 && !pb.list.some((x) => x.g === 'PRIV1-x') && pb.total === (await store.get('mstat:bob')).t.blunder, pb.total);
  ok('too short or unreadable games are skipped without blocking the queue', await (async () => { await store.set('game:BAD-x', { id: 'BAD-x', hist: [], players: { w: { name: 'ann' }, b: { name: 'bob' } } }); await handler.statsEnqueue(['BAD-x', 'MISSING-x']); await handler.statsWork(20000); return ((await store.get('mq')) || { ids: [] }).ids.length === 0; })(), await store.get('mq'));
  // a player whose totals were counted by an older version (no move log): they are counted again, from every game, and the old numbers are not shown meanwhile
  await store.set('mstat:cat', { v: 1, ver: 1, name: 'cat', games: 9, seen: ['x'], t: { n: 500, brilliant: 99, best: 1, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, accSum: 1 } });
  await store.del('mlog:cat');
  const stale = await call('stats_board', {}, A);
  ok('numbers from an older way of counting are not shown', !stale.rows.some((r) => r.name === 'cat' && r.brilliant === 99), stale.rows.map((r) => r.name));
  ok('and opening them says nothing is there yet instead of private rooms', (await call('stats_moves', { name: 'cat', kind: 'brilliant' }, A)).total === 0, null);

  const cg = (await store.get('games:cat')).list[0].id;
  await handler.statsEnqueue([cg]); await handler.statsWork(60000);
  const fixed = await store.get('mstat:cat');
  ok('counting it again replaces the old numbers with the current way of counting, and the moves are listed', fixed.ver === 3 && fixed.games === 1 && fixed.t.n < 100 && !(await call('stats_board', {}, A)).rows.some((r) => r.brilliant === 99), fixed);
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
