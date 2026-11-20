// Lichess puzzles: the local index, filters, verification, move checking, request parsing and the training maths.
// Deterministic and free of network and AI calls (lib/puzzleai.js adds the optional AI on top of this).
// Data: data/puzzles.tsv.gz, built from the official Lichess puzzle database (CC0, https://database.lichess.org/#puzzles)
// by scripts/build-puzzles.js. Every row is an original Lichess puzzle: id, FEN, moves, rating and themes are kept as they are.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const Chess = require('../public/chess.js');

const FILE = process.env.PUZZLE_DATA || path.join(__dirname, '..', 'data', 'puzzles.tsv.gz');

// ---------- the Lichess theme taxonomy (ids exactly as in the database; labels and meanings are ours) ----------
// [id, label, group, meaning]
const T = [
  ['fork', 'Fork', 'Tactics', 'One piece attacks two or more enemy pieces at once.'],
  ['pin', 'Pin', 'Tactics', 'A piece cannot move without exposing a more valuable piece behind it.'],
  ['skewer', 'Skewer', 'Tactics', 'A valuable piece is attacked; when it moves, a less valuable piece behind it falls.'],
  ['discoveredAttack', 'Discovered attack', 'Tactics', 'Moving one piece uncovers an attack by another piece behind it.'],
  ['discoveredCheck', 'Discovered check', 'Tactics', 'Moving a piece uncovers a check from another piece.'],
  ['doubleCheck', 'Double check', 'Tactics', 'One move gives check with two pieces at once, so the king has to move.'],
  ['deflection', 'Deflection', 'Tactics', 'Lure a defender away from the job it is doing.'],
  ['attraction', 'Attraction', 'Tactics', 'Force an enemy piece, often the king, onto a square where it can be exploited.'],
  ['sacrifice', 'Sacrifice', 'Tactics', 'Give up material now to win more, or to mate, later.'],
  ['hangingPiece', 'Hanging piece', 'Tactics', 'An enemy piece is undefended or not defended enough.'],
  ['intermezzo', 'Zwischenzug', 'Tactics', 'Instead of the obvious reply, play another forcing move first.'],
  ['interference', 'Interference', 'Tactics', 'Put a piece between two enemy pieces to cut their connection.'],
  ['clearance', 'Clearance', 'Tactics', 'Move a piece out of the way, with tempo, to open a line or square for another piece.'],
  ['trappedPiece', 'Trapped piece', 'Tactics', 'A piece has no safe square to go to and is lost.'],
  ['xRayAttack', 'X-ray attack', 'Tactics', 'A piece attacks or defends a square through an enemy piece.'],
  ['zugzwang', 'Zugzwang', 'Tactics', 'Every move the opponent can make makes their position worse.'],
  ['quietMove', 'Quiet move', 'Tactics', 'A move that is neither a check nor a capture but sets up an unstoppable threat.'],
  ['defensiveMove', 'Defensive move', 'Tactics', 'A precise move or sequence needed to avoid losing material or getting mated.'],
  ['capturingDefender', 'Capture the defender', 'Tactics', 'Remove the piece that defends another piece, then take that piece.'],
  ['exposedKing', 'Exposed king', 'Tactics', 'The enemy king has little cover and can be attacked.'],
  ['attackingF2F7', 'Attacking f2 / f7', 'Tactics', 'An attack on the weak f2 or f7 square next to the king.'],
  ['kingsideAttack', 'Kingside attack', 'Tactics', 'An attack on the king after it castled short.'],
  ['queensideAttack', 'Queenside attack', 'Tactics', 'An attack on the king after it castled long.'],
  ['advancedPawn', 'Advanced pawn', 'Tactics', 'A pawn far up the board is the key to the tactic.'],
  ['promotion', 'Promotion', 'Tactics', 'Promote a pawn to a stronger piece.'],
  ['underPromotion', 'Underpromotion', 'Tactics', 'Promote to a knight, bishop or rook instead of a queen.'],
  ['enPassant', 'En passant', 'Tactics', 'The solution uses the en passant capture.'],
  ['castling', 'Castling', 'Tactics', 'Castling plays a part in the solution.'],
  ['mate', 'Checkmate', 'Checkmate', 'Deliver checkmate.'],
  ['mateIn1', 'Mate in 1', 'Checkmate', 'Checkmate on your next move.'],
  ['mateIn2', 'Mate in 2', 'Checkmate', 'Checkmate in two moves.'],
  ['mateIn3', 'Mate in 3', 'Checkmate', 'Checkmate in three moves.'],
  ['mateIn4', 'Mate in 4', 'Checkmate', 'Checkmate in four moves.'],
  ['mateIn5', 'Mate in 5 or more', 'Checkmate', 'A long forced checkmate.'],
  ['backRankMate', 'Back rank mate', 'Checkmate', 'Checkmate on the back rank, with the king boxed in by its own pawns.'],
  ['smotheredMate', 'Smothered mate', 'Checkmate', 'A knight checkmates a king that is surrounded by its own pieces.'],
  ['anastasiaMate', "Anastasia's mate", 'Checkmate', 'A knight and a rook trap the king against the edge of the board and its own piece.'],
  ['arabianMate', 'Arabian mate', 'Checkmate', 'A knight and a rook trap the king in the corner.'],
  ['bodenMate', "Boden's mate", 'Checkmate', 'Two bishops on crossing diagonals checkmate a king hemmed in by its own pieces.'],
  ['doubleBishopMate', 'Double bishop mate', 'Checkmate', 'Two adjacent bishops checkmate the king.'],
  ['dovetailMate', 'Dovetail mate', 'Checkmate', 'A queen checkmates a king whose escape squares are blocked by its own pieces.'],
  ['hookMate', 'Hook mate', 'Checkmate', 'A rook, a knight and a pawn checkmate the king.'],
  ['killBoxMate', 'Kill box mate', 'Checkmate', 'A rook next to the queen boxes the king in for checkmate.'],
  ['vukovicMate', "Vukovic's mate", 'Checkmate', 'A rook and a knight, supported by a pawn, checkmate the king.'],
  ['pillsburysMate', "Pillsbury's mate", 'Checkmate', "A rook checkmates while a bishop guards the king's escape squares."],
  ['operaMate', 'Opera mate', 'Checkmate', 'A bishop pins a defender and a rook checkmates on the back rank.'],
  ['epauletteMate', 'Epaulette mate', 'Checkmate', 'A queen or rook checkmates a king whose escape squares on both sides are blocked by its own pieces.'],
  ['cornerMate', 'Corner mate', 'Checkmate', 'A rook or queen and a knight checkmate the king in the corner.'],
  ['swallowstailMate', "Swallow's tail mate", 'Checkmate', 'A queen checkmates a king whose own pieces block the two squares behind it.'],
  ['triangleMate', 'Triangle mate', 'Checkmate', 'A queen and a rook on adjacent squares checkmate a king pinned against the edge of the board.'],
  ['morphysMate', "Morphy's mate", 'Checkmate', 'A bishop and a rook checkmate the king on the edge of the board.'],
  ['blindSwineMate', 'Blind swine mate', 'Checkmate', 'Two rooks on the seventh rank checkmate the king.'],
  ['balestraMate', "Balestra mate", 'Checkmate', 'A bishop checkmates while a queen controls the squares around the king.'],
  ['opening', 'Opening', 'Phase', 'The position comes from the first moves of the game.'],
  ['middlegame', 'Middlegame', 'Phase', 'The position comes from the middlegame.'],
  ['endgame', 'Endgame', 'Phase', 'A few pieces are left and the king takes part.'],
  ['pawnEndgame', 'Pawn endgame', 'Phase', 'Only kings and pawns are left.'],
  ['rookEndgame', 'Rook endgame', 'Phase', 'Rooks and pawns are left.'],
  ['bishopEndgame', 'Bishop endgame', 'Phase', 'Bishops and pawns are left.'],
  ['knightEndgame', 'Knight endgame', 'Phase', 'Knights and pawns are left.'],
  ['queenEndgame', 'Queen endgame', 'Phase', 'Queens and pawns are left.'],
  ['queenRookEndgame', 'Queen and rook endgame', 'Phase', 'Queens, rooks and pawns are left.'],
  ['oneMove', 'One-move puzzle', 'Length', 'The solution is a single move.'],
  ['short', 'Short', 'Length', 'A two-move solution.'],
  ['long', 'Long', 'Length', 'A three-move solution.'],
  ['veryLong', 'Very long', 'Length', 'A solution of four or more moves.'],
  ['advantage', 'Advantage', 'Goal', 'Reach a clear advantage.'],
  ['crushing', 'Crushing', 'Goal', 'Reach a winning position.'],
  ['equality', 'Equality', 'Goal', 'Hold the balance from a worse position.'],
];
const THEMES = T.map(([id, label, group, meaning]) => ({ id, label, group, meaning }));
const KNOWN_THEMES = THEMES.map((t) => t.id);
const THEME_BY_ID = new Map(THEMES.map((t) => [t.id, t]));
const labelOf = (id) => (THEME_BY_ID.get(id) || { label: id }).label;
// the themes offered first in the picker (the ones people ask for)
const POPULAR = ['fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck', 'deflection', 'attraction', 'sacrifice', 'backRankMate', 'mate', 'hangingPiece', 'intermezzo', 'endgame', 'rookEndgame', 'pawnEndgame', 'promotion', 'interference', 'clearance'];

