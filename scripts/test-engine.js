// Analysis engine (public/engine.js): move generation against known perft counts and chess.js, tactics, draws,
// and the review mode that only scores the best moves and the played move exactly. Run: node scripts/test-engine.js
const C = require('../public/chess.js');
const E = require('../public/engine.js');
const Bot = require('../public/bot.js');

let pass = 0, fail = 0;
const ok = (cond, name, got) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (got !== undefined ? '\n      got: ' + JSON.stringify(got) : '')); } };
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
const uci = (m) => m && C.sqName(m.from) + C.sqName(m.to) + (m.promo ? m.promo.toLowerCase() : '');
const ref = (st, d) => (d ? C.legalMoves(st).reduce((n, m) => n + ref(C.apply(st, m), d - 1), 0) : 1);

console.log('move generation');
for (const [fen, d, n] of [
  ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 4, 197281],
  ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 3, 97862],
  ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 4, 43238],
  ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', 3, 9467],
  ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', 3, 62379],
]) ok(E.perft(C.fromFEN(fen), d) === n, `perft ${d} = ${n}: ${fen.split(' ')[0]}`, E.perft(C.fromFEN(fen), d));
// positions from a few games between the computer levels match chess.js's own move counts
let st = C.initial(), bad = 0, seen = {};
for (let ply = 0; ply < 120 && !C.status(st).over; ply++) {
  if (E.perft(st, 2) !== ref(st, 2)) bad++;
  const r = Bot.chooseMove(st, 1 + (ply % 2), seen, 0.05);
  st = C.apply(st, C.legalMoves(st).find((m) => m.from === r.move.from && m.to === r.move.to && (m.promo || null) === (r.move.promo || null)));
  seen[C.key(st)] = (seen[C.key(st)] || 0) + 1;
}
ok(bad === 0, 'perft 2 matches chess.js along a played game', bad);

console.log('tactics');
const best = (fen, ms = 300) => E.analyze(C.fromFEN(fen), ms);
let r = best('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1');
ok(uci(r.best) === 'd1d8' && r.score === E.MATE - 1, 'mate in 1 (back rank)', [uci(r.best), r.score]);
r = best('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
ok(uci(r.best) === 'h5f7', 'scholar\'s mate: Qxf7#', uci(r.best));
r = best('6k1/8/8/8/8/8/1R6/R5K1 w - - 0 1', 800);
ok(r.score === E.MATE - 3, 'mate in 2 (rook ladder)', [uci(r.best), r.score]);
r = best('rnb1kbnr/pppp1ppp/8/4p3/5PPq/8/PPPPP2P/RNBQKBNR w KQkq - 1 3');
ok(r.terminal && r.score === -E.MATE, 'checkmated position is terminal', r);
r = best('4k3/8/8/8/8/8/3q4/R3K3 w Q - 0 1');
ok(uci(r.best) === 'e1d2', 'takes a hanging queen with the king', uci(r.best));
const open3 = C.fromFEN('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
ok(E.analyze(open3, 200).scores.length === C.legalMoves(open3).length, 'scores every legal move');
r = best('k7/8/1Q6/8/8/8/8/7K b - - 0 1');
ok(r.terminal && r.score === 0, 'stalemate scores 0', r);

console.log('evaluation');
ok(E.evaluate(C.fromFEN('8/8/4k3/8/8/4K3/4N3/8 w - - 0 1')) === 0, 'king and knight vs king is a draw', E.evaluate(C.fromFEN('8/8/4k3/8/8/4K3/4N3/8 w - - 0 1')));
ok(Math.abs(E.evaluate(C.fromFEN('8/8/4k3/8/8/2N1K3/4N3/8 w - - 0 1'))) < 120, 'two knights alone are scored as nearly drawn');
ok(Math.abs(E.evaluate(C.fromFEN('8/8/4k3/8/8/4K3/4R3/2b5 w - - 0 1'))) < 120, 'rook vs bishop is scored as nearly drawn');
const ini = E.evaluate(C.initial());
ok(ini > 0 && ini < 50, 'starting position: a small edge for the side to move', ini);
ok(E.evaluate(C.fromFEN('4k3/8/8/8/8/8/PPPP4/4K3 w - - 0 1')) > 300, 'extra pawns count');
const passed = E.evaluate(C.fromFEN('4k3/8/1P6/8/8/8/8/4K3 w - - 0 1')), blocked = E.evaluate(C.fromFEN('4k3/1p6/1P6/8/8/8/8/4K3 w - - 0 1'));
ok(passed > blocked + 50, 'a passed pawn on the 6th is worth more than a blocked one', [passed, blocked]);
ok(E.evaluate(C.fromFEN('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1')) === ini, 'symmetric for either side to move');

console.log('draws');
// a queen down, White shuffles the knight: going back to a position from the game's history counts as a draw
const X = C.fromFEN('6k1/8/8/8/8/8/q7/6NK w - - 0 40'), line = ['g1f3', 'a2a3', 'f3g1', 'a3a2'], game = [X];
for (const u of line) game.push(C.apply(game[game.length - 1], C.findUci(game[game.length - 1], u)));
const root = game.pop();
const noHist = E.analyze(root, 200).scores.find((x) => uci(x.m) === 'g1f3');
const withHist = E.analyze(root, 200, 24, { history: game }).scores.find((x) => uci(x.m) === 'g1f3');
ok(noHist.s < -400, 'a queen down is lost', noHist.s);
ok(withHist.s === 0, 'repeating an earlier position of the game is scored as a draw', withHist.s);
const f50 = C.fromFEN('4k3/8/8/8/8/8/4R3/4K3 w - - 0 1'); f50.half = 99;
const fifty = E.analyze(f50, 200);
ok(fifty.scores.every((x) => x.s === 0), '50-move rule: the next quiet move draws', fifty.scores.slice(0, 3).map((x) => x.s));

console.log('review mode');
const mid = C.fromFEN('r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 7');
const focus = C.findUci(mid, 'a2a3');
const fr = E.analyze(mid, 250, 24, { exact: false, focus: [focus] }), xr = E.analyze(mid, 250, 24, {});
ok(fr.scores.find((x) => uci(x.m) === 'a2a3').exact, 'the played move gets an exact score');
ok(fr.scores[0].exact && fr.scores[1].exact, 'the best two moves get exact scores');
ok(fr.scores.every((x) => x.exact || x.s <= fr.scores[1].s), 'the other moves are bounds below the second best');
ok(fr.depth >= xr.depth, `scoring fewer moves exactly searches at least as deep (${fr.depth} vs ${xr.depth})`);
ok(fr.depth >= 5, 'reaches depth 5+ in a quarter second', fr.depth);
const lay = Bot.scoreAll(mid, 100, 3);
ok(lay.layers.length === 3 && Object.keys(lay.layers[2]).length === lay.legal, 'playstyle layers: every move at depths 1-3');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
