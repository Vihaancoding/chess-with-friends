// Builds scripts/fixtures/damage-games.json: a few real games (computer vs computer at different levels, plus two
// famous ones) with the engine's evaluation of every position, so the scoring tests run on real material and real
// evaluations without waiting for the engine each time. Run: node scripts/gen-damage-fixtures.js   (about a minute)
const fs = require('fs');
const C = require('../public/chess.js');
const Bot = require('../public/bot.js');
const A = require('../lib/damageeng.js');
const D = require('../lib/damage.js');

const uciOf = (m) => C.sqName(m.from) + C.sqName(m.to) + (m.promo ? m.promo.toLowerCase() : '');
const toHist = (ucis) => { let st = C.initial(); return ucis.map((u) => { const m = C.findUci(st, u); st = C.apply(st, m); return { from: m.from, to: m.to, ...(m.promo ? { promo: m.promo } : {}) }; }); };
function play(white, black, maxPlies = 140) {
  let st = C.initial(); const seen = {}, ucis = [];
  for (let i = 0; i < maxPlies; i++) {
    const s = C.status(st); if (s.over) return { ucis, result: s.result, reason: s.reason };
    const r = Bot.chooseMove(st, i % 2 ? black : white, seen, 0.03);
    const m = C.legalMoves(st).find((x) => x.from === r.move.from && x.to === r.move.to && (x.promo || null) === (r.move.promo || null));
    ucis.push(uciOf(m)); st = C.apply(st, m); seen[C.key(st)] = (seen[C.key(st)] || 0) + 1;
    // a human would resign when hopelessly behind
    const board = st.board, val = { P: 1, N: 3, B: 3, R: 5, Q: 9 }; let w = 0, b = 0;
    for (const p of board) if (p && p[1] !== 'K') (p[0] === 'w' ? (w += val[p[1]]) : (b += val[p[1]]));
    if (i > 24 && Math.abs(w - b) >= 14 && i % 2 === 1) return { ucis, result: w > b ? 'w' : 'b', reason: 'resignation' };
  }
  return { ucis, result: 'draw', reason: 'move limit' };
}
const out = [];
const hand = [
  ['Legal trap', 'e2e4 e7e5 g1f3 d7d6 f1c4 c8g4 b1c3 g7g6 f3e5 g4d1 c4f7 e8e7 c3d5', 'w', 'checkmate', 1450, 1380],
  ['Opera game', 'e2e4 e7e5 g1f3 d7d6 d2d4 c8g4 d4e5 g4f3 d1f3 d6e5 f1c4 g8f6 f3b3 d8e7 b1c3 c7c6 c1g5 b7b5 c3b5 c6b5 c4b5 b8d7 e1c1 a8d8 d1d7 d8d7 h1d1 e7e6 b5d7 f6d7 b3b8 d7b8 d1d8', 'w', 'checkmate', 1500, 1500],
];
for (const [name, line, result, reason, rw, rb] of hand) out.push({ name, ucis: line.split(' '), result, reason, rw, rb, cat: 'blitz' });
let tries = 0;
const wants = [[4, 1], [1, 4], [4, 2], [3, 1], [4, 1], [2, 4], [4, 1], [3, 2], [1, 3]];
for (const [lw, lb] of wants) {
  let g; do { g = play(lw, lb); tries++; } while (g.result === 'draw' && tries < 60);
  if (g.result === 'draw') continue;
  out.push({ name: `bot ${lw} vs ${lb}`, ucis: g.ucis, result: g.result, reason: g.reason, rw: 1000 + lw * 150, rb: 1000 + lb * 150, cat: 'blitz' });
}
for (const g of out) {
  const hist = toHist(g.ucis), rep = D.replay(hist);
  g.ev = []; g.best = [];
  const slice = A.analyseSlice(rep.states, null, 1e9);
  g.ev = slice.ev; g.best = slice.best;
  console.log(g.name, g.ucis.length, 'plies', g.result, g.reason);
}
fs.writeFileSync(__dirname + '/fixtures/damage-games.json', JSON.stringify(out));
console.log('wrote', out.length, 'games');
