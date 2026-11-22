// REELS commentary: what actually happened in the moment, in plain words. "THE ROOK SACRIFICE CHANGED EVERYTHING" says
// nothing; this says what the move was, what followed (the moves themselves), whether it led to mate or won material, and
// how the game ended. Built only from the game's moves, the engine's evaluations and the result:
//   facts()  - the verified facts of one highlight (pure)
//   plain()  - a clear explanation from those facts alone (always correct; used when the AI is off or wrong)
//   write()  - the Domination Report's AI (lib/damagetext.js ask) rewrites it as commentary; its text is checked so it
//              mentions no move, number or result that isn't in the facts, else plain() is kept.
const Excite = require('../public/excite.js');

const PIECE = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };
const SAN_RE = /\b(?:O-O(?:-O)?|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=[QRBN])?|[a-h][1-8]=[QRBN])[+#]?|\b[a-h][1-8][+#]/g;
const fromUci = (u) => ({ from: 'abcdefgh'.indexOf(u[0]) + (8 - +u[1]) * 8, to: 'abcdefgh'.indexOf(u[2]) + (8 - +u[3]) * 8, ...(u[4] ? { promo: u[4].toUpperCase() } : {}) });
const moveNo = (ply) => Math.ceil(ply / 2);
const pawns = (cp) => (cp == null ? null : Excite.isMate(cp) ? (cp > 0 ? 'mate' : 'getting mated') : (cp >= 0 ? '+' : '') + (Math.round(cp / 10) / 10).toFixed(1));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// plies a..b (1-based, inclusive) as "16. Qb8+ Nxb8 17. Rd8#" / "17... Kf8 18. Qh8#"
function lineOf(rep, a, b) {
  const out = [];
  for (let i = a; i <= b && i <= rep.plies.length; i++) {
    const p = rep.plies[i - 1];
    if (p.color === 'w') out.push(`${moveNo(i)}. ${p.san}`); else out.push(i === a ? `${moveNo(i)}... ${p.san}` : p.san);
  }
  return out.join(' ');
}

function facts(h, ev) {
  const hist = String(h.moves || '').split(' ').filter(Boolean).map(fromUci), rep = Excite.replay(hist);
  if (!rep || !rep.plies.length) return null;
  const n = rep.plies.length, winSide = h.result === 'w' || h.result === 'b' ? h.result : null;
  const name = (c) => (c === 'w' ? h.w.name : h.b.name), other = (c) => (c === 'w' ? 'b' : 'w');
  // the move the moment is about
  let key = h.ply;
  if (h.k === 'mate') key = Math.min(n, (h.seq ? h.seq[0] : h.ply) + 1);
  if (h.k === 'comeback') { const c = winSide; key = h.ply + 1; for (let i = h.ply + 1; ev && i <= n; i++) if (ev[i] != null && (c === 'w' ? Excite.wp(ev[i]) : 1 - Excite.wp(ev[i])) >= 0.5) { key = i; break; } }
  if (['upset', 'streak', 'scramble'].includes(h.k)) key = n;
  key = Math.max(1, Math.min(n, key));
  const kp = rep.plies[key - 1], who = kp.color, end = h.k === 'mate' ? n : Math.min(n, key + 4);
  const f = {
    kind: h.k, who: name(who), opp: name(other(who)), side: who,
    key: `${moveNo(key)}${who === 'w' ? '.' : '...'} ${kp.san}`, keyMove: moveNo(key), keySan: kp.san,
    line: lineOf(rep, key, end), rest: key < end ? lineOf(rep, key + 1, end) : '', lineStart: key, lineEnd: end,
    before: ev && ev[key - 1] != null ? pawns((who === 'w' ? 1 : -1) * ev[key - 1]) : null,
    after: ev && ev[key] != null ? pawns((who === 'w' ? 1 : -1) * ev[key]) : null,
    result: winSide ? `${name(winSide)} won` : 'a draw', winner: winSide ? name(winSide) : null, reason: h.reason || null, moves: moveNo(n),
  };
  // what it led to: checkmate soon after, or material won (net, from the mover's side, a few moves on)
  if (rep.plies[n - 1].mate && winSide === who && n - key <= 12) f.mateIn = Math.ceil((n - key) / 2);     // 0: the move itself was mate
  const m0 = rep.mat[key - 1], m1 = rep.mat[Math.min(n, key + 6)], net = (m1[who] - m1[other(who)]) - (m0[who] - m0[other(who)]);
  f.net = net;
  const taken = rep.plies.slice(key - 1, Math.min(n, key + 6)).filter((p) => p.color === who && p.cap).map((p) => p.cap).sort((a, b) => Excite.VAL[b] - Excite.VAL[a]);
  if (taken.length) f.won = PIECE[taken[0]];
  const given = h.k === 'brilliant' ? (/THE (\w+) SACRIFICE/.exec(h.head || '') || [])[1] : null;
  if (given) f.sac = given.toLowerCase();
  f.allSan = new Set(rep.plies.map((p) => p.san));
  f.nums = new Set([f.keyMove, f.moves, f.mateIn, net > 0 ? net : null, ...Array.from({ length: moveNo(f.lineEnd) - moveNo(f.lineStart) + 1 }, (_, i) => moveNo(f.lineStart) + i), h.len, h.w.elo, h.b.elo, ...(String(h.text || '').match(/\d+/g) || []).map(Number), ...[f.before, f.after].filter(Boolean).map((x) => Math.abs(parseFloat(x)))].filter((x) => x != null && !Number.isNaN(x)));
  return f;
}

// what the moment led to, as one sentence after the key move
function consequence(f) {
  if (f.mateIn === 0) return 'That was checkmate.';
  if (f.mateIn != null) return `After ${f.rest}, it was checkmate.`;
  const result = f.winner ? `${f.winner === f.who ? f.who : f.winner} went on to win by ${f.reason} at move ${f.moves}` : `the game was drawn at move ${f.moves}`;
  if (f.net >= 2 && f.rest) return `After ${f.rest}, ${f.who} was ${plural(f.net, 'point')} of material up, and ${result}.`;
  return `${result.replace(/^./, (c) => c.toUpperCase())}.`;
}
const ending = (f) => (f.mateIn != null ? (f.mateIn === 0 ? 'and it was checkmate on the spot' : `and it ended in checkmate ${plural(f.mateIn, 'move')} later`) : f.winner ? `${f.winner} went on to win by ${f.reason} at move ${f.moves}` : `the game was drawn at move ${f.moves}`);

// the headline: specific to what the moment led to (falls back to the stored one)
function headline(h, f) {
  if (!f) return h.head;
  if (h.k === 'brilliant' && f.sac) return f.mateIn != null ? `THE ${f.sac.toUpperCase()} SACRIFICE THAT FORCED MATE.` : f.net >= 2 ? `THE ${f.sac.toUpperCase()} SACRIFICE THAT PAID BACK DOUBLE.` : `THE ${f.sac.toUpperCase()} SACRIFICE THAT WON THE GAME.`;
  if (h.k === 'tactic') return f.mateIn != null ? 'ONE MOVE, THEN MATE.' : f.won && f.net >= 3 ? `ONE MOVE WON A ${f.won.toUpperCase()}.` : h.head;
  return h.head;
}

// what happened, from the facts alone
function plain(h, f) {
  if (!f) return h.text;
  const line = f.line, lineDiff = line !== f.key;
  switch (h.k) {
    case 'brilliant':
      return `${f.who} gave up the ${f.sac || 'material'} with ${f.key}, and Stockfish says it was the best move. ${consequence(f)}`;
    case 'tactic':
      return `${f.key} took ${f.who} from ${f.before} to ${f.after} by Stockfish. ${consequence(f)}`;
    case 'mate':
      return `From move ${f.keyMove}, ${f.who} had a forced mate and played it: ${line}.`;
    case 'comeback':
      return `${h.text} The turning point was ${f.key}${f.rest ? `, then ${f.rest}` : ''}.`;
    case 'upset': case 'streak': case 'scramble':
      return `${h.text} The finish: ${lineOf(Excite.replay(String(h.moves).split(' ').filter(Boolean).map(fromUci)), Math.max(1, f.lineStart - 3), f.lineStart)}.`;
    default: return h.text;
  }
}

// What the AI wrote may mention only moves that were played, numbers from the facts and the two players.
function problem(text, f) {
  if (typeof text !== 'string') return 'not text';
  const t = text.trim();
  if (t.length < 25 || t.length > 280) return 'length';
  for (const s of t.match(SAN_RE) || []) if (!f.allSan.has(s) && !f.allSan.has(s + '+') && !f.allSan.has(s + '#')) return 'unplayed move ' + s;
  for (const x of t.replace(SAN_RE, '').match(/\d+(?:\.\d+)?/g) || []) if (!f.nums.has(Number(x))) return 'unknown number ' + x;
  if (/\bmate\b|checkmate/i.test(t) && f.mateIn == null && f.kind !== 'mate' && f.reason !== 'checkmate') return 'mate that did not happen';
  if (/resign/i.test(t) && f.reason !== 'resignation') return 'resignation that did not happen';
  if (/\b(time|flag|clock)\b/i.test(t) && f.reason !== 'timeout' && f.kind !== 'scramble') return 'timeout that did not happen';
  return null;
}
const SYSTEM = 'You write the caption for a chess highlight reel. Explain clearly what happened in the moment and what it led to (checkmate, material won, the result), like a sharp commentator speaking to club players. Use only the facts given: never invent a move, number, evaluation or outcome. Write moves exactly as given. 1-2 sentences, at most 45 words. Reply with JSON only: {"text": "..."}';
async function write(h, ev, ask, deps = {}) {
  const f = facts(h, ev), base = { head: headline(h, f), text: plain(h, f), src: 'plain' };
  if (!f || !ask) return base;
  const given = { highlight: h.cat, headline: base.head, white: `${h.w.name} (${h.w.elo || '?'})`, black: `${h.b.name} (${h.b.elo || '?'})`, player: f.who, opponent: f.opp, key_move: f.key, moves_that_followed: f.line,
    stockfish_before: f.before, stockfish_after: f.after, checkmate_moves_later: f.mateIn, material_won_points: f.net > 0 ? f.net : null, piece_won: f.won || null, piece_sacrificed: f.sac || null,
    result: f.result, ended_by: f.reason, total_moves: f.moves, context: h.text, plain_explanation: base.text };
  let out = null;
  try { out = await ask(deps, SYSTEM, JSON.stringify(given), 200); } catch (e) { out = null; }
  const t = out && typeof out.text === 'string' ? out.text.trim().replace(/^["“]|["”]$/g, '') : null;
  if (t && !problem(t, f)) return { ...base, text: t, src: 'ai' };
  return base;
}

module.exports = { facts, plain, headline, problem, write, lineOf, SYSTEM };
