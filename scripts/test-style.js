// "Play against a style" tests: move times are archived, the style_games API, and the profile / clone logic
// in style.js and bot.js. Drives the real API in-process with in-memory storage. Run: node scripts/test-style.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
const handler = require('../lib/app');
const Chess = require('../public/chess.js');
const Style = require('../public/style.js');
const Bot = require('../public/bot.js');

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
async function game(w, b, tc, ucis, end) {
  const c = await call('create', { color: 'w', tc }, w);
  await call('join', { code: c.code }, b);
  for (const [i, u] of ucis.entries()) {
    const r = await call('move', { code: c.code, from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)), promo: u[4] ? u[4].toUpperCase() : undefined }, i % 2 ? b : w);
    if (!r.ok) throw new Error(`move ${u} failed: ${r.error}`);
    if (i === 3) await sleep(30);                                    // a measurable think
  }
  if (end) await end(c.code);
}
const same = (a, b) => a.from === b.from && a.to === b.to && (a.promo || undefined) === (b.promo || undefined);
const legal = (st, mv) => Chess.legalMoves(st).some((x) => same(x, mv));

(async () => {
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const alice = await su('alice'), bob = await su('bob');

  console.log('archived games keep move times');
  const ITALIAN = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'c2c3', 'g8f6', 'd2d3', 'd7d6', 'e1g1', 'e8g8'];
  await game(alice, bob, { base: 300, inc: 2 }, ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7']);
  await game(alice, bob, { base: 180, inc: 0 }, ITALIAN, (c) => call('resign', { code: c }, bob));
  await game(bob, alice, null, ['d2d4', 'e7e5', 'd4e5', 'b8c6', 'g1f3', 'd8e7', 'c1f4', 'e7b4', 'f4d2', 'b4b2'], (c) => call('resign', { code: c }, bob));
  let sg;
  for (let i = 0; i < 60; i++) { sg = await call('style_games', { name: 'ALICE' }, bob); if (sg.games && sg.games.length === 3) break; await sleep(25); }
  ok('style_games returns all three games, newest first, with the canonical name', sg.status === 200 && sg.name === 'alice' && sg.games.length === 3 && sg.total === 3, sg);
  const timed = sg.games.find((g) => g.moves.startsWith('e2e4 e7e5 g1f3'));
  ok('moves come as one UCI string', timed && timed.moves === ITALIAN.join(' '), timed && timed.moves);
  ok('timed games carry think times and clocks for every move', timed && timed.mt.length === ITALIAN.length && timed.ck.length === ITALIAN.length && timed.mt[4] >= 25 && timed.ck.every((x) => x > 0 && x <= 180000), timed && { mt: timed.mt, ck: timed.ck });
  const untimed = sg.games.find((g) => !g.tc);
  ok('untimed games carry think times but no clock', untimed && untimed.mt.length === 10 && untimed.ck == null, untimed && { mt: untimed.mt, ck: untimed.ck });
  ok('each game says which colour the player had, and their rating', sg.games.every((g) => (g.color === 'w' || g.color === 'b') && g.elo > 0) && untimed.color === 'b', sg.games.map((g) => [g.color, g.elo]));
  ok('unknown players are a 404', (await call('style_games', { name: 'nobody' }, bob)).status === 404);
  ok('needs a login', (await call('style_games', { name: 'alice' })).status === 401);

  console.log('profile');
  const P = Bot.buildProfile('alice', sg.games, 5);
  ok('profile covers the games and the player\'s rating', P.v === 2 && P.games === 3 && P.rating > 0 && P.last === sg.games[0].id, { games: P.games, rating: P.rating });
  ok('style scores are 0..100', [P.aggr, P.tact, P.risk].every((x) => x >= 0 && x <= 100), [P.aggr, P.tact, P.risk]);
  ok('most-used openings by colour, with scores', P.openings.w.length >= 1 && P.openings.w.every((o) => o.n >= 1 && o.score >= 0 && o.name) && P.openings.b.length === 1, P.openings);
  ok('first moves as White and replies as Black', P.first.w.e2e4 === 2 && P.first.d4.e7e5 === 1, P.first);
  ok('opening book holds the moves they chose', P.book[Style.bookKey(Chess.initial())].e2e4 === 2, P.book[Style.bookKey(Chess.initial())]);
  ok('tactics list (the checkmate Qxf7# is there)', P.tactics.some((t) => t.k === 'mate' && t.n === 1), P.tactics);
  ok('castling habit', P.castle.K > 0.3, P.castle);
  ok('mistakes analysed', P.err && P.err.graded > 0 && P.err.acc > 0, P.err);
  ok('time habits from the clock data', P.time && P.time.moves > 0 && P.time.avgSec >= 0, P.time);
  ok('profile has summary tags', Array.isArray(P.tags) && P.tags.length >= 2, P.tags);
  ok('profile survives JSON (it is cached in localStorage)', JSON.stringify(JSON.parse(JSON.stringify(P))) === JSON.stringify(P));

  console.log('tactics and endgames');
  const tac = (fen, u) => { const st = Chess.fromFEN(fen); return Style.features(st, Chess.findUci(st, u)).tac; };
  ok('fork', tac('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'b5c7').includes('fork'));
  ok('pin', tac('3qk3/8/8/8/8/8/8/R5K1 w - - 0 1', 'a1a8').includes('pin'));
  ok('skewer', tac('q7/8/8/k7/8/8/8/1R4K1 w - - 0 1', 'b1a1').includes('skewer'));
  ok('discovered attack', tac('4k3/4q3/8/8/4N3/8/8/4R1K1 w - - 0 1', 'e4c5').includes('discovered'));
  ok('checkmate', tac('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', 'a1a8').join() === 'mate');
  ok('a quiet move is no tactic', tac('4k3/8/8/8/8/8/8/R5K1 w - - 0 1', 'g1g2').length === 0);
  ok('endgame types', Style.endType(Chess.fromFEN('4k3/pp6/8/8/8/8/PP6/R3K2r w - - 0 1').board) === 'Rook endgame'
    && Style.endType(Chess.fromFEN('4k3/pp6/8/8/8/8/PP6/4K3 w - - 0 1').board) === 'Pawn endgame'
    && Style.endType(Chess.fromFEN('4k1n1/pp6/8/8/8/8/PP6/4KB2 w - - 0 1').board) === 'Bishop vs knight endgame');
  // a game that trades down into a rook ending
  const RE = { id: 'x', color: 'w', result: 'w', reason: 'resignation', moves: 'e2e4 d7d5 e4d5 d8d5 b1c3 d5a5 d1h5 a5h5 f1b5 c7c6 b5c6 b7c6 g1f3 h5f3 g2f3 c8h3 d2d4 h3f1 e1f1 b8d7 c1f4 g8f6 c3e4 f6e4 f3e4 d7e5 d4e5 h7h6 a1d1 a8d8 d1d8 e8d8', elo: 1300 };
  const PE = Style.profile('t', [RE, RE, RE]);
  ok('endgames they reach, with their score', PE.endgames.length && PE.endgames[0].name === 'Rook and minor piece endgame' && PE.endgames[0].n === 3 && PE.endgames[0].score === 100 && PE.reachedEnd === 1, PE.endgames);

  console.log('playing like them');
  const st0 = Chess.initial();
  let bookHits = 0;
  for (let i = 0; i < 10; i++) { const r = Bot.styledMove(st0, P, { ply: 0, msScale: 0.2 }); if (r.why === 'book' && r.move.from === sq('e2') && r.move.to === sq('e4')) bookHits++; }
  ok('from the start it plays their own first move (book)', bookHits === 10, bookHits);
  const mid = Chess.fromFEN('r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R1BQ1RK1 w - - 0 1');
  const r1 = Bot.styledMove(mid, P, { ply: 20, msScale: 0.3, diff: 'true' });
  ok('out of book it plays a legal move picked by the model', r1 && legal(mid, r1.move) && ['style', 'blunder', 'mistake'].includes(r1.why), r1);
  const aMid = Bot.scoreAll(mid, 400, Style.DEPTH);
  ok('the engine reports every move at each depth it reached', aMid.layers.length >= 2 && aMid.layers.every((L) => Object.keys(L).length === aMid.legal), aMid.layers.map((L) => Object.keys(L).length));
  const cands = Style.candidates(mid, aMid, {});
  ok('candidates: up to 16 moves, one value per model feature', cands.length === 16 && cands.every((c) => c.x.length === Style.FEAT.length && c.x.every(Number.isFinite)), cands.length);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // a player who only looks one move ahead: difficulty makes them see deeper
  const F = (n) => Style.FEAT.indexOf(n), shallowW = Style.W0.slice();
  shallowW[F('loss1')] = -3; shallowW[F('loss2')] = 0; shallowW[F('loss3')] = 0;
  const shallow = { ...P, book: {}, model: { w: shallowW } };
  // back-rank trap: Rxd7 wins a pawn as seen one move ahead, but ...Re1 is mate
  const trap = Chess.fromFEN('4r1k1/3p1ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1'), aTrap = Bot.scoreAll(trap, 400, Style.DEPTH);
  const grabs = (diff) => { seed = 7; let n = 0; for (let i = 0; i < 300; i++) if (Style.uci(Style.choose(trap, aTrap, shallow, { ply: 30, diff, rnd }).move) === 'd1d7') n++; return n; };
  const offDay = grabs('easy'), trueForm = grabs('true'), bestDay = grabs('best');
  ok('a player who looks one move ahead falls for the back-rank trap', trueForm > 60, { trueForm });
  ok('difficulty: on their best day they see it and stop grabbing', bestDay < trueForm / 3 && offDay > bestDay * 3, { offDay, trueForm, bestDay });
  const pr = Style.predict(st0, Bot.scoreAll(st0, 100, 1), P, { ply: 0 });
  ok('prediction from the start is their usual first move', pr.move === 'e2e4' && pr.top.length === 3 && pr.book, pr);

  console.log('learning from their moves');
  // synthetic positions: 12 candidates each; this "player" always picks a check when there is one, else the best move
  const D = Style.FEAT.length, rowsFor = (n, pick) => Array.from({ length: n }, (_, k) => {
    const c = Array.from({ length: 12 }, (_, j) => { const x = new Array(D).fill(0); x[0] = x[1] = x[2] = j * 0.4; if ((j + k) % 5 === 0 && j) x[F('check')] = 1; return { u: 'm' + j, x }; });
    return { c, k: pick(c), ply: 30, bk: 'none' };
  });
  const checker = (c) => { const i = c.findIndex((x) => x.x[F('check')]); return i >= 0 ? i : 0; };
  const wC = Style.fit(rowsFor(150, checker));
  ok('learns that they love checks', wC[F('check')] > Style.W0[F('check')] + 1.5, wC[F('check')]);
  const sc = Style.evalRows(rowsFor(60, checker), wC, {});
  ok('…and then predicts their held-out moves', sc.top1 > 0.9, sc);
  ok('the generic model does much worse on them', Style.evalRows(rowsFor(60, checker), Style.W0, {}).top1 < 0.5);
  // depth: chosen move is best as seen one move ahead but bad three moves ahead
  const blind = Array.from({ length: 150 }, (_, k) => {
    const c = Array.from({ length: 8 }, (_, j) => { const x = new Array(D).fill(0); x[0] = j === 3 ? 0 : 1 + j * 0.3; x[1] = x[0]; x[2] = j === 3 ? 2 : j * 0.3; return { u: 'm' + j, x }; });
    return { c, k: 3, ply: 30, bk: 'none' };
  });
  const wB = Style.fit(blind);
  ok('learns how deep they look (shallow loss matters more than deep)', wB[F('loss1')] < wB[F('loss3')], [wB[F('loss1')], wB[F('loss3')]]);
  ok('the backtest uses their book first', Style.evalRows([{ c: [{ u: 'a', x: new Array(D).fill(0) }, { u: 'b', x: new Array(D).fill(0) }], k: 1, ply: 2, bk: 'K' }], Style.W0, { K: { b: 3 } }).top1 === 1);

  console.log('backtest and timing in a profile');
  // ten quick games between two engines; one side plays fast on forced moves and slow on hard ones
  const games10 = [];
  for (let g = 0; g < 10; g++) {
    let st = Chess.initial(); const ms = [], ucis = [];
    for (let i = 0; i < 36 && !Chess.status(st).over; i++) {
      const r = Bot.chooseMove(st, 1, null, 0.05), m = Chess.legalMoves(st).find((x) => same(x, r.move));
      ms.push(Math.round(1500 * Math.exp(0.6 * Math.sin(i * 7.3 + g)) * (Chess.legalMoves(st).length < 8 ? 0.3 : 1.5)));
      ucis.push(Style.uci(m)); st = Chess.apply(st, m);
    }
    games10.push({ id: 'q' + g, color: g % 2 ? 'b' : 'w', moves: ucis.join(' '), mt: ms, result: 'draw', elo: 900 });
  }
  const PQ = Bot.buildProfile('q', games10, 5);
  ok('profile v2 has a learned move model', PQ.v === 2 && PQ.model && PQ.model.w.length === D && PQ.model.n > 50, PQ.model && PQ.model.n);
  ok('backtest on 2 held-out games: exact and top-3 rates, engine baseline', PQ.backtest && PQ.backtest.games === 2 && PQ.backtest.top3 >= PQ.backtest.top1 && PQ.backtest.engine >= 0 && PQ.backtest.moves >= 15, PQ.backtest);
  ok('timing model fitted from their move times', PQ.timeModel && PQ.timeModel.w.length === Style.TFEAT.length && PQ.timeModel.sigma > 0 && PQ.backtest.time >= 1, { tm: PQ.timeModel, bt: PQ.backtest });
  ok('it learned they move faster with few legal moves', PQ.timeModel.w[Style.TFEAT.indexOf('manyMoves')] > 0, PQ.timeModel.w);
  const tP = { timeModel: { w: [1, 0, 0, 0, 0, 0, 0, -2, -1, 1, -0.5, 0], sigma: 0.3 } }, avg = (o) => { seed = 3; let t = 0; for (let i = 0; i < 400; i++) t += Style.thinkTime(tP, o, rnd); return t / 400; };
  const base = { ph: 'm', ply: 30, legal: 30, timed: false };
  ok('think time: forced moves are quick, hard choices slow', avg({ ...base, legal: 1 }) < avg(base) / 3 && avg({ ...base, hard: true }) > avg(base) * 2, [avg({ ...base, legal: 1 }), avg(base), avg({ ...base, hard: true })]);
  const rT = Bot.styledMove(mid, PQ, { ply: 20, msScale: 0.3 });
  ok('the clone returns how long to think', rT && typeof rT.think === 'number' && rT.think >= 0, rT);
  const rTimed = Bot.styledMove(mid, PQ, { ply: 20, msScale: 0.3, clock: { left: 60000, base: 180 } });
  ok('no think time for a timed game when they only played untimed ones (the page falls back)', rTimed && rTimed.think === null, rTimed);
  ok('backtest counts the held-out games that were really used', PQ.backtest.games === 2, PQ.backtest);

  console.log('comparison');
  let st = Chess.initial(); const H = [], states = [st];
  for (const u of ITALIAN) { const m = Chess.findUci(st, u); H.push({ from: m.from, to: m.to }); st = Chess.apply(st, m); states.push(st); }
  const an = [];
  Bot.compareGame(states.slice(0, -1), H, 'w', P, 30, (o) => an.push(o));
  ok('every ply scored; predictions only for the human side', an.length === ITALIAN.length && an.filter((a) => a.pred).length === 6 && an.every((a) => (a.i % 2 === 0) === !!a.pred), an.map((a) => [a.i, !!a.pred]));
  ok('the opening moves were predicted (they are in the book)', an[0].pred === 'e2e4' && an[2].pred === 'g1f3', [an[0].pred, an[2].pred]);
  const ws = Style.sideStats(Style.sideRecords(H, 'w', an));
  const sim = Style.similarity(ws, P, { book: Style.bookShare(H, 'w', P), castle: 1 });
  ok('replaying their own game scores a high similarity', sim >= 60 && sim <= 100, { sim, ws: { aggr: ws.aggr, tact: ws.tact, risk: ws.risk }, P: { aggr: P.aggr, tact: P.tact, risk: P.risk } });
  ok('book share of their own game is 100%', Style.bookShare(H, 'w', P) === 1);
  const far = Style.similarity({ ...ws, aggr: 100 - P.aggr, tact: 100 - P.tact, risk: 100 - P.risk, acc: 20, rates: { ...ws.rates, trade: 1 - P.rates.trade } }, P, { book: 0, castle: 0 });
  ok('an opposite style scores lower', far < sim - 25, { far, sim });

  console.log('clone alerts');
  const MATE = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
  const tell = (body) => call('clone_played', { name: 'bob', color: 'w', diff: 'sharp', moves: MATE, ...body }, alice);
  ok('playing a friend\'s clone is reported', (await tell({ gid: 'g1' })).status === 200);
  let cl = (await call('me', {}, bob)).clones;
  ok('they see who played it, how it went (replayed: checkmate), the difficulty and the length', cl.length === 1 && cl[0].from === 'alice' && cl[0].result === 'w' && cl[0].reason === 'checkmate' && cl[0].moves === 7 && cl[0].diff === 'sharp' && cl[0].games === 1 && !cl[0].gids, cl);
  await tell({ gid: 'g1' });
  ok('a retry of the same game is not counted twice', (await call('me', {}, bob)).clones[0].games === 1);
  await tell({ gid: 'g2', color: 'b', moves: ['e2e4', 'e7e5'], end: { result: 'w', reason: 'resignation' } });
  cl = (await call('me', {}, bob)).clones;
  ok('more games from the same player update one alert', cl.length === 1 && cl[0].games === 2 && cl[0].reason === 'resignation' && cl[0].color === 'b', cl);
  ok('your own clone: no alert', (await call('clone_played', { name: 'alice', gid: 'g3', color: 'w', moves: MATE }, alice)).skipped === true && (await call('me', {}, alice)).clones.length === 0);
  ok('an unfinished game is refused', (await tell({ gid: 'g4', moves: ['e2e4', 'e7e5'] })).status === 400);
  ok('an illegal game is refused', (await tell({ gid: 'g5', moves: ['e2e5', 'e7e5'] })).status === 400);
  ok('unknown player', (await call('clone_played', { name: 'nobody', gid: 'g6', color: 'w', moves: MATE }, alice)).status === 404);
  await call('clone_dismiss', { id: cl[0].id }, bob);
  ok('OK dismisses it', (await call('me', {}, bob)).clones.length === 0);
  await tell({ gid: 'g2', color: 'b', moves: ['e2e4', 'e7e5'], end: { result: 'w', reason: 'resignation' } });
  ok('a late retry of a dismissed game does not bring it back', (await call('me', {}, bob)).clones.length === 0);
  await tell({ gid: 'g7' });
  cl = (await call('me', {}, bob)).clones;
  ok('a new game after dismissing starts a fresh alert', cl.length === 1 && cl[0].games === 1, cl);
  let capped = null;
  for (let i = 0; i < 40 && !capped; i++) { const r = await tell({ gid: 'cap' + i }); if (r.status === 429) capped = i; }
  ok('one player can report at most 30 games a day', capped === 27, capped);   // g1, g2 and g7 already count today

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
