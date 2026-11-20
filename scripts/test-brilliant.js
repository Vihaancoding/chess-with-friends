// Brilliant moves in the stats (Dmg.moveStats) follow the game review's rule, so the counter and the badges agree:
// a piece (not a pawn or king) moved where a cheaper piece can take it, net 2+ points down, Stockfish near-best, mover at 50%+. Run: node scripts/test-brilliant.js
const Chess = require('../public/chess.js'), Dmg = require('../lib/damage');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
function hist(moves) {
  let st = Chess.initial(); const h = [];
  for (const u of moves.trim().split(/\s+/)) {
    const m = Chess.legalMoves(st).find((x) => Chess.notate(st, x).replace(/[+#]/g, '') === u.replace(/[+#]/g, ''));
    if (!m) throw new Error('bad move ' + u);
    h.push({ from: m.from, to: m.to, promo: m.promo }); st = Chess.apply(st, m);
  }
  return h;
}
const brill = (h, ev) => { const rep = Dmg.replay(h); return Dmg.moveStats(rep, ev).list.filter((x) => x.kind === 'brilliant').map((x) => rep.plies[x.i - 1].san); };
const flat = (h) => new Array(h.length + 1).fill(0);
const g1 = hist('e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Nxd5 Nxf7');
ok('the Fried Liver knight sacrifice is brilliant (a knight onto a square only the king guards, net 2 points)', brill(g1, flat(g1)).join() === 'Nxf7', brill(g1, flat(g1)));
const ev = flat(g1); ev[g1.length] = -300;
ok('not when Stockfish says it leaves the mover clearly worse', brill(g1, ev).length === 0, brill(g1, ev));
const ev2 = flat(g1); ev2[g1.length - 1] = 600;
ok('not when it is a big loss compared with the best move', brill(g1, ev2).length === 0, brill(g1, ev2));
const g2 = hist('e4 d5 exd5 Qxd5 Nc3 Qa5 d4 c6 Nf3 Bg4 h3 Bxf3 Qxf3 e6');
ok('pawn captures, equal trades and quiet moves are never brilliant', brill(g2, flat(g2)).length === 0, brill(g2, flat(g2)));
const g3 = hist('e4 e5 Nf3 Nc6 Nc3 Nf6 Nd5 Nxd5 exd5');
ok('a knight trade is not a sacrifice', brill(g3, flat(g3)).length === 0, brill(g3, flat(g3)));
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
