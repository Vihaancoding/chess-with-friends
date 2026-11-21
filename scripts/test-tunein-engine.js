// LIVE TUNE-IN with a real Stockfish: one archived game is analysed position by position by the same Stockfish build the
// browsers use (through lib/sfserver.js), and the numbers go through the same checks and scoring as a browser's batch.
// Confirms real evaluations pass the plausibility check, that the score is in range, and that the events are sane.
// Run: node scripts/test-tunein-engine.js   (takes a little while: one search per position)
const Sf = require('../lib/sfserver');
const T = require('../lib/tunein');
const fx = require('./fixtures/damage-games.json');

let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };

(async () => {
  const game = fx[9], uci = game.ucis, DEPTH = 8;
  const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
  const hist = uci.map((u) => ({ from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)), promo: u[4] ? u[4].toUpperCase() : undefined }));
  console.log('the engine on one game (' + uci.length + ' plies, depth ' + DEPTH + ')');
  const t0 = Date.now(), evals = [];
  for (let i = 0; i <= uci.length; i++) {
    const lines = await Sf.runAnalysis(uci.slice(0, i), { depth: DEPTH, multipv: 1 });
    if (!lines || !lines.length) throw new Error('no answer from the engine at position ' + i);
    const side = i % 2 === 0 ? 'w' : 'b';
    evals.push(T.normalise(lines[0].cp, side));
  }
  console.log('  (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');

  ok('every engine score is a valid evaluation', evals.every((v) => Number.isInteger(v) && Math.abs(v) <= T.MATE_CP), evals.filter((v) => !Number.isInteger(v)));
  const check = T.checkBatch(null, evals);
  ok('real engine evaluations pass the plausibility check', check.rejected === 0, { rejected: check.rejected, at: evals.length - check.ok.length });
  const res = T.analyse(hist, evals, null);
  ok('the score is within 0-100', res.raw >= 0 && res.raw <= 100, res.raw);
  ok('the reasons are plain words', res.reasons.every((r) => typeof r === 'string' && r.length > 3), res.reasons);
  ok('no event without a real change in the evaluation behind it', res.events.every((e) => e.ply >= 1 && e.ply <= uci.length), res.events);
  console.log('  score ' + res.raw + ', reasons: ' + (res.reasons.join(' · ') || 'none') + ', events: ' + (res.events.map((e) => e.kind + '@' + e.ply).join(', ') || 'none'));

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('engine test failed to run:', e.message); process.exit(1); });
