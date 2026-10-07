// Tests "Ask the coach" (public/coachask.js): questions find the right opening or topic, and every opening in the book
// makes a trainer lesson that is legal and has the learner moving on their own turns.
// Run: node scripts/test-coach-ask.js   (no dependencies)
global.self = global;
require('../public/openings.js');
const C = require('../public/chess.js');
const A = require('../public/coachask.js');
const courses = require('../public/lessons.js');
let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) passed++; else { failed++; console.log('  ✗', name, got === undefined ? '' : '\n      got: ' + JSON.stringify(got)); } };

const book = A.loadBook(self.OPENINGS_TSV);
const ids = new Set(Object.values(courses).flatMap((c) => c.lessons.map((l) => l.id)));

// questions -> what the first opening trainer (or lesson) should be
const cases = [
  ['Teach me the Sicilian', { opening: 'Sicilian Defense', side: 'b', lesson: 'op-sicilian' }],
  ['help me learn the caro kann', { opening: 'Caro-Kann Defense', side: 'b' }],
  ['How do I play the French Defence?', { opening: 'French Defense', side: 'b' }],
  ['the London System as White', { opening: 'London System', side: 'w' }],
  ['how to beat the london', { opening: 'London System', side: 'b' }],
  ['Najdorf', { opening: 'Sicilian Defense: Najdorf Variation', side: 'b' }],
  ["queen's gambit", { opening: "Queen's Gambit", side: 'w', lesson: 'op-qgd' }],
  ['KID', { opening: "King's Indian Defense", side: 'b' }],
  ['Grunfeld', { opening: 'Grünfeld Defense', side: 'b' }],
  ['vienna gambit', { opening: 'Vienna Game: Vienna Gambit', side: 'w' }],
  ['Ruy Lopez as black', { opening: 'Ruy Lopez', side: 'b', lesson: 'op-ruy' }],
  ['What is a fork?', { lesson: 'mg-fork', noTrain: true }],
  ['what is a pin', { lesson: 'mg-pin', noTrain: true }],
  ['How do I checkmate with a rook?', { lesson: 'eg-rook', noTrain: true }],
  ['how do i improve', { lesson: 'op-principles', noTrain: true }],
  ['I want to learn an opening', { lesson: 'op-principles' }],
  ['which opening should I learn?', { lesson: 'op-principles' }],
];
for (const [q, want] of cases) {
  const a = A.answer(q, { courses });
  const tr = a.actions.find((x) => x.kind === 'train'), ls = a.actions.find((x) => x.kind === 'lesson');
  if (want.opening) ok(`"${q}" -> ${want.opening}`, tr && tr.name === want.opening && tr.side === want.side, tr);
  if (want.lesson) ok(`"${q}" -> lesson ${want.lesson}`, ls && ls.id === want.lesson, ls);
  if (want.noTrain) ok(`"${q}" is not an opening`, !tr, tr);
  for (const x of a.actions) {
    if (x.kind === 'train') ok(`"${q}" trains a book line (${x.name})`, book.byName.has(x.name));
    if (x.kind === 'lesson') ok(`"${q}" links a real lesson (${x.id})`, ids.has(x.id));
  }
}
ok('nonsense gets suggestions, not a guess', (() => { const a = A.answer('asdf qwerty', { courses }); return !a.actions.length && a.ask.length; })());
ok('questions are never echoed as HTML', !A.answer('<img src=x onerror=alert(1)> sicilian', { courses }).html.includes('<img'));

// every opening, both sides: legal moves, learner to move at each step, replies legal
let lines = 0;
for (const o of book.list) for (const side of ['w', 'b']) for (const memory of [false, true]) {
  const L = A.trainer(o.name, side, memory), where = `${o.name} (${side})`;
  if (!L) { ok(where + ' builds', false); continue; }
  let st = C.initial(), good = L.parts[0].steps.length > 0;
  for (const u of L.parts[0].pre) st = C.apply(st, C.findUci(st, u));
  for (const S of L.parts[0].steps) {
    if (st.turn !== L.side) { good = false; break; }
    const m = C.findUci(st, S.move[0]); if (!m) { good = false; break; }
    st = C.apply(st, m);
    if (S.reply) { const r = C.findUci(st, S.reply); if (!r) { good = false; break; } st = C.apply(st, r); }
  }
  if (!good) ok(where + ' is a playable trainer', false, L.parts[0]);
  else lines++;
}
ok(`all ${book.list.length * 4} trainers are playable`, lines === book.list.length * 4, lines);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
