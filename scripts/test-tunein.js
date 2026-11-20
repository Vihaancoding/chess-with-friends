// LIVE TUNE-IN: the excitement rules (lib/tunein.js) and the API flow (lib/app.js): leases, duplicate observers, batches that
// are out of order or implausible, players never analysing their own game, the feed's events and what it leaves out.
// Run: node scripts/test-tunein.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
process.env.ADMIN_KEY = 'test-admin-key'; delete process.env.ANTHROPIC_API_KEY;
const handler = require('../lib/app');
const T = require('../lib/tunein.js');
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
const LONG = fx[9].ucis;   // a 50-ply game
const hOf = (u) => ({ from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)), promo: u[4] ? u[4].toUpperCase() : undefined });

(async () => {
  console.log('the rules');
  // normalise: the side to move's view becomes White's view; mates become the capped mate value
  ok('side to move black: the score is flipped to White', T.normalise(40, 'b') === -40 && T.normalise(40, 'w') === 40);
  ok('a mate for the side to move is capped, with the right sign', T.normalise(99990, 'w') === T.MATE_CP && T.normalise(-99990, 'b') === T.MATE_CP);
  ok('a number that is not an evaluation is refused', T.normalise(1e9, 'w') === null && T.normalise(NaN, 'w') === null);

  // a batch: implausible jumps end it, mates may jump
  ok('a plausible batch is kept whole', T.checkBatch(20, [30, 60, 0]).ok.length === 3);
  const j = T.checkBatch(20, [30, 2000, 10]);
  ok('a 2000-centipawn jump in one move ends the batch', j.ok.length === 1 && j.rejected === 2, j);
  ok('a jump to or from a mate is allowed', T.checkBatch(20, [T.MATE_CP]).ok.length === 1 && T.checkBatch(T.MATE_CP, [-200]).ok.length === 1);

  // sacrifice: 1.e4 e5 2.Qh5 Nc6 3.Qxf7+ Kxf7 — the queen is given for a pawn; only a real compensation counts
  const sac = [{ from: sq('e2'), to: sq('e4') }, { from: sq('e7'), to: sq('e5') }, { from: sq('d1'), to: sq('h5') }, { from: sq('b8'), to: sq('c6') },
    { from: sq('h5'), to: sq('f7') }, { from: sq('e8'), to: sq('f7') }];
  const withComp = T.analyse(sac, [20, 20, 20, 20, 20, 30, 40], null);
  ok('a queen given for a pawn, with compensation, is a sacrifice', withComp.sacrifices === 1 && withComp.events.some((e) => e.kind === 'sacrifice' && e.ply === 5), withComp.events);
  const noComp = T.analyse(sac, [20, 20, 20, 20, 20, 30, -900], null);
  ok('the same material loss with no compensation is not', noComp.sacrifices === 0, noComp.events);

  // blunder: the mover was level and gives away 2+ pawns
  const bl = T.analyse(sac.slice(0, 3), [20, 20, 20, -300], null);
  ok('giving away 3 pawns from level is a meaningful blunder', bl.blunders === 1 && bl.events.some((e) => e.kind === 'blunder'), bl);

  // comeback: a side three pawns down later stands level or better
  const cb = T.analyse(sac, [20, 20, -350, -360, -340, -20, 120], null);
  ok('a comeback from -3 to level is detected once', cb.comebacks >= 1 && cb.events.some((e) => e.kind === 'comeback'), cb.comebacks);

  // time scramble: both clocks under 10s for 8 moves in a row
  const hist50 = LONG.map(hOf), ev50 = hist50.map(() => 15);
  ev50.unshift(20);
  const sc = T.analyse(hist50, ev50, hist50.map(() => 5000));          // the mover had 5 s left after every move
  ok('8 moves in a row with under 10s left is a time scramble', sc.scrambles >= 1 && sc.events.some((e) => e.kind === 'time'), sc.scrambles);
  ok('the same moves with plenty of time are not', T.analyse(hist50, ev50, hist50.map(() => 60000)).scrambles === 0);
  ok('runs broken by a comfortable move every 5th are not a scramble', T.analyse(hist50, ev50, hist50.map((_, i) => (i % 5 === 4 ? 60000 : 5000))).scrambles === 0);
  ok('an untimed game has no time events', T.analyse(hist50, ev50, null).scrambles === 0);

  // calm game: an eval that follows material (a stand-in for a real engine). Trades change nothing; nothing is announced.
  const V = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 }, mat = (st) => st.board.reduce((a, p) => a + (p ? (p[0] === 'w' ? 1 : -1) * V[p[1]] : 0), 0);
  const calmEv = T.replay(hist50).map((st) => 100 * mat(st));
  const calm = T.analyse(hist50, calmEv, null);
  const announced = calm.events.filter((e) => ['sacrifice', 'comeback', 'time'].includes(e.kind));
  ok('a game where every trade is even announces no sacrifice, comeback or time scramble', calm.sacrifices === 0 && announced.length === 0, announced);
  ok('a level, quiet game scores moderately', calm.raw < 40, calm.raw);
  ok('a level, quiet game (+0.15 all along) scores moderately and announces nothing', calm.raw < 40 && calm.events.filter((e) => ['sacrifice', 'comeback', 'time'].includes(e.kind)).length === 0, calm.raw);

  // smoothing and hysteresis
  const s1 = T.smooth(null, 80), s2 = T.smooth({ ema: 80, shown: 80 }, 84), s3 = T.smooth({ ema: 80, shown: 80 }, 40);
  ok('the first score is shown as it is', s1.shown === 80);
  ok('a small move does not change the shown number', s2.shown === 80 && s2.ema !== 80);
  ok('a real change moves the shown number', s3.shown !== 80);

  // events: deduped by id, and a cooldown between events of one kind
  const now = Date.now(), last = {};
  const first = T.fresh([{ kind: 'sacrifice', ply: 10, why: 'x' }], [], last, now);
  const again = T.fresh([{ kind: 'sacrifice', ply: 10, why: 'x' }], first, last, now + 1000);
  const soon = T.fresh([{ kind: 'sacrifice', ply: 12, why: 'y' }], first, last, now + 2000);
  ok('an event is announced once', first.length === 1 && again.length === 0);
  ok('a second of the same kind waits out the cooldown', soon.length === 0);

  // picking: never a game its players are in, never one another browser is analysing, never a fresh one that is up to date
  const live = [{ code: 'AAAAA', w: { name: 'ann' }, b: { name: 'bob' }, moves: 40 }, { code: 'BBBBB', w: { name: 'cat' }, b: { name: 'dan' }, moves: 40 }, { code: 'CCCCC', w: { name: 'eve' }, b: { name: 'fay' }, moves: 40 }];
  const pick = T.pickGame(live, [null, null, null], [null, { by: 'gus', at: now }, null], now, 'ann');
  ok('a browser never picks a game it plays in', live[pick].code !== 'AAAAA', pick);
  ok('a game another browser holds a lease on is skipped', live[pick].code !== 'BBBBB');
  const fresh = T.pickGame(live, [null, null, { ply: 40, at: now }], [null, null, null], now, 'zed');
  ok('a fresh, up-to-date analysis is not picked again', live[fresh].code !== 'CCCCC', fresh);

  // the ranking: fresh only; the featured game needs samples and a long enough game
  const ents = [{ code: 'X', fresh: true, score: 70, sustain: 20 }, { code: 'Y', fresh: false, score: 99, sustain: 90 }, { code: 'Z', fresh: true, score: 50, sustain: 40 }];
  ok('the ranking leaves out games without a fresh analysis', T.rank(ents).map((e) => e.code).join() === 'X,Z', T.rank(ents));
  const f = T.featured([{ code: 'P', fresh: true, ply: 30, samples: [60, 62, 61] }, { code: 'Q', fresh: true, ply: 30, samples: [90] }]);
  ok('the featured game is the most sustained, not the single spike', f && f.code === 'P', f);

  console.log('the API flow');
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = {}; for (const n of ['ann', 'bob', 'cat', 'dan', 'eve', 'gus']) P[n] = await su(n);
  const g = await call('create', { color: 'w', tc: { base: 300, inc: 0 } }, P.ann);
  await call('join', { code: g.code }, P.bob);
  for (let i = 0; i < 44; i++) await call('move', { code: g.code, ...hOf(LONG[i]) }, i % 2 ? P.bob : P.ann);

  const claimAnn = await call('tunein_claim', {}, P.ann);
  ok('a player of the game is never given it to analyse', !(claimAnn.job && claimAnn.job.code === g.code), claimAnn);

  const claim = await call('tunein_claim', {}, P.cat);
  ok('an observer is given a live game to analyse, with the moves so far', claim.job && claim.job.hist.length === 44 && claim.job.from === 0, claim);
  const code = claim.job.code;

  // evaluations, side to move's view, 25 cp everywhere: a calm game
  const batch = (n, from = 0) => Array.from({ length: n }, () => 25);
  const bad = await call('tunein_submit', { code, from: 0, evals: batch(10) }, P.dan);
  ok('a browser without the lease cannot send evaluations', bad.status === 409, bad);
  const wrong = await call('tunein_submit', { code, from: 5, evals: batch(10) }, P.cat);
  ok('an out-of-order batch is answered with where the record stands', wrong.resync === 0, wrong);
  const sub = await call('tunein_submit', { code, from: 0, evals: batch(20), clk: null }, P.cat);
  ok('the lease holder\'s batch is stored', sub.ply === 19 && typeof sub.score === 'number', sub);
  const dup = await call('tunein_submit', { code, from: 0, evals: batch(20) }, P.cat);
  ok('a repeated batch is not counted twice', dup.resync === 20, dup);
  const jump = await call('tunein_submit', { code, from: 20, evals: [25, 3000, 25] }, P.cat);
  ok('an implausible jump is rejected, the rest of the batch is not stored', jump.ply === 20 && jump.rejected === 2, jump);
  await call('tunein_submit', { code, from: 20, evals: batch(24) }, P.cat);

  const feedEve = await call('tunein_feed', { since: 0, watch: '' }, P.eve);
  ok('the feed ranks the game with a fresh analysis', feedEve.ranked.some((e) => e.code === code && e.status === 'live'), feedEve.ranked.map((e) => e.code));
  const feedBob = await call('tunein_feed', { since: 0, watch: '' }, P.bob);
  ok('a player of the game does not see it in the feed', !feedBob.ranked.some((e) => e.code === code));
  const feedWatch = await call('tunein_feed', { since: 0, watch: code }, P.eve);
  ok('the game being watched is left out of the feed', !feedWatch.ranked.some((e) => e.code === code));

  const unknown = await call('tunein_submit', { code: 'NOPE1', from: 0, evals: batch(3) }, P.cat);
  ok('an unknown game is refused', unknown.status === 404, unknown);

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
