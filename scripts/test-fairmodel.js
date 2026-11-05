// The fair-play statistical model: levels, evidence, history, and the held-out benchmark. Run: node scripts/test-fairmodel.js
const fs = require('fs'), path = require('path');
const M = require('../lib/fairmodel');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };

// rows: [i, ev, rank, loss, gap, nl, tact, t]
const mk = (n, f) => Array.from({ length: n }, (_, k) => f(k));
const engine = (n, rating = 1500) => mk(n, (k) => [20 + 2 * k, 40, 1, 0, [10, 60, 130, 300][k % 4], 30, k % 3 === 0 ? 1 : 0, 3000]);
// a genuine mix at about the baseline rate: sometimes the engine's move, sometimes not, with the odd blunder
const human = (n, seed = 1) => { let a = seed; const r = () => { a = (a * 1664525 + 1013904223) % 4294967296; return a / 4294967296; }; return mk(n, (k) => { const x = r(), loss = x < 0.4 ? 0 : x < 0.8 ? 20 + r() * 40 : x < 0.95 ? 60 + r() * 80 : 200 + r() * 200; return [20 + 2 * k, 30, x < 0.4 ? 1 : 2 + (x > 0.8 ? 1 : 0), Math.round(loss), [10, 60, 130, 300][k % 4], 30, k % 3 === 0 ? 1 : 0, 1500 + Math.round(r() * 9000)]; }); };

console.log('the model');
const e = M.assess(engine(24), { rating: 1500, tc: 'blitz' });
ok('a game of engine first choices is rated far outside human play', e.p < 1e-4 && e.level >= 3, [e.p, e.level]);
ok('every assessment carries an evidence explanation', e.evidence.length >= 4 && e.evidence.some((x) => /legitimate player/.test(x)), e.evidence);
const h = M.assess(human(24), { rating: 1500, tc: 'blitz' });
ok('a genuine-looking game is Normal', h.level <= 2 && h.p > 0.001, [h.level, h.p]);
ok('too few positions is not judged', M.assess(engine(5), { rating: 1500 }).level === 1 && M.assess(engine(5), { rating: 1500 }).evidence[0].includes('not enough'), null);
ok('playing several engine-best moves is not enough by itself', M.assess([...engine(4), ...human(16)], { rating: 1500, tc: 'blitz' }).level <= 2, null);
ok('levels have names', M.LEVELS[1] === 'Normal' && M.LEVELS[3] === 'Suspicious' && /High-confidence/.test(M.LEVELS[4]) && /Confirmed/.test(M.LEVELS[5]), M.LEVELS);
ok('the same moves are less surprising from a stronger player', M.assess(human(24, 3).map((r) => [r[0], r[1], 1, 0, r[4], r[5], r[6], r[7]]), { rating: 2400, tc: 'blitz' }).p > M.assess(human(24, 3).map((r) => [r[0], r[1], 1, 0, r[4], r[5], r[6], r[7]]), { rating: 800, tc: 'blitz' }).p, null);
ok('decided positions are not counted', M.assess(engine(24).map((r) => [r[0], 900, ...r.slice(2)]), { rating: 1500 }).n === 0, null);
const noMs = M.assess(engine(24).map((r) => [...r.slice(0, 7), 0]), { rating: 1500, tc: 'blitz' });
ok('without move times the performance evidence still works and times are simply absent', noMs.zTime === null && noMs.level >= 2, [noMs.zTime, noMs.level]);

console.log('level 4 needs more than a score');
const base = engine(24);
const a4 = M.assess(base, { rating: 1500, tc: 'blitz', ext: 1 });
ok('a very unlikely game with supporting evidence is High-confidence', a4.level === 4 && a4.auto && a4.corroboration.length >= 2, [a4.level, a4.corroboration]);
const sparse = M.assess(mk(24, (k) => (k % 2 ? [20 + 2 * k, 40, 1, 0, 300, 30, 0, 3000] : [20 + 2 * k, 40, 1, 0, 300, 30, 0, 800 + 5000 * (k % 3)])), { rating: 1500, tc: 'blitz' });
ok('an unlikely score without corroboration never forfeits', !sparse.auto, [sparse.level, sparse.corroboration]);
ok('only the investigate flag is set at Suspicious', !(M.assess(engine(24), { rating: 1500, tc: 'blitz' }).level === 3) || M.assess(engine(24), { rating: 1500, tc: 'blitz' }).investigate, null);

console.log('history');
const flat = (n, m = 0) => Array.from({ length: n }, (_, i) => ({ Z: m + Math.sin(i * 1.7) * 0.8 }));
ok('too little history is not judged', !M.historyShift(flat(10)).enough, null);
ok('a steady player is not flagged', !M.historyShift(flat(30)).significant, M.historyShift(flat(30)));
ok('one good game is not a trend', !M.historyShift([...flat(20), { Z: 4 }]).significant, null);
ok('a sustained jump is significant', M.historyShift([...flat(15), ...flat(5, 4)]).significant, M.historyShift([...flat(15), ...flat(5, 4)]));
ok('a mild improvement is not', !M.historyShift([...flat(15), ...flat(5, 0.7)]).significant, null);

console.log('held-out benchmark (docs/fairplay-benchmark.json, produced by scripts/fair-calibrate.js)');
const bf = path.join(__dirname, '..', 'docs', 'fairplay-benchmark.json');
if (fs.existsSync(bf)) {
  const B = JSON.parse(fs.readFileSync(bf, 'utf8')), key = (s) => Object.keys(B.overall).find((k) => k.startsWith(s));
  const auto = B.overall[key('new: High')], sus = B.overall[key('new: Susp')];
  ok('no genuine game in the held-out set reached the automatic-forfeit level', auto.fp === 0, auto);
  ok('the held-out set is large enough to mean something', B.dataset.test.human >= 150 && B.dataset.test.cheat >= 30, B.dataset.test);
  ok('the investigation level finds a meaningful share of engine-assisted games', sus.recall >= 0.5, sus.recall);
  ok('and still flags few genuine ones (under 3%)', sus.fpr < 0.03, sus.fpr);
  ok('history: steady players are rarely flagged and a switch is found', B.history.honestFalseFlagRate <= 0.05 && B.history.switchDetectionRate >= 0.5, B.history);
} else ok('the benchmark has been produced', false, 'run node scripts/fair-calibrate.js');
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
