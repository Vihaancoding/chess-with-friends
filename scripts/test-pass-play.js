// Pass & play results: a game played on one device is sent to the opponent, who accepts (rated) or declines it.
// Drives the real API in-process with in-memory storage. Run: node scripts/test-pass-play.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
const handler = require('../lib/app');

let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };

function call(route, body, who) {
  return new Promise((resolve) => {
    const req = { method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body };
    const res = { writeHead(code) { this.code = code; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } };
    handler(req, res);
  });
}
const MATE = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];   // white mates
const tc = { base: 300, inc: 0 };
const blitz = (r) => r.user.ratings.blitz;

(async () => {
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const ann = await su('ann'), bob = await su('bob');

  console.log('sending a result');
  let r = await call('result_send', { opp: 'bob', color: 'w', gid: 'g1', tc, moves: MATE }, ann);
  ok('a finished game is accepted for sending', r.ok, r);
  const again = await call('result_send', { opp: 'bob', color: 'w', gid: 'g1', tc, moves: MATE }, ann);
  ok('sending the same game twice keeps one result', again.ok && again.id === r.id, again);
  let me = await call('me', {}, bob);
  ok('the opponent sees it waiting', me.results.length === 1 && me.results[0].from === 'ann' && me.results[0].result === 'w' && me.results[0].reason === 'checkmate', me.results);
  ok('nothing is rated yet', blitz(me).n === 0, blitz(me));

  console.log('bad results are refused');
  r = await call('result_send', { opp: 'bob', color: 'w', gid: 'g2', tc, moves: ['e2e4', 'e7e5', 'e1e3'] }, ann);
  ok('an illegal move', r.status === 400 && /illegal/.test(r.error), r);
  r = await call('result_send', { opp: 'bob', color: 'w', gid: 'g2', tc, moves: ['e2e4', 'e7e5'] }, ann);
  ok('an unfinished game with no resignation', r.status === 400 && /not finished/.test(r.error), r);
  r = await call('result_send', { opp: 'ann', color: 'w', gid: 'g2', tc, moves: MATE }, ann);
  ok('a result sent to yourself', r.status === 400, r);
  r = await call('result_send', { opp: 'nobody', color: 'w', gid: 'g2', tc, moves: MATE }, ann);
  ok('an unknown opponent', r.status === 404, r);
  r = await call('result_send', { opp: 'bob', color: 'w', gid: 'g2', tc: null, moves: ['e2e4', 'e7e5'], end: { result: 'w', reason: 'timeout' } }, ann);
  ok('a timeout in a game without a clock', r.status === 400, r);

  console.log('accepting');
  r = await call('result_answer', { id: me.results[0].id, accept: true }, bob);
  ok('accept rates the game', r.ok && r.accepted && r.rating && r.rating.delta < 0, r);
  const twice = await call('result_answer', { id: me.results[0].id, accept: true }, bob);
  ok('it cannot be accepted twice', twice.status === 404, twice);
  const mb = await call('me', {}, bob), ma = await call('me', {}, ann);
  ok('both blitz ratings moved', blitz(mb).n === 1 && blitz(ma).n === 1 && blitz(ma).r > blitz(mb).r, [blitz(ma), blitz(mb)]);
  ok('win/loss counted', ma.user.w === 1 && mb.user.l === 1, [ma.user, mb.user]);
  ok('the sender sees it was accepted, with their new rating', ma.resultsOut.length === 1 && ma.resultsOut[0].status === 'accepted' && ma.resultsOut[0].rating.delta > 0, ma.resultsOut);
  const ga = await call('games', { name: 'ann' }, ann), gb = await call('games', { name: 'bob' }, bob);
  ok('saved in both archives', ga.games.length === 1 && gb.games.length === 1 && ga.games[0].result === 'win' && gb.games[0].result === 'loss' && ga.games[0].rated, [ga.games, gb.games]);
  const g = await call('game_get', { id: ga.games[0].id }, ann);
  ok('the archived game replays', g.game && g.game.hist.length === 7 && g.game.local === true && g.game.opening, g.game);
  await call('result_dismiss', { id: ma.resultsOut[0].id }, ann);
  ok('the answer can be dismissed', (await call('me', {}, ann)).resultsOut.length === 0);

  console.log('declining');
  r = await call('result_send', { opp: 'bob', color: 'b', gid: 'g3', tc, moves: ['e2e4', 'e7e5'], end: { result: 'b', reason: 'resignation' } }, ann);
  ok('a resignation can be sent', r.ok, r);
  me = await call('me', {}, bob);
  r = await call('result_answer', { id: me.results[0].id, accept: false }, bob);
  ok('decline', r.ok && !r.accepted, r);
  const mb2 = await call('me', {}, bob), ma2 = await call('me', {}, ann);
  ok('no rating changed', blitz(mb2).n === 1 && blitz(ma2).n === 1, [blitz(ma2), blitz(mb2)]);
  ok('the sender sees it was declined', ma2.resultsOut[0].status === 'declined', ma2.resultsOut);

  console.log('retries and odd input');
  r = await call('result_send', { opp: 'bob', color: 'w', gid: 'g1', tc, moves: MATE }, ann);
  ok('a game that was already answered is not sent again', r.ok && (await call('me', {}, bob)).results.length === 0, r);
  r = await call('result_send', { opp: 'bob', color: 'w', gid: 'g4', tc, moves: MATE, startedAt: -5, endedAt: 1.5 }, ann);
  me = await call('me', {}, bob);
  ok('a bad start time is replaced', r.ok && Number.isSafeInteger(me.results[0].startedAt) && me.results[0].startedAt > 0, me.results[0]);
  const [first, second] = await Promise.all([true, true].map((accept) => call('result_answer', { id: me.results[0].id, accept }, bob)));
  ok('two answers at once: one counts, the other is told it is busy', [first, second].filter((x) => x.ok).length === 1 && [first, second].some((x) => x.status === 409 || x.status === 404), [first, second]);
  const mb3 = await call('me', {}, bob);
  ok('rated exactly once', blitz(mb3).n === 2, blitz(mb3));
  const gb3 = await call('games', { name: 'bob' }, bob), g3 = await call('game_get', { id: gb3.games[0].id }, bob);
  ok('its archived game opens', !!g3.game, g3);

  console.log('agreed draws');
  r = await call('result_send', { opp: 'bob', color: 'w', gid: 'g2', tc, moves: ['e2e4', 'e7e5'], end: { result: 'w', reason: 'agreement' } }, ann);
  ok('an agreed "win" is refused', r.status === 400, r);
  r = await call('result_send', { opp: 'bob', color: 'w', gid: 'gd', tc, moves: ['e2e4', 'e7e5'], end: { result: 'draw', reason: 'agreement' } }, ann);
  ok('an agreed draw can be sent', r.ok, r);
  me = await call('me', {}, bob);
  ok('the opponent sees the draw', me.results.some((x) => x.result === 'draw' && x.reason === 'agreement'), me.results);
  r = await call('result_answer', { id: me.results.find((x) => x.reason === 'agreement').id, accept: false }, bob);
  ok('declining it works', r.ok, r);
  for (const x of (await call('me', {}, ann)).resultsOut) await call('result_dismiss', { id: x.id }, ann);

  console.log('limits');
  for (const id of ['a', 'b', 'c']) await call('result_send', { opp: 'bob', color: 'w', gid: id, tc, moves: MATE }, ann);
  r = await call('result_send', { opp: 'bob', color: 'w', gid: 'd', tc, moves: MATE }, ann);
  ok('at most 3 unanswered results per sender', r.status === 429, r);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
