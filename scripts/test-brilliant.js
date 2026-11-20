// Brilliant moves (Dmg.moveStats): only real, sound sacrifices that Stockfish confirms, never ordinary trades, recaptures, pieces
// that were lost anyway or moves in decided games. Uses the real engine for the famous games. Run: node scripts/test-brilliant.js (~30 s)
const Chess = require('../public/chess.js'), Dmg = require('../lib/damage'), MS = require('../lib/movestats');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const clean = (s) => s.replace(/[+#!?]/g, '');
// a game from SAN or UCI moves
function hist(moves) {
  let st = Chess.initial(); const h = [];
  for (const u of moves.trim().split(/\s+/)) {
    const legal = Chess.legalMoves(st);
    const m = /^[a-h][1-8][a-h][1-8]/.test(u) ? Chess.findUci(st, u) : legal.find((x) => clean(Chess.notate(st, x)) === clean(u)) ||
      legal.find((x) => { const d = /^([NBRQ])([a-h1-8])(x?[a-h][1-8])$/.exec(clean(u)); return d && clean(Chess.notate(st, x)) === d[1] + d[3] && ('abcdefgh'[x.from & 7] === d[2] || String(8 - (x.from >> 3)) === d[2]); });
    if (!m) throw new Error('bad move ' + u);
    h.push({ from: m.from, to: m.to, promo: m.promo }); st = Chess.apply(st, m);
  }
  return h;
}
const brill = (h, ev) => { const rep = Dmg.replay(h); return Dmg.moveStats(rep, ev).list.filter((x) => x.kind === 'brilliant').map((x) => rep.plies[x.i - 1].san); };
const flat = (h) => new Array(h.length + 1).fill(0);   // as if Stockfish called every position equal: only the material test decides

// Real games played with real-ish moves, with the scores Stockfish gave them (depth 12, mistakes re-checked at 16). The old rule
// called these moves brilliant; none is a sacrifice.
const FX = [
  {"why":"18...Bxd6","mv":"e2e3 e7e5 d2d4 e5d4 d1d4 g8f6 d4a4 f8e7 g1f3 b7b6 b1c3 e8g8 f1e2 a7a6 e1g1 f8e8 e3e4 b6b5 a1b1 c7c6 a4a3 e7a3 c3a4 a8a7 c1e3 f6d5 f3d2 a3e7 e4d5 c6c5 a4c5 d8c7 c5e4 d7d6 e4d6 e7d6 e3a7 c8d7 e2g4 f7f5 g4f5 d6c5 f5e6 g8f8 e6g4 d7g4 a7c5 c7c5 d2b3 c5e7 b3d4 e7f6 a2a3 e8d8 a3a4 h7h5 c2c3 b5b4 b1e1 f6d6 h2h4 g7g6 f2f3 g4f5 f1f2 d6d5 d4f5 g6f5 g1f1 d5b3 c3b4 b8d7 f2d2 d8e8 e1e4 e8e4 d2d7 e4e8 d7d4 b3b2 g2g3 b2a1 d4d1 a1a3 f1g1 a3e3 g1g2 e8b8 d1d6 e3e2 g2h1 e2f1 h1h2 b8b4 d6f6 f8g8 f6e6 g8f8 e6b6 b4b6 a4a5 b6b2","ev":[20,13,13,10,13,-27,-26,-27,-26,-21,45,-13,-28,-67,-31,-26,-14,19,269,-744,-31,-747,-805,-929,-841,-826,-485,-1084,-504,-707,-631,-657,-500,-582,-566,-679,-677,-684,-680,-713,-718,-731,-450,-594,-351,-653,-580,-576,-570,-606,-571,-573,-589,-637,-579,-704,-543,-617,-549,-572,-487,-592,-443,-452,-443,-477,-494,-511,-479,-570,-527,-578,-545,-524,-573,-838,-651,-99995,-629,-1070,-1236,-99996,-99997,-99997,-794,-1459,-99995,-99995,-623,-933,-1241,-1184,-1175,-1175,-99995,-99995,-99995,-99998,-99995,-99996,-99997,-99999,-100000]},
  {"why":"34.Rd1","mv":"b1c3 d7d5 e2e3 e7e5 g1f3 e5e4 f3e5 c7c6 e1e2 d8e7 d2d4 f7f6 e5c6 b7c6 c1d2 g7g6 a2a4 a7a5 e2e1 b8a6 f2f3 f6f5 c3a2 e4f3 d1f3 a6b8 e3e4 e7e4 e1d1 e8f7 f3g3 e4e8 f1d3 e8d7 d2f4 c6c5 f4b8 c5c4 d3e2 g8f6 a2c3 d7b7 b8c7 h7h5 c7e5 f8b4 e5f6 f7f6 g3e5 f6f7 e5h8 b4f8 e2h5 b7a7 h8h7 f7e6 h1e1 e6d6 e1e6 c8e6 h7g6 a7d4 d1e2 d4g7 e2f1 d6d7 a1d1 g7g6 c3d5 g6h5 d5b6 d7e7 d1d5 a8d8 b2b3 e6d5 b6d5 d8d5 b3c4 d5d1 f1f2 f5f4 h2h4 h5c5 f2f3 c5e3 f3g4 e3e2 g4f4 d1f1 f4g3 e2f2 g3h3 f2f5 g2g4 f5f3 h3h2 f8h6 h4h5 f1h1","ev":[20,5,6,-30,-19,-64,-67,-112,-78,-514,-525,-490,-529,-520,-499,-539,-471,-608,-573,-536,-449,-616,-554,-621,-598,-683,-497,-590,-575,-598,-542,-570,-462,-542,-427,-414,-27,-23,-53,-69,-61,-61,17,-66,-42,-41,429,371,491,439,450,449,470,441,633,699,1859,1803,1806,989,1049,31,60,32,28,-7,44,51,71,-451,-437,-1204,-822,-1255,-1371,-1844,-1906,-1864,-1790,-99997,-99998,-99998,-1565,-1708,-1582,-1579,-1569,-1973,-1589,-99997,-99996,-99996,-99997,-99997,-99997,-99998,-99999,-99999,-99999,-99999,-100000]},
  {"why":"30...Qxe5 and 42.Rxe2","mv":"e2e4 c7c5 b1c3 a7a6 g2g3 e7e6 f1g2 b8c6 g1f3 d8b6 e1g1 d7d6 b2b3 g8f6 a2a3 f8e7 d2d3 e8g8 c1b2 a8b8 d1d2 f8d8 f1e1 b6c7 c3d1 b7b5 d1e3 h7h6 f3h4 c8b7 f2f4 c6d4 e1f1 d6d5 e4e5 f6d7 c2c3 d4b3 d2e2 d5d4 c3d4 b7g2 e2g2 c5d4 e3g4 h6h5 g4h6 g7h6 g2f3 e7h4 f3h5 d7c5 f4f5 h4g5 b2c1 b3c1 h2h4 c1e2 g1g2 c7e5 h4g5 e6f5 g5h6 e5g3 g2h1 b8b6 a1b1 b6g6 h6h7 g8f8 h7h8q f8e7 h5h4 g6g5 h8f6 e7e8 f6g5 g3g5 h4g5 d8d6 f1e1 d6e6 e1e2 e6e2 g5f5 c5d3 f5c8 e8e7 c8c7 e7e6 c7c6 e6e7 c6b7 e7f8 a3a4 f8g8 b1g1 g8f8 b7e4 d3f2 h1h2 f2e4 g1g2 e2g2 h2g2 b5a4 g2h3 e4c3 h3h2 c3d1 h2g2 a6a5 g2g3 d4d3 g3f4 f8e7 f4g5 e7e6 g5g4 d3d2","ev":[20,34,39,31,40,32,40,38,42,42,46,41,28,22,31,6,1,-5,-3,-3,4,-11,-10,-9,-11,-6,-6,-4,-4,-30,-16,-31,18,14,16,0,11,-354,-419,-363,-307,-331,-365,-385,-385,-427,-428,-380,-431,-418,-421,-420,-321,-535,-427,-502,-576,-779,-607,-598,-707,-533,-569,-678,-693,-701,-723,-1022,-1157,-1931,369,236,363,-1143,-667,-1510,597,512,466,515,667,561,586,618,583,628,668,476,546,504,484,506,544,504,561,457,665,483,584,-744,-658,-757,-695,-725,-721,-716,-757,-808,-828,-964,-791,-898,-813,-898,-940,-959,-817,-968,-1002,-997,-970]},
  {"why":"16.Nxe4","mv":"e2e4 e7e6 d2d4 c7c5 e4e5 c5d4 b2b4 f8b4 b1d2 b4d2 d1d2 d7d6 g1f3 d6e5 d2b4 b8c6 f1b5 f7f6 b5c6 b7c6 c2c4 c8d7 a1b1 d8c7 c1a3 e5e4 f3d2 c6c5 b4c5 e8c8 d2e4 c7c5 b1b4 g7g6 e4c5 g8e7 c5b7 d4d3 e1f1 e7f5 b7d8 f5d4 f1e1 d4b5 d8b7 c8b7 e1d2 b7a8 b4b5 a7a6 b5b6 d7c8 h1b1 c8b7 d2c3 h8g8 c3d2 g8b8 b6c6 f6f5 c6c5 b7e4 b1b8 a8b8 a3b4 a6a5 g2g4 a5b4 g4f5 e4f5 c5b5 b8a7 b5b4 g6g5 d2c1 e6e5 b4a4 a7b8 a4a8 b8a8 c1b2 d3d2 f2f4 e5f4 b2c3 a8a7 c3d2 h7h6 h2h4 a7b8 c4c5 g5h4 a2a4 f5h7 c5c6 h7e4 a4a5 e4c6 d2d3 h6h5 d3c4 b8b7 c4d4 c6d7 d4d5 d7c8 d5d6 h4h3 d6e5 h3h2 e5f6 b7c6 f6g7 c6b5 g7h6 b5c6 h6h5 f4f3 h5h4 h2h1q","ev":[20,34,49,52,74,-42,-35,-310,-299,-281,-105,-110,-77,-125,-118,-406,-371,-374,-342,-401,-406,-429,-291,-449,-310,-426,99999,-140,-202,-202,105,90,87,-793,56,99,109,57,360,68,92,98,378,158,580,255,487,510,568,465,693,688,939,939,939,592,976,767,1012,4,758,562,606,604,598,577,620,470,460,456,473,467,557,564,580,556,591,418,606,-552,-501,-992,-1001,-1195,-1194,-1233,-571,-583,-531,-687,-517,-674,-717,-710,-661,-713,-672,-753,-753,-770,-776,-776,-786,-798,-807,-891,-796,-840,-831,-862,-891,-949,-867,-981,-964,-972,-950,-1120,-1255,-1492,-1629]},
  {"why":"12...Bxd6","mv":"e2e4 e7e5 d2d4 g8f6 b1c3 e5d4 d1d4 b8c6 d4d3 f8b4 c1d2 e8g8 e1c1 a7a5 g1e2 b4c5 d3d5 f6d5 e4d5 c6b4 d5d6 a8a7 c3e4 c5d6 e4d6 b4d3 c1b1 d3f2 d2g5 d8g5 h2h4 g5e7 d6b5 d7d6 b5a7 c8g4 a7c6 e7e3 d1e1 f8e8 h1g1 a5a4 c6a7 e3a7 g2g3 h7h5 e2f4 e8e1","ev":[20,34,34,4,92,-4,1,1,-11,-19,16,10,10,17,38,38,59,-586,-594,-597,-538,-644,-458,-481,-446,-554,-481,-480,-513,-698,-843,-881,-823,-897,-868,-923,-951,-1172,-750,-1040,-863,-946,-773,-1070,-1028,-959,-764,-99999,-100000]},
  {"why":"18.h3","mv":"e2e4 e7e6 b1c3 f8b4 d1g4 b4f8 g1f3 g8f6 g4f4 f6g8 c3e2 d7d5 e4d5 f8d6 f4a4 d8d7 a4d7 c8d7 d5e6 d7e6 e2d4 e6d7 f1e2 a7a6 e1d1 g8f6 c2c3 h7h5 h1e1 e8f8 d2d3 f6g4 c1e3 g7g6 h2h3 g4e3 d1d2 e3g2 e1b1 g2f4 b1h1 f7f6 f3h4 d7e8 e2f3 c7c5 h4g6 e8g6 d4b3 a8a7 h1g1 g6f7 b3c5 d6e5 g1g4 h5g4 h3g4 b7b6 c5a4 f4h3 a4b6 h3f2 a1f1 h8h2 b6c4 e5f4 c4e3 f2g4 d2e1 g4e3 d3d4 f4g3 f1f2 a7e7 b2b3 h2f2 b3b4 f2a2","ev":[20,34,49,46,68,57,78,63,93,81,187,74,73,35,94,53,161,161,152,153,177,189,241,170,169,83,63,59,90,82,121,96,126,74,95,84,61,-682,-697,-788,-746,-787,-644,-720,-639,-654,-534,-716,-667,-767,-656,-718,-685,-710,-590,-841,-760,-793,-807,-851,-688,-752,-762,-819,-834,-1029,-1029,-1337,-1239,-2034,-1498,-2590,-2781,-2698,-2528,-3077,-2970,-99999,-100000]},
];

(async () => {
  console.log('the material test: a sacrifice is material really given away, by static exchange');
  const fork = hist('e4 e5 Nf3 Nc6 Bc4 Nf6 Nc3 Nxe4 Nxe4 d5 Bd3 dxe4 Bxe4');
  ok('the fork trick (4...Nxe4 5.Nxe4 d5) wins the piece straight back: not a sacrifice', !brill(fork, flat(fork)).includes('Nxe4'), brill(fork, flat(fork)));
  const trade = hist('e4 e6 d4 d5 exd5 exd5 Nf3 Nf6 Bd3 Bd6 O-O O-O Bg5 Bg4 Nbd2 Nbd7 c3 c6 Qc2 Qc7 Rfe1 Rfe8 Rxe8 Rxe8 Re1 Rxe1 Nxe1 h6 Bxf6 Nxf6');
  ok('a game of plain trades and recaptures has no sacrifice at all', brill(trade, flat(trade)).length === 0, brill(trade, flat(trade)));
  // the Noah's Ark trap: after 11...c4 the bishop on b3 is lost whatever White does, so 12.O-O cxb3 13.axb3 gives nothing away
  const lost = hist('e4 e5 Nf3 Nc6 Bb5 a6 Ba4 d6 d4 b5 Bb3 Nxd4 Nxd4 exd4 Qxd4 c5 Qd5 Be6 Qc6+ Bd7 Qd5 c4 O-O cxb3 axb3');
  ok('a piece that was lost anyway (trapped bishop) is not sacrificed by the move played meanwhile', !brill(lost, flat(lost)).includes('O-O'), brill(lost, flat(lost)));
  const gambit = hist('e4 e5 f4 exf4 Nf3 d6 d4 g5');
  ok('a pawn gambit is not a piece sacrifice', brill(gambit, flat(gambit)).length === 0, brill(gambit, flat(gambit)));

  console.log('real games the old rule got wrong (stored Stockfish scores)');
  for (const f of FX) { const h = hist(f.mv), b = brill(h, f.ev); ok('no brilliant move in the game where the old rule saw ' + f.why, b.length === 0, b); }

  console.log('the decided game and the engine\'s say');
  const op = hist('e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5 Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7 Nxd7 Qb8 Nxb8 Rd8');
  const opEv = (await MS.evalGame(op, null, 0, {})).ev;
  const ob = brill(op, opEv);
  ok('the Opera Game: the queen sacrifice that mates (16.Qb8+) and the knight sacrifice (10.Nxb5) are brilliant', ob.includes('Qb8+') && ob.includes('Nxb5'), ob);
  ok('and the rook "sacrifice" 13.Rxd7, won straight back by 15.Bxd7+, and the plain trade 5.dxe5 are not', !ob.includes('Rxd7') && !ob.includes('dxe5'), ob);
  ok('Black, who was mated, has no brilliant move', Dmg.moveStats(Dmg.replay(op), opEv).list.every((x) => x.kind !== 'brilliant' || x.c === 'w'), ob);
  const won = opEv.slice(); for (let k = 30; k <= 32; k++) won[k] = 2500;    // what if Qb8+ were only the best of several ways to win, not a forced mate
  ok('in a position already won (+25) a sacrifice that does not force mate is not brilliant', !brill(op, won).includes('Qb8+'), brill(op, won));
  const noisy = opEv.slice(); noisy[20] = -400;                                // 10...cxb5 and the engine thinks White is lost after all
  ok('if the score after the opponent accepts says the sacrifice fails, it is not brilliant (one shallow score is not trusted)', !brill(op, noisy).includes('Nxb5'), brill(op, noisy));
  const bad = opEv.slice(); bad[19] = bad[18] - 400;                           // Stockfish says 10.Nxb5 throws away 4 pawns
  ok('a sacrifice Stockfish does not approve is not brilliant', !brill(op, bad).includes('Nxb5'), brill(op, bad));

  const legal = hist('e4 e5 Nf3 d6 Bc4 Bg4 Nc3 g6 Nxe5 Bxd1 Bxf7+ Ke7 Nd5');
  ok('Legal\'s mate: 5.Nxe5, giving the queen, is brilliant', brill(legal, (await MS.evalGame(legal, null, 0, {})).ev).includes('Nxe5'), null);
  const forkEv = (await MS.evalGame(fork, null, 0, {})).ev;
  ok('with Stockfish\'s real scores the fork trick is still not brilliant', !brill(fork, forkEv).includes('Nxe4'), brill(fork, forkEv));

  console.log('nothing else changes');
  const rep = Dmg.replay(op), ms = Dmg.moveStats(rep, opEv);
  ok('every move lands in exactly one bucket', ['w', 'b'].every((c) => ['brilliant', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder'].reduce((a, k) => a + ms[c][k], 0) === ms[c].n), ms);
  const t0 = Date.now(); for (const f of FX) brill(hist(f.mv), f.ev.map(() => 0));
  ok('fast enough to run on every game (even with every move looking sound)', Date.now() - t0 < 3000, Date.now() - t0);
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
