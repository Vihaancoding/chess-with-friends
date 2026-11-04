// Stockfish on the server for the fair-play check: an engine-played side looks like an engine, a human game does not.
// Run: node scripts/test-sfserver.js
const C = require('../public/chess.js');
const Sf = require('../lib/sfserver.js');
const T = require('../lib/tribunal.js');
const fx = require('../scripts/fixtures/damage-games.json');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const toHist = (u) => { let st = C.initial(); return u.map((x) => { const m = C.findUci(st, x); st = C.apply(st, m); return { from: m.from, to: m.to, ...(m.promo ? { promo: m.promo } : {}) }; }); };
(async () => {
  const t0 = Date.now();
  const human = await Sf.scanGame(toHist(fx[9].ucis), 'w', null, { from: 16 }), humanB = await Sf.scanGame(toHist(fx[9].ucis), 'b', null, { from: 16 });
  console.log('   human-ish (our own bot games):', human, humanB, Date.now() - t0, 'ms');
  // an engine-played game: Stockfish's first choice every move
  const moves = [];
  let st = C.initial();
  for (let i = 0; i < 56; i++) {
    const u = await Sf.bestMove(moves);
    const m = C.findUci(st, u);
    if (!m) break;
    moves.push(u); st = C.apply(st, m);
    if (C.status(st).over) break;
  }
  const t1 = Date.now();
  const cheat = await Sf.scanGame(toHist(moves), 'w', null, { from: 16 });
  console.log('   engine side:', cheat, Date.now() - t1, 'ms');
  ok('the engine side matches nearly every move with almost no loss', cheat && cheat.n >= 18 && cheat.match >= 94 && cheat.acpl <= 5, cheat);
  ok('an ordinary game (our bots) does not look like an engine', [human, humanB].every((h) => !h || h.match < 94 || h.acpl > 5), [human, humanB]);
  ok('with steady times the engine side is sure enough for a forfeit', T.judge({ ...cheat, cv: 0.2 }).strong);
  ok('on its own it is not (one signal)', !T.judge({ ...cheat, cv: 0.9 }).strong);
  ok('a 25-move window finishes in a few seconds', Date.now() - t1 < 8000, Date.now() - t1);
  ok('the engine does not break the global fetch (the database needs it)', typeof fetch === 'function', typeof fetch);
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
