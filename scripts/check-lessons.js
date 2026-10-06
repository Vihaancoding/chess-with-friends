// Validates public/lessons.js: legal moves, correct side to move, real checkmates, and puzzle answers the engine agrees with.
// Run: node scripts/check-lessons.js
const C = require('../public/chess.js');
const B = require('../public/bot.js');
const COURSES = require('../public/lessons.js');
let problems = 0, checked = 0;
const bad = (where, msg) => { problems++; console.log('  ✗', where, '-', msg); };
const san = (st, m) => C.notate(st, m);

for (const [cid, course] of Object.entries(COURSES)) {
  console.log(`\n${course.title}`);
  for (const L of course.lessons) {
    const where0 = `${cid}/${L.id}`;
    L.parts.forEach((P, pi) => {
      const where = `${where0} part ${pi + 1}`;
      let st = P.fen ? C.fromFEN(P.fen) : C.initial();
      for (const u of P.pre || []) { const m = C.findUci(st, u); if (!m) return bad(where, `pre-move ${u} illegal`); st = C.apply(st, m); }
      const line = [];
      P.steps.forEach((S, si) => {
        const w = `${where} step ${si + 1}`;
        if (st.turn !== L.side) bad(w, `it is ${st.turn} to move, but the learner plays ${L.side}`);
        const alts = (S.move || []).map((u) => [u, C.findUci(st, u)]);
        for (const [u, m] of alts) if (!m) bad(w, `move ${u} is illegal`);
        if (S.accept === 'mate') {
          const mates = C.legalMoves(st).filter((m) => C.status(C.apply(st, m)).reason === 'checkmate');
          if (!mates.length) bad(w, 'no checkmate exists here');
          for (const [u, m] of alts) if (m && C.status(C.apply(st, m)).reason !== 'checkmate') bad(w, `${u} is not checkmate`);
        }
        // puzzle positions (custom FEN): the engine should agree with the first accepted move
        if (P.fen && P.engine !== false && alts[0] && alts[0][1] && S.accept !== 'mate') {
          const r = B.chooseMove(st, 4, null, 1);
          const em = C.legalMoves(st).find((m) => m.from === r.move.from && m.to === r.move.to);
          const want = alts.map(([, m]) => m && m.from + '-' + m.to);
          if (!want.includes(em.from + '-' + em.to)) bad(w, `engine prefers ${san(st, em)} (score ${r.score}) over ${alts.map(([, m]) => m && san(st, m)).join('/')}`);
        }
        // every alternative must leave the scripted reply legal
        if (S.reply) for (const [u, m] of alts) if (m && !C.findUci(C.apply(st, m), S.reply)) bad(w, `reply ${S.reply} illegal after ${u}`);
        const m0 = alts[0] && alts[0][1];
        if (!m0) return;
        line.push(san(st, m0)); st = C.apply(st, m0); checked++;
        if (S.reply) { const r = C.findUci(st, S.reply); if (!r) return; line.push(san(st, r)); st = C.apply(st, r); }
      });
      if (P.endsWith === 'promotion' && !st.board.some((p) => p === L.side + 'Q')) bad(where, 'line does not end with a new queen');
      console.log(`  ✓ ${L.title}${L.parts.length > 1 ? ` (${pi + 1})` : ''}: ${line.join(' ')}`);
    });
  }
}
// the stalemate warning in the queen lesson must really be stalemate
{ const st = C.fromFEN('k7/8/1K6/8/8/8/8/2Q5 w - - 0 1'); const r = C.status(C.apply(st, C.findUci(st, 'c1c7'))); if (r.reason !== 'stalemate') bad('eg-queen part 3', 'Qc7 is not stalemate'); }
console.log(`\n${checked} learner moves checked, ${problems} problem(s).`);
process.exit(problems ? 1 : 0);
