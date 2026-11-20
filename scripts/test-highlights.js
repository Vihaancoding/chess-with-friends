// HIGHLIGHT REELS: which moments are worth a reel (lib/highlights.js), one reel per game, the filters and trending, and the
// end-to-end path (lib/app.js): a checked analysis with a big swing becomes a stored reel the feed shows.
// Run: node scripts/test-highlights.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
process.env.ADMIN_KEY = 'test-admin-key'; delete process.env.ANTHROPIC_API_KEY;
const handler = require('../lib/app');
const HL = require('../lib/highlights.js');
const fx = require('./fixtures/damage-games.json');

let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };
function call(route, body, who) {
  return new Promise((resolve) => {
    const req = { method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body };
    const res = { setHeader() {}, writeHead(code) { this.code = code; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } };
    handler(req, res);
  });
}
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
const hOf = (u) => ({ from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)), promo: u[4] ? u[4].toUpperCase() : undefined });
const none = { events: [], raw: 0 };
const base = { over: false, winner: null, w: { name: 'ann', elo: 1200 }, b: { name: 'bob', elo: 1200 }, lastEval: 0, lastPly: 40, streak: null };

(async () => {
  console.log('the moments');
  ok('a quiet game has no reel', HL.candidates(none, base, 'AAAAA').length === 0);
  ok('a swing of 14 pawns gets a reel with its headline', (() => {
    const c = HL.candidates({ events: [{ kind: 'swing', ply: 9, side: 'b', mag: 1400, why: 'x' }], raw: 50 }, base, 'BBBBB');
    return c.length === 1 && c[0].kind === 'swing' && c[0].headline === 'A 14.0-POINT SWING IN ONE MOVE.' && c[0].score >= 60;
  })());
  ok('a small swing (3 pawns) is not worth a reel', HL.candidates({ events: [{ kind: 'swing', ply: 9, side: 'b', mag: 300 }], raw: 30 }, base, 'CCCCC').length === 0);
  ok('a comeback from -8 that is winning now gets a reel', (() => {
    const c = HL.candidates({ events: [{ kind: 'comeback', ply: 30, side: 'w', low: -800 }], raw: 60 }, { ...base, lastEval: 300 }, 'DDDDD');
    return c.length === 1 && c[0].headline === 'FROM -8 TO VICTORY.';
  })());
  ok('a comeback that is not winning does not', HL.candidates({ events: [{ kind: 'comeback', ply: 30, side: 'w', low: -800 }], raw: 60 }, { ...base, lastEval: -50 }, 'EEEEE').length === 0);
  ok('a sacrifice names the piece', (() => {
    const c = HL.candidates({ events: [{ kind: 'sacrifice', ply: 14, side: 'w', piece: 'R' }], raw: 40 }, { ...base, lastEval: 150 }, 'FFFFF');
    return c.length === 1 && c[0].headline === 'THE ROOK WAS SACRIFICED. THE POSITION WAS WON.';
  })());
  ok('an upset: 400 points lower-rated wins a finished game', (() => {
    const c = HL.candidates(none, { ...base, over: true, winner: 'w', w: { name: 'ann', elo: 1600 }, b: { name: 'bob', elo: 2000 } }, 'GGGGG');
    return c.length === 1 && c[0].kind === 'upset' && c[0].headline === 'THE 2000 FALLS. An unexpected upset.';
  })());
  ok('a 100-point gap is not an upset', HL.candidates(none, { ...base, over: true, winner: 'w', w: { name: 'ann', elo: 1500 }, b: { name: 'bob', elo: 1600 } }, 'HHHHH').length === 0);
  ok('a streak broken gets the headline', (() => {
    const c = HL.candidates(none, { ...base, over: true, winner: 'b', streak: { len: 17, victim: 'ann', breakerSide: 'b' } }, 'IIIII');
    return c.length === 1 && c[0].headline === '17 WINS. ONE DEFEAT. A streak comes to an end.';
  })());
  ok('a streak is only broken by the winner of the game', HL.candidates(none, { ...base, over: true, winner: 'w', streak: { len: 17, victim: 'ann', breakerSide: 'b' } }, 'JJJJJ').length === 0);
  ok('time-scramble win gets a bigger score than a time-scramble game', (() => {
    const win = HL.candidates({ events: [{ kind: 'time', ply: 30, side: 'w' }], raw: 40 }, { ...base, over: true, winner: 'w' }, 'KKKKK')[0];
    const lost = HL.candidates({ events: [{ kind: 'time', ply: 30, side: 'w' }], raw: 40 }, base, 'LLLLL')[0];
    return win && lost && win.score > lost.score;
  })());

  console.log('one reel per game, filters, trending');
  const list = [
    { id: 'A:swing:1', code: 'A', kind: 'swing', score: 78, at: Date.now() - 1000 },
    { id: 'A:upset:9', code: 'A', kind: 'upset', score: 90, at: Date.now() - 500 },
    { id: 'B:comeback:4', code: 'B', kind: 'comeback', score: 80, at: Date.now() - 2000 },
    { id: 'C:streak:3', code: 'C', kind: 'streak', score: 85, at: Date.now() - 3000 },
    { id: 'D:upset:5', code: 'D', kind: 'upset', score: 70, at: Date.now() - 5 * 86400e3 },
  ];
  const f = HL.feedOf(list, 'all', Date.now(), 40);
  ok('a game shows once, with its strongest moment', f.filter((h) => h.code === 'A').length === 1 && f.find((h) => h.code === 'A').kind === 'upset');
  ok('the feed is strongest first (A 90, C 85, B 80, D 70)', f.map((h) => h.code).join() === 'A,C,B,D', f.map((h) => h.code + ':' + h.score));
  ok('the upsets filter shows only upsets', HL.feedOf(list, 'upsets', Date.now(), 40).every((h) => h.kind === 'upset'));
  ok('the streak filter shows only streak breakers', HL.feedOf(list, 'streaks', Date.now(), 40).map((h) => h.code).join() === 'C');
  ok('trending keeps the last 48 hours only', HL.trending(list, Date.now()).every((h) => Date.now() - h.at < 48 * 3600e3));

  console.log('finished games');
  const recs = [{ id: 'X:swing:3', code: 'X', over: false, result: null }, { id: 'Y:swing:4', code: 'Y', over: false }];
  const done = HL.finishRecords(recs, 'X', { result: 'w', reason: 'resignation', gid: 'X-abc' });
  ok('a game that ends marks its reels done, with the result', done[0].over && done[0].result === 'w' && done[0].gid === 'X-abc' && !done[1].over);
  ok('nothing changes while the game is still going', HL.finishRecords(recs, 'X', null) === recs);

  console.log('the API flow');
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = {}; for (const n of ['ann', 'bob', 'cat']) P[n] = await su(n);
  const g = await call('create', { color: 'w', tc: { base: 300, inc: 0 } }, P.ann);
  await call('join', { code: g.code }, P.bob);
  const LONG = fx[9].ucis;
  for (let i = 0; i < 12; i++) await call('move', { code: g.code, ...hOf(LONG[i]) }, i % 2 ? P.bob : P.ann);
  const claim = await call('tunein_claim', {}, P.cat);
  ok('a browser is given the game to analyse', claim.job && claim.job.code === g.code, claim);
  // raw scores are for the side to move: a calm 20 everywhere, then a sudden 1420 for the side to move at position 6
  const raw = Array.from({ length: 13 }, (_, k) => (k === 6 ? 1420 : 20));
  const sub = await call('tunein_submit', { code: g.code, from: 0, evals: raw }, P.cat);
  ok('the analysis with the swing is accepted', sub.status !== 400 && sub.ply === 12, sub);
  const feed = await call('highlight_feed', { filter: 'all' }, P.bob);
  const reel = (feed.feed || []).find((h) => h.code === g.code);
  ok('the big swing becomes a reel in the feed', reel && reel.kind === 'swing' && reel.headline === 'A 14.4-POINT SWING IN ONE MOVE.', feed.feed);
  ok('the reel carries the moves for its board', reel && reel.moves.length === 12, reel && reel.moves.length);
  ok('an ongoing game has no result yet', reel && reel.result === null);
  ok('the upsets filter does not show it', !((await call('highlight_feed', { filter: 'upsets' }, P.bob)).feed || []).some((h) => h.code === g.code));
  ok('the trending strip shows the strong swing', ((await call('highlight_feed', { filter: 'all' }, P.bob)).trending || []).some((h) => h.code === g.code));

  const rs = await call('resign', { code: g.code }, P.bob);
  ok('a resignation ends the game', rs.status === 200 && rs.ok !== false, rs);
  const after = await call('highlight_feed', { filter: 'all' }, P.bob);
  const rr = (after.feed || []).find((h) => h.code === g.code);
  ok('a reel of a game that has ended is marked done, with no time left', rr && rr.done === true && rr.left === null, rr && { done: rr.done, left: rr.left, over: rr.over });
  ok('a finished reel records the result', rr && rr.over === true && rr.result === 'w', rr && { over: rr.over, result: rr.result });

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