const BANDS = {
  beginner: { label: 'Beginner', min: 0, max: 999 },
  intermediate: { label: 'Intermediate', min: 1000, max: 1499 },
  advanced: { label: 'Advanced', min: 1500, max: 1999 },
  expert: { label: 'Expert', min: 2000, max: 2299 },
  master: { label: 'Master', min: 2300, max: 4000 },
};
const bandOf = (r) => (r < 1000 ? 'beginner' : r < 1500 ? 'intermediate' : r < 2000 ? 'advanced' : r < 2300 ? 'expert' : 'master');
const PIECES = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };
const VALUE = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };

// ---------- rows ----------
const uciSq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
// the first solver move's piece, and everything the rest of the code needs from the original fields
function enrich(r) {
  const st0 = Chess.fromFEN(r.fen), setup = Chess.findUci(st0, r.moves.split(' ')[0]);
  const mv = r.moves.split(' ');
  r.mv = mv; r.len = Math.floor(mv.length / 2);
  r.first = '';
  if (setup) { const st1 = Chess.apply(st0, setup), m = Chess.findUci(st1, mv[1] || ''); if (m) r.first = st1.board[m.from][1]; }
  return r;
}
// a row is dropped unless every move is legal, the line has the shape Lichess uses (opponent's move, then pairs), and a mate
// theme agrees with the final position
function verifyRow(r) {
  const mv = String(r.moves || '').split(' ').filter(Boolean);
  if (mv.length < 2 || mv.length % 2) return 'moves';
  let st;
  try { st = Chess.fromFEN(r.fen); } catch { return 'fen'; }
  if (st.board.filter(Boolean).length < 2 || st.board.indexOf('wK') < 0 || st.board.indexOf('bK') < 0) return 'fen';
  for (let i = 0; i < mv.length; i++) {
    const m = Chess.findUci(st, mv[i]);
    if (!m) return 'illegal';
    st = Chess.apply(st, m);
    if (i < mv.length - 1 && Chess.status(st).over) return 'early end';
  }
  const th = r.themes || [], mated = Chess.status(st).reason === 'checkmate';
  if ((th.includes('mate') || th.some((t) => /^mateIn\d$/.test(t))) && !mated) return 'mate';
  const n = th.map((t) => /^mateIn(\d)$/.exec(t)).filter(Boolean)[0];
  if (n && +n[1] < 5 && Math.floor(mv.length / 2) !== +n[1]) return 'mateIn';
  return null;
}
const encodeRow = (r) => {
  const e = enrich({ ...r, themes: r.themes });
  return [r.id, r.fen, r.moves, r.rating, r.pop, r.plays, r.themes.join(' '), String(r.gameUrl || '').replace(/^https?:\/\/lichess\.org\//, ''), r.opening, e.first].join('\t');
};

// ---------- the index ----------
let D = null;
function load(file = FILE) {
  if (D && D.file === file) return D;
  const rows = [], byTheme = new Map();
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const f = line.split('\t');
    const r = { id: f[0], fen: f[1], moves: f[2], rating: +f[3], pop: +f[4], plays: +f[5], themes: f[6] ? f[6].split(' ') : [], game: f[7] || '', opening: f[8] || '', first: f[9] || '' };
    r.mv = r.moves.split(' '); r.len = Math.floor(r.mv.length / 2); r.ts = new Set(r.themes);
    rows.push(r);
  }
  rows.sort((a, b) => a.rating - b.rating || (a.id < b.id ? -1 : 1));
  const byId = new Map();
  rows.forEach((r, i) => { r.i = i; byId.set(r.id, r); for (const t of r.themes) { let a = byTheme.get(t); if (!a) byTheme.set(t, (a = [])); a.push(i); } });
  D = { file, rows, byId, byTheme, cache: new Map(), counts: Object.fromEntries([...byTheme.entries()].map(([t, a]) => [t, a.length])) };
  return D;
}
const available = () => { try { load(); return true; } catch { return false; } };

// ---------- filters ----------
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
// raw (from a request, the AI or a stored session) -> a clean filter, plus what was dropped and why. Nothing unknown gets through.
function normalizeFilter(raw = {}) {
  const f = { min: 0, max: 4000, themes: [], match: raw.match === 'any' ? 'any' : 'all', firstPiece: '', minLen: 0, maxLen: 0 }, dropped = [];
  const band = BANDS[raw.band];
  if (band) { f.min = band.min; f.max = band.max; }
  if (raw.min != null && raw.min !== '' && Number.isFinite(+raw.min)) f.min = clamp(Math.round(+raw.min), 0, 4000);
  if (raw.max != null && raw.max !== '' && Number.isFinite(+raw.max)) f.max = clamp(Math.round(+raw.max), 0, 4000);
  if (f.min > f.max) [f.min, f.max] = [f.max, f.min];
  const seen = new Set();
  for (const t of Array.isArray(raw.themes) ? raw.themes.slice(0, 12) : []) {
    const id = String(t);
    if (!THEME_BY_ID.has(id)) { dropped.push(id.slice(0, 40)); continue; }
    if (!seen.has(id)) { seen.add(id); f.themes.push(id); }
  }
  f.themes = f.themes.slice(0, 6);
  const fp = String(raw.firstPiece || '').toUpperCase();
  if (PIECES[fp]) f.firstPiece = fp;
  if (Number.isInteger(+raw.minLen) && +raw.minLen > 0) f.minLen = clamp(+raw.minLen, 1, 8);
  if (Number.isInteger(+raw.maxLen) && +raw.maxLen > 0) f.maxLen = clamp(+raw.maxLen, 1, 8);
  if (f.maxLen && f.minLen > f.maxLen) f.maxLen = f.minLen;
  return { filter: f, dropped };
}
const keyOf = (f) => [f.min, f.max, f.match, f.firstPiece, f.minLen, f.maxLen, f.themes.slice().sort().join('+')].join('|');

// the rows matching a clean filter, as row indices (the index is sorted by rating)
function find(f) {
  const d = load(), k = keyOf(f), hit = d.cache.get(k);
  if (hit) { d.cache.delete(k); d.cache.set(k, hit); return hit; }
  const lo = lowerBound(d.rows, f.min), hi = lowerBound(d.rows, f.max + 1);
  const ok = (r) => (!f.firstPiece || r.first === f.firstPiece) && (!f.minLen || r.len >= f.minLen) && (!f.maxLen || r.len <= f.maxLen);
  let out;
  if (!f.themes.length) { out = []; for (let i = lo; i < hi; i++) if (ok(d.rows[i])) out.push(i); }
  else if (f.match === 'any') {
    const set = new Set(); for (const t of f.themes) for (const i of d.byTheme.get(t) || []) if (i >= lo && i < hi) set.add(i);
    out = [...set].filter((i) => ok(d.rows[i])).sort((a, b) => a - b);
  } else {
    const lists = f.themes.map((t) => d.byTheme.get(t) || []).sort((a, b) => a.length - b.length);
    out = lists.length && lists[0].length ? lists[0].filter((i) => i >= lo && i < hi && f.themes.every((t) => d.rows[i].ts.has(t)) && ok(d.rows[i])) : [];
  }
  d.cache.set(k, out);
  if (d.cache.size > 80) d.cache.delete(d.cache.keys().next().value);
  return out;
}
function lowerBound(rows, r) { let a = 0, b = rows.length; while (a < b) { const m = (a + b) >> 1; if (rows[m].rating < r) a = m + 1; else b = m; } return a; }
const count = (f) => find(f).length;

// one puzzle for a filter: not one of the recently seen, optionally the one nearest a target rating
function pick(f, { exclude = new Set(), target = null, rand = Math.random, tries = 12 } = {}) {
  const d = load(), pool = find(f);
  if (!pool.length) return null;
  for (let n = 0; n < tries; n++) {
    let i;
    if (target != null) {
      i = nearPick(pool, d.rows, target, exclude, rand);
    } else i = pool[Math.floor(rand() * pool.length)];
    if (i == null) break;
    const r = d.rows[i];
    if (!exclude.has(r.id) && !verifyRow({ ...r, themes: r.themes })) return r;
    if (target != null) exclude = new Set([...exclude, r.id]);
  }
  // everything was seen (or failed the check): any puzzle that verifies
  for (let n = 0; n < pool.length; n++) { const r = d.rows[pool[(Math.floor(rand() * pool.length) + n) % pool.length]]; if (!verifyRow({ ...r, themes: r.themes })) return r; }
  return null;
}
function nearPick(pool, rows, target, exclude, rand) {
  let a = 0, b = pool.length; while (a < b) { const m = (a + b) >> 1; if (rows[pool[m]].rating < target) a = m + 1; else b = m; }
  const cand = [];
  for (let s = 0; s < pool.length && cand.length < 12; s++) for (const j of [a + s, a - 1 - s]) if (j >= 0 && j < pool.length && !exclude.has(rows[pool[j]].id) && cand.length < 12) cand.push(pool[j]);
  return cand.length ? cand[Math.floor(rand() * cand.length)] : null;
}

// ---------- playing a puzzle ----------
// Lichess lists the opponent's move first (moves[0], made from the FEN), then the solver's move, the reply, and so on.
function stateAfter(r, k) {
  let st = Chess.fromFEN(r.fen);
  for (let i = 0; i < k; i++) st = Chess.apply(st, Chess.findUci(st, r.mv[i]));
  return st;
}
const sanOf = (st, uci) => { const m = Chess.findUci(st, uci); return m ? Chess.notate(st, m) : uci; };
// what the player is shown first: the position before the opponent's move and that move (it is animated), and who to play
function present(r) {
  const st = stateAfter(r, 1);
  return { id: r.id, fen: r.fen, setup: r.mv[0], side: st.turn, steps: r.len };
}
// the solver's move at `step` (1, 3, 5...): right if it is the move in the database, or any move that gives checkmate
// (Lichess accepts every mating move). Returns { ok, done, reply, mate } with the opponent's reply when the line goes on.
function checkMove(r, step, uci) {
  if (!(step >= 1 && step < r.mv.length && step % 2 === 1)) return { ok: false, bad: 'step' };
  const st = stateAfter(r, step), m = Chess.findUci(st, String(uci || ''));
  if (!m) return { ok: false, bad: 'illegal' };
  const want = r.mv[step], got = Chess.sqName(m.from) + Chess.sqName(m.to) + (m.promo ? m.promo.toLowerCase() : '');
  const mate = Chess.status(Chess.apply(st, m)).reason === 'checkmate';
  if (got !== want && !mate) return { ok: false };
  const last = step === r.mv.length - 1 || (mate && got !== want);
  return { ok: true, done: last, mate, alt: got !== want, reply: last ? null : r.mv[step + 1], next: last ? null : step + 2 };
}
function hintFor(r, step, level = 1) {
  const m = r.mv[step]; if (!m) return null;
  const st = stateAfter(r, step), pc = (st.board[uciSq(m.slice(0, 2))] || '  ')[1];
  return level >= 2 ? { from: m.slice(0, 2), to: m.slice(2, 4), piece: PIECES[pc] } : { from: m.slice(0, 2), piece: PIECES[pc] };
}

// ---------- facts for the review (all computed from the position, nothing guessed) ----------
function reviewFacts(r) {
  let st = Chess.fromFEN(r.fen);
  const matOf = (s, side) => s.board.reduce((a, p) => a + (p ? (p[0] === side ? VALUE[p[1]] : -VALUE[p[1]]) : 0), 0);
  const start = stateAfter(r, 1), side = start.turn, line = [], caps = [];
  const base = matOf(start, side);
  let low = 0, cur = start, checks = 0, promo = null;
  line.push({ by: 'opponent', uci: r.mv[0], san: sanOf(st, r.mv[0]), setup: true });
  for (let i = 1; i < r.mv.length; i++) {
    const m = Chess.findUci(cur, r.mv[i]), san = Chess.notate(cur, m), cap = cur.board[m.to];
    const nx = Chess.apply(cur, m);
    line.push({ by: i % 2 ? 'you' : 'opponent', uci: r.mv[i], san });
    if (cap) caps.push({ by: i % 2 ? 'you' : 'opponent', piece: PIECES[cap[1]], san });
    if (i % 2 && Chess.inCheck(nx, nx.turn)) checks++;
    if (m.promo) promo = m.promo;
    cur = nx; low = Math.min(low, matOf(cur, side) - base);
  }
  const fin = Chess.status(cur), net = matOf(cur, side) - base;
  // threat: what the opponent could do if it were their move in the puzzle position (only when the side to move is not in check)
  const you = line.filter((x) => x.by === 'you');
  return {
    id: r.id, rating: r.rating, popularity: r.pop, plays: r.plays, side, themes: r.themes.map((t) => ({ id: t, label: labelOf(t), meaning: (THEME_BY_ID.get(t) || {}).meaning || '' })).filter((t) => THEME_BY_ID.has(t.id)),
    opening: r.opening ? r.opening.replace(/_/g, ' ').split(' ').slice(0, 3).join(' ') : '', game: r.game ? 'https://lichess.org/' + r.game : '',
    fen: r.fen, setup: r.mv[0], line, solution: you.map((x) => x.san),
    mate: fin.reason === 'checkmate', stalemate: fin.reason === 'stalemate', mateIn: fin.reason === 'checkmate' ? you.length : null,
    material: { start: base, end: matOf(cur, side), net, low, sacrifice: low <= -2 }, captures: caps, checks, promotion: promo ? PIECES[promo] : null,
    startInCheck: Chess.inCheck(start, start.turn), moveNumber: start.full,
  };
}

// ---------- reading a request in words (the built-in parser; the AI uses the same validator) ----------
const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const RULES = [
  [/\bfork(s|ing|ed)?\b|\bdouble attack/, 'fork'], [/\bpin(s|ned|ning)?\b/, 'pin'], [/\bskewer/, 'skewer'],
  [/discover(ed|y)?\s*(attack|check)?|\bdiscovery\b/, 'discoveredAttack'], [/double[- ]?check/, 'doubleCheck'], [/deflect/, 'deflection'],
  [/attraction|\blure\b|\bdecoy/, 'attraction'], [/sacrific|\bsacs?\b|give up (some )?material|win by giving/, 'sacrifice'],
  [/back[- ]?rank/, 'backRankMate'], [/smother/, 'smotheredMate'], [/anastasia/, 'anastasiaMate'], [/arabian/, 'arabianMate'], [/boden/, 'bodenMate'],
  [/double bishop mate/, 'doubleBishopMate'], [/dovetail/, 'dovetailMate'], [/hook mate/, 'hookMate'], [/kill ?box/, 'killBoxMate'], [/vukovic/, 'vukovicMate'],
  [/hanging|loose piece|undefended|free piece|winning material/, 'hangingPiece'], [/zwischenzug|intermezzo|in[- ]between move/, 'intermezzo'],
  [/interfer/, 'interference'], [/clearance|clear(ing)? (a )?(line|square|the way)/, 'clearance'], [/trapped|trapping|trap a piece/, 'trappedPiece'],
  [/x-?ray/, 'xRayAttack'], [/zugzwang/, 'zugzwang'], [/quiet move|quiet tactic/, 'quietMove'], [/defen[cs]|defend|hold the position|avoid losing/, 'defensiveMove'],
  [/capturing the defender|capture the defender|remove the defender|removing the defender/, 'capturingDefender'], [/exposed king|king safety|weak king/, 'exposedKing'],
  [/f2|f7/, 'attackingF2F7'], [/kingside attack|attack on the kingside|attacking the king/, 'kingsideAttack'], [/queenside attack/, 'queensideAttack'],
  [/under[- ]?promot/, 'underPromotion'], [/promot|queening/, 'promotion'], [/en passant/, 'enPassant'], [/castl/, 'castling'], [/advanced pawn|passed pawn/, 'advancedPawn'],
  [/pawn endgame|pawn ending/, 'pawnEndgame'], [/rook endgame|rook ending/, 'rookEndgame'], [/bishop endgame|bishop ending/, 'bishopEndgame'], [/knight endgame|knight ending/, 'knightEndgame'],
  [/queen and rook endgame/, 'queenRookEndgame'], [/queen endgame|queen ending/, 'queenEndgame'], [/endgame|end game|ending/, 'endgame'], [/middlegame|middle game/, 'middlegame'], [/\bopening/, 'opening'],
];
const UNSUPPORTED = [
  [/time (trouble|pressure)|clock|blitz|bullet/, 'time pressure (puzzles are not timed by theme)'],
  [/positional|strategy|strategic|pawn structure|prophylaxis|outpost|bad bishop|good knight|space advantage/, 'positional or strategic ideas (Lichess puzzle themes cover tactics, mates and endgames)'],
  [/exchange sacrifice|greek gift|windmill|opposition|lucena|philidor|triangulat/, 'that specific pattern (it has no Lichess theme)'],
  [/sicilian|french|caro|italian|ruy lopez|queen'?s gambit|king'?s indian|london system|opening repertoire/, 'a named opening (themes do not name openings)'],
];
function parseRequest(text) {
  const s = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9\s.'\-+]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const raw = { themes: [], match: 'all' }, notes = [], limits = [];
  const found = [];
  for (const [re, id] of RULES) if (re.test(s) && !found.includes(id)) found.push(id);
  // a specific endgame (rook, pawn...) already says "endgame"
  const out = found.filter((id) => !(id === 'endgame' && found.some((x) => /^(pawn|rook|bishop|knight|queen|queenRook)Endgame$/.test(x))) && !(id === 'promotion' && found.includes('underPromotion')));
  // "checkmate" / "mate in N"
  const mn = /mate in (\d|one|two|three|four|five)/.exec(s), isMate = /check ?mate|\bmates?\b|\bmating\b/.test(s);
  if (mn) { const n = NUM[mn[1]] || +mn[1]; out.push(n >= 5 ? 'mateIn5' : 'mateIn' + n); }
  else if (isMate && !out.some((t) => /Mate$/.test(t) || t === 'mate')) out.push('mate');
  raw.themes = out.filter((t) => THEME_BY_ID.has(t));
  // difficulty
  const nums = [...s.matchAll(/\b(\d{3,4})\b/g)].map((m) => +m[1]).filter((n) => n >= 400 && n <= 3500);
  const rng = /(\d{3,4})\s*(?:-|to|and)\s*(\d{3,4})/.exec(s);
  if (rng && +rng[1] >= 400 && +rng[2] <= 3500) { raw.min = Math.min(+rng[1], +rng[2]); raw.max = Math.max(+rng[1], +rng[2]); }
  else if (nums.length && /(under|below|less than|up to|at most|max)\s*\d/.test(s)) raw.max = nums[0];
  else if (nums.length && /(above|over|more than|at least|min|\d\s*\+)/.test(s)) raw.min = nums[0];
  else if (nums.length) { raw.min = Math.max(0, nums[0] - 150); raw.max = nums[0] + 150; }
  else if (/very hard|extremely|brutal|insane|hardest|grandmaster|\bmaster\b/.test(s)) raw.band = 'master';
  else if (/\bexpert\b/.test(s)) raw.band = 'expert';
  else if (/difficult|\bhard\b|challenging|tough/.test(s)) raw.min = 1900;
  else if (/advanced/.test(s)) raw.band = 'advanced';
  else if (/intermediate|medium|moderate/.test(s)) raw.band = 'intermediate';
  else if (/beginner|\beasy\b|simple|novice|starter/.test(s)) raw.band = 'beginner';
  // length
  if (/several moves|many moves|multi[- ]?move|calculat|deep|long (line|combination|sequence)|complex/.test(s) && !mn) raw.minLen = 3;
  if (/one[- ]move|single move|quick/.test(s)) raw.maxLen = 1;
  // a piece making the first move of the solution
  const pc = /\b(knight|bishop|rook|queen|pawn|king)s?\b(?! (structure|endgame|ending|majority|chain|island|storm|break))/.exec(s);
  if (pc) { const c = { knight: 'N', bishop: 'B', rook: 'R', queen: 'Q', pawn: 'P', king: 'K' }[pc[1]]; if (!raw.themes.some((t) => new RegExp(PIECES[c], 'i').test(t) && /Endgame$/.test(t))) raw.firstPiece = c; }
  for (const [re, why] of UNSUPPORTED) if (re.test(s)) limits.push(why);
  return { raw, limits };
}

// what a clean filter means, in words (built from the validated filter, never from the AI's own text)
function describe(f) {
  const parts = [];
  if (f.themes.length) parts.push((f.themes.length > 1 ? (f.match === 'any' ? 'any of ' : 'all of ') : '') + f.themes.map(labelOf).join(f.match === 'any' ? ' / ' : ' + '));
  if (f.min > 0 || f.max < 4000) parts.push(f.min <= 0 ? `rated up to ${f.max}` : f.max >= 4000 ? `rated ${f.min}+` : `rated ${f.min}–${f.max}`);
  if (f.firstPiece) parts.push(`the first move is made by a ${PIECES[f.firstPiece]}`);
  if (f.minLen && f.maxLen && f.minLen === f.maxLen) parts.push(`${f.minLen}-move solutions`);
  else { if (f.minLen) parts.push(`${f.minLen}+ move solutions`); if (f.maxLen) parts.push(`at most ${f.maxLen} move${f.maxLen > 1 ? 's' : ''}`); }
  return parts;
}
// if nothing matches, the closest looser versions of the filter that do
function relax(f) {
  const tries = [];
  const add = (label, g) => { const n = count(g); if (n) tries.push({ label, filter: g, count: n }); };
  if (f.firstPiece) add('Any piece can make the first move', { ...f, firstPiece: '' });
  if (f.minLen || f.maxLen) add('Any solution length', { ...f, minLen: 0, maxLen: 0 });
  if (f.min > 0 || f.max < 4000) add('Any rating', { ...f, min: 0, max: 4000 });
  if (f.themes.length > 1 && f.match === 'all') add('Match any of the themes', { ...f, match: 'any' });
  if (f.themes.length > 1) for (const t of f.themes) add(`Only ${labelOf(t)}`, { ...f, themes: [t], match: 'all' });
  return tries.slice(0, 4);
}

// ---------- training progress ----------
const DAY = 86400e3, dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const newProgress = () => ({ v: 0, rating: 1000, n: 0, ok: 0, ms: 0, msN: 0, themes: {}, hist: [], miss: [], seen: [], days: {}, rhist: [], cur: null });
function expected(a, b) { return 1 / (1 + Math.pow(10, (b - a) / 400)); }
// one finished puzzle. `ok` means solved cleanly (no wrong move, no hint, no solution shown).
function record(p, { id, rating, themes, ok, ms, now = Date.now() }) {
  const k = p.n < 30 ? 40 : p.n < 150 ? 24 : 16, before = p.rating;
  p.rating = clamp(Math.round(before + k * ((ok ? 1 : 0) - expected(before, rating))), 400, 3200);
  p.n++; if (ok) { p.ok++; if (ms > 0) { p.ms += Math.min(ms, 600e3); p.msN++; } }
  for (const t of themes) { if (!THEME_BY_ID.has(t)) continue; const x = (p.themes[t] = p.themes[t] || { n: 0, ok: 0 }); x.n++; if (ok) x.ok++; }
  p.hist = [...p.hist, { t: now, id, r: rating, ok: ok ? 1 : 0, ms: Math.min(ms || 0, 600e3), th: themes.filter((t) => THEME_BY_ID.has(t)).slice(0, 5) }].slice(-300);
  if (!ok) p.miss = [{ id, t: now, r: rating, th: themes.filter((t) => THEME_BY_ID.has(t)).slice(0, 5) }, ...p.miss.filter((x) => x.id !== id)].slice(0, 30);
  else p.miss = p.miss.filter((x) => x.id !== id);
  p.seen = [...p.seen.filter((x) => x !== id), id].slice(-500);
  const dk = dayKey(now), d = (p.days[dk] = p.days[dk] || { n: 0, ok: 0 }); d.n++; if (ok) d.ok++;
  const keep = Object.keys(p.days).sort().slice(-60); p.days = Object.fromEntries(keep.map((x) => [x, p.days[x]]));
  p.rhist = [...p.rhist, [now, p.rating]].slice(-120);
  return { before, after: p.rating, delta: p.rating - before };
}
const GENERIC = new Set(['mate', 'mateIn1', 'mateIn2', 'mateIn3', 'mateIn4', 'mateIn5', 'short', 'long', 'veryLong', 'oneMove', 'advantage', 'crushing', 'equality', 'opening', 'middlegame', 'endgame']);
// themes the player keeps failing: at least 3 attempts, failing more than 40%, worst first (generic labels only count when nothing else does)
function weakThemes(p, limit = 3) {
  const rows = Object.entries(p.themes).filter(([, x]) => x.n >= 3).map(([id, x]) => ({ id, n: x.n, rate: x.ok / x.n })).filter((x) => x.rate < 0.6);
  const recent = {}; for (const m of p.miss.slice(0, 15)) for (const t of m.th) recent[t] = (recent[t] || 0) + 1;
  const score = (x) => (1 - x.rate) * Math.log2(1 + x.n) + (recent[x.id] || 0) * 0.35;
  const specific = rows.filter((x) => !GENERIC.has(x.id)).sort((a, b) => score(b) - score(a));
  const list = specific.length ? specific : rows.sort((a, b) => score(b) - score(a));
  return list.slice(0, limit);
}
// adaptive difficulty: aim near the rating, a little higher after a good run and lower after a bad one (last 10 puzzles)
function adaptiveTarget(p) {
  const last = p.hist.slice(-10);
  if (last.length < 4) return p.rating;
  const rate = last.filter((x) => x.ok).length / last.length;
  return Math.round(p.rating + (rate >= 0.85 ? 120 : rate >= 0.7 ? 50 : rate <= 0.4 ? -140 : rate <= 0.55 ? -60 : 0));
}
// the filter a training mode uses. relative: 'easier' | 'same' | 'harder' sets the range around the player's rating.
function filterFor(mode, input, p) {
  const base = normalizeFilter(input || {}).filter;
  if (mode === 'weakness') {
    const weak = weakThemes(p, 3);
    if (weak.length) { const t = adaptiveTarget(p); return { filter: { ...normalizeFilter({ themes: [weak[Math.floor(Math.random() * weak.length)].id], min: t - 250, max: t + 250 }).filter }, weak }; }
    return { filter: normalizeFilter({ min: p.rating - 250, max: p.rating + 250 }).filter, weak: [] };
  }
  if (mode === 'mixed') { const t = p.rating + ({ easier: -200, harder: 200 }[(input || {}).relative] || 0); return { filter: normalizeFilter({ min: (input && input.min) != null ? input.min : t - 300, max: (input && input.max) != null ? input.max : t + 300 }).filter }; }
  if (input && input.relative) { const t = p.rating + ({ easier: -250, harder: 250 }[input.relative] || 0); return { filter: { ...base, min: t - 150, max: t + 150 } }; }
  return { filter: base };
}

module.exports = { THEMES, KNOWN_THEMES, THEME_BY_ID, POPULAR, BANDS, PIECES, bandOf, labelOf, verifyRow, encodeRow, load, available, normalizeFilter, find, count, pick, present, checkMove, hintFor, stateAfter, reviewFacts, parseRequest, describe, relax, newProgress, record, weakThemes, adaptiveTarget, filterFor, expected, dayKey, enrich };
