// The Damage Report: how brutal was this one game? Everything here is deterministic and runs on the server, from a
// saved game (the moves the server validated) and, when it is ready, the engine's evaluation of every position.
// Nothing a browser sends is ever an input. Pure functions, so they can be tested without a server.
//
//   replay(hist)                      -> per-move facts and the position after every move
//   eligible(game)                    -> null, or why this game never gets a card
//   buildFacts(game, rep, analysis)   -> what happened (material, blunders, missed chances, tactics, king hunt…)
//   score(facts)                      -> { kind, score, band, … }  0-100, or a comeback
//   headline(facts) / detail(facts)   -> the short reason lines on a card
const Chess = require('../public/chess.js');

const VAL = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
const NAME = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };
const MATE = 100000, MATED = MATE - 1000, CP_CAP = 1500;
const BANDS = [
  { key: 'competitive', label: 'Competitive', min: 0 },
  { key: 'slight', label: 'Slight edge', min: 21 },
  { key: 'dominant', label: 'Dominant', min: 41 },
  { key: 'brutal', label: 'Brutal', min: 61 },
  { key: 'complete', label: 'Complete domination', min: 81 },
];
const bandOf = (s) => { let b = BANDS[0]; for (const x of BANDS) if (s >= x.min) b = x; return b; };
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const other = (c) => (c === 'w' ? 'b' : 'w');
const moveNo = (ply) => Math.ceil(ply / 2);
const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamp(cp, -CP_CAP, CP_CAP))) - 1);   // 0-100 chance of winning for the side the score favours

// ---------- replay ----------
function replay(hist) {
  const states = [Chess.initial()], plies = [];
  let mat = { w: 39, b: 39 };
  const mats = [{ ...mat }];
  for (const h of hist || []) {
    const st = states[states.length - 1];
    const m = Chess.legalMoves(st).find((x) => x.from === h.from && x.to === h.to && (x.promo || undefined) === (h.promo || undefined));
    if (!m) return null;
    const piece = st.board[m.from][1], color = st.turn, ns = Chess.apply(st, m), cap = ns._captured ? ns._captured[1] : null;
    if (cap) mat = { ...mat, [other(color)]: mat[other(color)] - VAL[cap] };
    if (m.promo) mat = { ...mat, [color]: mat[color] + VAL[m.promo] - 1 };
    const over = Chess.status(ns);
    plies.push({ color, piece, from: m.from, to: m.to, cap, promo: m.promo || null, castle: !!m.castle, check: Chess.inCheck(ns, ns.turn), mate: over.over && over.result === color, san: Chess.notate(st, m) });
    states.push(ns); mats.push({ ...mat });
  }
  return { states, plies, mats, n: plies.length };
}

// ---------- who gets a card ----------
function eligible(g) {
  if (!g || g.local) return 'not an online game';                       // pass & play results come from one device
  if (!g.result || g.result === 'draw') return 'draw';
  if (!['checkmate', 'resignation', 'timeout'].includes(g.reason)) return 'not a finished game';
  if (!g.players || !g.players.w || !g.players.b || g.players.w.name === g.players.b.name) return 'no two players';
  const n = (g.hist || []).length;
  if (n < 8) return 'too short to say anything';
  if (g.reason === 'timeout' && n < 20) return 'a disconnect, not a game';
  if (g.reason === 'resignation' && n < 10) return 'too short to say anything';
  return null;
}

// ---------- the facts ----------
function accuracy(ev, plies, colors) {
  const out = { w: [], b: [] }, good = { w: 0, b: 0 };
  for (let i = 1; i <= plies.length; i++) {
    const c = plies[i - 1].color, sign = c === 'w' ? 1 : -1;
    const before = winPct(sign * ev[i - 1]), after = winPct(sign * ev[i]);
    const loss = Math.max(0, before - after);
    out[c].push(clamp(103.1668 * Math.exp(-0.04354 * loss) - 3.1669, 0, 100));
    if (loss < 1.5) good[c]++;
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return { w: avg(out.w), b: avg(out.b), good };
}

function buildFacts(g, rep, ana) {
  const n = rep.n, W = g.result, L = other(W), plies = rep.plies, mats = rep.mats;
  const names = { w: g.players.w.name, b: g.players.b.name };
  const rate = (c) => (g.ratings && g.ratings[c] ? g.ratings[c].before : g.players[c].elo) || 1200;
  const f = {
    id: g.id, plies: n, moves: moveNo(n), result: W, wc: W, lc: L, winner: names[W], loser: names[L],
    reason: g.reason, ratingW: rate(W), ratingL: rate(L), tc: g.tc || null, cat: g.cat || null,
    mate: g.reason === 'checkmate', analysis: ana && ana.ev && ana.ev.length === n + 1 ? 'done' : 'result',
    moments: [],
  };
  // material
  let maxLead = 0, bigPly = null, queenLost = null, lostPieces = 0;
  for (let i = 1; i <= n; i++) {
    const lead = mats[i][W] - mats[i][L];
    if (lead > maxLead) maxLead = lead;
    if (bigPly == null && lead >= 5) bigPly = i;
  }
  for (let i = 1; i <= n; i++) {
    const p = plies[i - 1];
    if (p.color === W && p.cap && p.cap !== 'P') {
      lostPieces++;
      if (p.cap === 'Q' && !queenLost) {
        const back = (plies[i] && plies[i].cap === 'Q' && plies[i].color === L) || (plies[i + 1] && plies[i + 1].cap === 'Q' && plies[i + 1].color === L);   // traded, not lost
        if (!back) queenLost = { ply: i, move: moveNo(i) };
      }
    }
  }
  // what each side lost over the game (pieces captured, by letter)
  f.lossesL = {}; f.lossesW = {};
  for (const p of plies) if (p.cap) { const t = p.color === W ? f.lossesL : f.lossesW; t[p.cap] = (t[p.cap] || 0) + 1; }
  f.mat = { maxLead, finalLead: mats[n][W] - mats[n][L], bigPly, queenLost, lostPieces, loserLost: 39 - mats[n][L], winnerLost: 39 - mats[n][W] };
  // king hunt (the last 16 plies)
  let checks = 0, kingMoves = 0;
  for (let i = Math.max(1, n - 15); i <= n; i++) { const p = plies[i - 1]; if (p.color === W && p.check) checks++; if (p.color === L && p.piece === 'K' && !p.castle) kingMoves++; }
  f.king = { checks, kingMoves, hunted: checks >= 2 || kingMoves >= 2 };
  if (f.mate && f.king.hunted) f.moments.push({ type: 'king', checks, kingMoves });
  if (queenLost) f.moments.push({ type: 'queen', move: queenLost.move, ply: queenLost.ply, survived: moveNo(n) - queenLost.move });
  f.blunders = []; f.missed = []; f.tactics = [];
  if (f.analysis === 'done') analyseMoments(f, g, rep, ana);
  else provisionalShape(f, rep);
  if (f.mate) f.moments.push({ type: 'mate', in: f.moves, early: f.moves <= 22 });
  return f;
}

// ---------- moments that need the engine ----------
function analyseMoments(f, g, rep, ana) {
  const { plies, states, mats, n } = rep, ev = ana.ev, W = f.wc, L = f.lc, sg = (c) => (c === 'w' ? 1 : -1);
  const acc = accuracy(ev, plies);
  f.acc = { w: acc.w, b: acc.b }; f.good = acc.good;
  // evaluation as the winner sees it
  const ew = ev.map((x) => sg(W) * x);
  f.eval = { series: ev.map((x) => Math.round(clamp(x, -CP_CAP, CP_CAP))), final: ew[n] };
  let domPlies = 0, bigDom = 0, counted = 0, firstDom = null, firstSettled = null;
  for (let i = 8; i <= n; i++) { counted++; if (ew[i] >= 300) { domPlies++; if (firstDom == null) firstDom = i; } if (ew[i] >= 900) bigDom++; }
  f.dom = { share: counted ? domPlies / counted : 0, big: counted ? bigDom / counted : 0, firstPly: firstDom, plies: domPlies };
  // did the loser ever have a real chance, and did the winner come back from the dead?
  let lChance = 0, low = { v: Infinity, ply: 0 }, run = 0, deadRun = 0, deadAt = null;
  for (let i = 10; i <= n; i++) {
    if (-ew[i] >= 250) lChance++;
    if (ew[i] < low.v) low = { v: ew[i], ply: i };
    if (ew[i] <= -300) { run++; if (run >= 4 && !deadAt) deadAt = i - 3; deadRun = Math.max(deadRun, run); } else run = 0;
  }
  f.chance = { had: lChance >= 3, plies: lChance, best: Math.max(...ew.slice(10).map((x) => -x), -9999) };
  if (deadAt != null) {
    let peak = -Infinity; for (let i = deadAt; i <= n; i++) peak = Math.max(peak, ew[i]);
    f.comeback = { low: Math.round(clamp(low.v, -CP_CAP, CP_CAP)), lowMove: moveNo(low.ply), swing: Math.round(clamp(ew[n] > MATED ? CP_CAP : ew[n], -CP_CAP, CP_CAP) - clamp(low.v, -CP_CAP, CP_CAP)), plies: deadRun };
    f.moments.push({ type: 'comeback', lowMove: f.comeback.lowMove, down: Math.round(-f.comeback.low / 100) });
  }
  // the moment it was decided: the winner's eval crosses +300 and stays
  let settled = null;
  for (let i = n; i >= 1; i--) { if (ew[i] < 300) { settled = i + 1; break; } if (i === 1) settled = 1; }
  f.settled = settled;
  // shape of the game
  const early = settled != null && settled <= Math.max(14, n * 0.3);
  f.shape = f.chance.had || f.comeback ? 'competitive' : early ? 'onesided' : 'collapse';
  // every move of the loser, and of the winner: blunders, missed chances
  for (let i = 1; i <= n; i++) {
    const p = plies[i - 1], c = p.color, s = sg(c);
    const before = ev[i - 1] * s, after = ev[i] * s, wpB = winPct(before), wpA = winPct(after), loss = wpB - wpA;
    const mine = c === L;
    const prevBest = ana.best && ana.best[i - 1];
    // missed a forced mate (they had it, then played something that is not it)
    const mateBefore = before > MATED ? MATE - before : 0;
    if (mateBefore > 0 && mateBefore <= 7 && !(after > MATED && MATE - after < mateBefore)) {
      f.missed.push({ ply: i, move: moveNo(i), side: c, kind: 'mate', n: Math.ceil(mateBefore / 2), played: p.san, best: prevBest || null });
    } else if (wpB >= 85 && wpA <= 60 && before - after >= 300 && !(after > MATED)) {
      f.missed.push({ ply: i, move: moveNo(i), side: c, kind: 'win', played: p.san, drop: Math.round(Math.min(before, CP_CAP) - clamp(after, -CP_CAP, CP_CAP)), best: prevBest || null });
    }
    if (loss >= 20 && wpB >= 8 && !(wpB > 97 && wpA > 90)) {
      const nx = plies[i], nx2 = plies[i + 1];
      let kind = 'drop', piece = null;
      if (nx && nx.cap && VAL[nx.cap] >= 3 && nx.color !== c) {                // the reply takes a piece; was it won back?
        const back = nx2 && nx2.color === c && nx2.cap && VAL[nx2.cap] >= VAL[nx.cap] - 1;
        if (!back) { kind = 'hung'; piece = nx.cap; }
      }
      if (kind === 'drop' && nx && nx.color !== c && forkAt(rep, i + 1)) kind = 'fork';
      if (kind === 'drop' && ew[i] >= 5000) kind = 'mate';
      f.blunders.push({ ply: i, move: moveNo(i), side: c, kind, piece, drop: Math.round(clamp(before, -CP_CAP, CP_CAP) - clamp(after, -CP_CAP, CP_CAP)), played: p.san });
    } else if (loss >= 10 && wpB >= 8) (f.mistakes = f.mistakes || { w: 0, b: 0 })[c]++;
    // tactics by the winner that the engine confirms
    if (c === W && !mine) {
      const gain = after - before;
      if (forkAt(rep, i) && gain >= 150 && plies[i] && plies[i].cap) f.tactics.push({ ply: i, move: moveNo(i), kind: 'fork', piece: p.piece });
      else if (VAL[p.piece] >= 3 && plies[i] && plies[i].to === p.to && plies[i].cap === p.piece && p.piece !== 'K') {
        const net = (mats[i + 1][W] - mats[i + 1][L]) - (mats[i - 1][W] - mats[i - 1][L]);
        const evAfter = i + 1 <= n ? ew[i + 1] : ew[i];
        if (net <= -2 && evAfter >= ew[i - 1] - 30 && evAfter >= 150) f.tactics.push({ ply: i, move: moveNo(i), kind: 'sacrifice', piece: p.piece });
      }
    }
  }
  for (const side of ['w', 'b']) f['bl' + side] = f.blunders.filter((b) => b.side === side).length;
  f.loserBlunders = f.blunders.filter((b) => b.side === L);
  for (const b of f.loserBlunders.slice(0, 4)) f.moments.push({ type: 'blunder', ...b });
  for (const m of f.missed.slice(0, 3)) f.moments.push({ type: 'missed', ...m });
  for (const t of f.tactics.slice(0, 2)) f.moments.push({ type: 'tactic', ...t });
  f.loserMistakes = (f.mistakes && f.mistakes[L]) || 0;
}

// the piece that just moved attacks two or more pieces worth winning (or the king and a piece)
function forkAt(rep, ply) {
  const st = rep.states[ply], p = rep.plies[ply - 1];
  if (!st || !p || p.piece === 'K') return false;
  const probe = { ...st, turn: p.color, ep: null };
  let high = 0, seen = new Set();
  for (const m of Chess.legalMoves(probe)) {
    if (m.from !== p.to) continue;
    const t = st.board[m.to];
    if (t && t[0] !== p.color && VAL[t[1]] >= 3 && !seen.has(m.to)) { seen.add(m.to); high++; }
  }
  if (Chess.inCheck(st, other(p.color))) high++;
  return high >= 2;
}

// without the engine: the shape from material only
function provisionalShape(f, rep) {
  const { mats, n } = rep, W = f.wc, L = f.lc;
  let low = Infinity, run = 0, deadRun = 0, lowPly = 0, early = null;
  for (let i = 6; i <= n; i++) {
    const lead = mats[i][W] - mats[i][L];
    if (lead < low) { low = lead; lowPly = i; }
    if (lead <= -5) { run++; deadRun = Math.max(deadRun, run); } else run = 0;
    if (early == null && lead >= 5) early = i;
  }
  if (deadRun >= 6) { f.comeback = { low: low * 100, lowMove: moveNo(lowPly), swing: Math.round((mats[n][W] - mats[n][L] - low) * 100), plies: deadRun, material: true }; f.moments.push({ type: 'comeback', lowMove: f.comeback.lowMove, down: -low }); }
  f.shape = f.comeback ? 'competitive' : early != null && early <= Math.max(16, n * 0.4) ? 'onesided' : 'collapse';
  f.dom = { share: 0, big: 0, firstPly: early, plies: 0 };
  f.chance = { had: false, plies: 0 };
  f.loserBlunders = [];
}

// ---------- the score ----------
function score(f) {
  const prov = f.analysis !== 'done';
  const n = f.plies, W = f.wc, L = f.lc;
  if (f.comeback && !(f.mate && f.mat.maxLead >= 12 && f.dom.share > 0.6)) {
    const swing = clamp(f.comeback.swing / 2500);
    return { kind: 'comeback', score: null, band: 'comeback', label: 'Comeback', rank: Math.round(30 + swing * 55), swing: f.comeback.swing, prov };
  }
  const material = f.mat.maxLead;
  const lostFrac = clamp(f.mat.loserLost / 39);                      // how much of the loser's army was destroyed
  const earlyMat = f.mat.bigPly == null ? 0.6 : clamp(1.25 - f.mat.bigPly / 90, 0.6, 1.1);
  const cMat = clamp((0.55 * Math.min(1, lostFrac / 0.55) + 0.45 * clamp(0.8 * Math.max(f.mat.finalLead, 0.8 * material) / 14)) * earlyMat + (f.mat.lostPieces >= 5 ? 0.08 : 0) + (f.mat.queenLost && f.mat.queenLost.ply <= 40 ? 0.08 : 0));
  const cDom = prov ? clamp((f.mat.finalLead >= 3 ? 0.45 : 0) + clamp(material / 20) * 0.35) : clamp(0.8 * f.dom.share + 0.55 * f.dom.big);
  let blSum = 0;
  for (const b of f.loserBlunders) blSum += b.kind === 'hung' ? (b.piece === 'Q' ? 0.5 : 0.32) : b.kind === 'fork' ? 0.3 : b.drop >= 400 ? 0.3 : 0.2;
  blSum += (f.loserMistakes || 0) * 0.06;
  const cBlun = prov ? clamp(f.mat.queenLost ? 0.45 : 0.1) : clamp(blSum);
  const cTact = clamp(f.tactics.reduce((a, t) => a + (t.kind === 'sacrifice' ? 0.3 : 0.25), 0) + (f.mate && f.tactics.length && f.king.checks >= 2 ? 0.15 : 0));
  const cKing = f.king.hunted ? clamp(f.king.checks * 0.13 + f.king.kingMoves * 0.16 + (f.mate ? 0.15 : 0)) : 0;
  const gap = f.acc && f.acc.w != null && f.acc.b != null ? (f.acc[W] - f.acc[L]) : null;
  const cGap = gap == null ? 0 : clamp(gap / 35);
  const exp = (50 + (f.ratingL - 800) / 20) * ({ bullet: 0.7, blitz: 1, rapid: 1.1, classical: 1.2 }[f.cat] || 1);
  const cEarly = f.mate ? clamp((exp * 0.6 - n) / (exp * 0.4)) : f.eval && f.eval.final >= 900 && n < 40 ? 0.4 : 0;
  const cQuick = clamp((70 - n) / 50);
  const raw = 0.26 * cMat + 0.24 * cDom + 0.10 * cBlun + 0.06 * cTact + 0.06 * cKing + 0.10 * cGap + 0.06 * cEarly + 0.12 * cQuick;
  // how it ended
  const crushing = f.eval ? f.eval.final >= 700 : f.mat.finalLead >= 5;
  let end = f.reason === 'checkmate' ? 1 : f.reason === 'resignation' ? (crushing ? 1 : 0.75) : (f.eval ? f.eval.final >= 900 : f.mat.finalLead >= 6) && f.mat.finalLead >= 5 ? 0.85 : 0.55;
  if (f.reason === 'resignation' && n < 20) end *= 0.65;
  // who it happened to
  const dr = f.ratingW - f.ratingL;
  const rating = dr > 0 ? 1 - 0.2 * clamp(dr / 600) : 1 + 0.15 * clamp(-dr / 400);
  const evidence = n < 14 ? 0.55 : n < 20 ? 0.8 : n < 26 ? 0.92 : 1;
  const chance = f.chance && f.chance.had ? (f.chance.plies >= 8 ? 0.7 : 0.82) : 1;
  let s = raw * end * rating * evidence * chance;
  if (prov) s = Math.min(s * 0.85, 0.6);
  const out = Math.round(clamp(s) * 100);
  return {
    kind: 'domination', score: out, band: bandOf(out).key, label: bandOf(out).label, prov, shape: f.shape,
    parts: { mat: cMat, dom: cDom, blunders: cBlun, tactics: cTact, king: cKing, gap: cGap, early: cEarly, quick: cQuick, end, rating, evidence, chance },
  };
}

// ---------- the short lines on a card ----------
const ENDING = { checkmate: 'Checkmate', resignation: 'Resigned', timeout: 'Flagged' };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function detail(f) {
  const parts = [ENDING[f.reason] || 'Finished', plural(f.moves, 'move')];
  const nb = (f.loserBlunders || []).length;
  if (nb) parts.push(plural(nb, 'blunder'));
  else if (f.mat.queenLost) parts.push(`queen gone move ${f.mat.queenLost.move}`);
  else if (f.mat.finalLead >= 5) parts.push(`${Math.round(f.mat.finalLead)} points of material`);
  return parts.join(' · ');
}
function headline(f) {
  const nb = (f.loserBlunders || []).length, bits = [];
  const lead = f.reason === 'checkmate' ? `Checkmate in ${f.moves}` : f.reason === 'resignation' ? `Resigned on move ${f.moves}` : `Flagged on move ${f.moves}`;
  if (f.comeback) return `${lead}, down ${Math.round(-f.comeback.low / 100)} on move ${f.comeback.lowMove}`;
  if (nb) bits.push(plural(nb, 'blunder'));
  else if (f.mat.queenLost) bits.push(`queen gone on move ${f.mat.queenLost.move}`);
  const m = (f.missed || []).find((x) => x.kind === 'mate');
  if (m && !nb) bits.push(`mate in ${m.n} missed on move ${m.move}`);
  return [lead, ...bits].join(', ');
}

// the card as it is stored and shown: only facts, never anything a client wrote
function cardOf(g, f, sc) {
  const out = {
    id: g.id, code: g.code, at: g.endedAt, w: g.players.w.name, b: g.players.b.name,
    rw: f.wc === 'w' ? f.ratingW : f.ratingL, rb: f.wc === 'b' ? f.ratingW : f.ratingL,
    result: g.result, reason: g.reason, plies: f.plies, moves: f.moves, tc: g.tc || null, cat: g.cat || null,
    kind: sc.kind, score: sc.score, band: sc.band, label: sc.label, rank: sc.kind === 'comeback' ? sc.rank : sc.score, prov: !!sc.prov, shape: f.shape,
    headline: headline(f), detail: detail(f), analysis: f.analysis,
    swing: sc.swing || null,
    tl: f.eval ? sampleSeries(f.eval.series, 60) : null,
    low: null,
    hl: highlights(f),
  };
  const worst = (f.loserBlunders || []).slice().sort((a, b) => b.drop - a.drop)[0];
  if (worst) out.low = { ply: worst.ply, move: worst.move, label: worst.kind === 'hung' ? `${NAME[worst.piece]} hung` : worst.kind === 'fork' ? 'walked into a fork' : 'blunder' };
  else if (f.mat.queenLost) out.low = { ply: f.mat.queenLost.ply, move: f.mat.queenLost.move, label: 'queen lost' };
  return out;
}
// 3 to 5 real moments for the report that opens when a card is clicked (every one comes from the facts)
function highlights(f) {
  const W = f.winner, L = f.loser, hl = [];
  const pawns = (d) => Math.max(1, Math.round(d / 100));
  if (f.comeback) hl.push({ move: f.comeback.lowMove, text: `${W} was down about ${pawns(-f.comeback.low)} pawns on move ${f.comeback.lowMove} and still won` });
  const q = f.mat.queenLost && !(f.loserBlunders || []).some((b) => b.piece === 'Q' && Math.abs(b.move - f.mat.queenLost.move) <= 1) ? f.mat.queenLost : null; if (q) hl.push({ move: q.move, text: `${L} lost the queen on move ${q.move}${f.moves - q.move >= 2 ? ` and played ${f.moves - q.move} more moves` : ''}` });
  for (const m of (f.missed || []).filter((x) => x.kind === 'mate').slice(0, 1)) hl.push({ move: m.move, text: `${m.side === f.lc ? L : W} missed a forced mate in ${m.n} on move ${m.move}` });
  for (const b of (f.loserBlunders || []).slice().sort((x, y) => y.drop - x.drop).slice(0, 2)) {
    hl.push({ move: b.move, text: `${L} ${b.kind === 'hung' ? `hung a ${NAME[b.piece].toLowerCase()}` : b.kind === 'fork' ? 'walked into a fork' : 'blundered'} on move ${b.move}, about ${pawns(b.drop)} pawns swung` });
  }
  for (const t of (f.tactics || []).slice(0, 1)) hl.push({ move: t.move, text: `${W} played a ${t.kind} with the ${NAME[t.piece].toLowerCase()} on move ${t.move}` });
  if (f.king && f.king.hunted) hl.push({ move: f.moves, text: `${f.king.checks} checks against ${L}'s king in the last stretch, and it moved ${f.king.kingMoves} time${f.king.kingMoves === 1 ? '' : 's'}` });
  if (f.mat.finalLead >= 3) hl.push({ move: f.moves, text: `${W} finished ${Math.round(f.mat.finalLead)} points of material ahead` });
  if (f.mat.lostPieces >= 2) hl.push({ move: f.moves, text: `${L} lost ${f.mat.lostPieces} pieces, not counting pawns` });
  if (hl.length < 2) hl.push({ move: f.moves, text: `The whole game lasted ${f.moves} moves` });
  hl.push({ move: f.moves, text: f.reason === 'checkmate' ? `Checkmate on move ${f.moves}` : f.reason === 'timeout' ? `${L} lost on time on move ${f.moves}` : `${L} resigned on move ${f.moves}` });
  const seen = new Set(), out = [];
  for (const h of hl.sort((x, y) => x.move - y.move)) if (!seen.has(h.text)) { seen.add(h.text); out.push({ move: h.move, text: h.text }); }
  return out.length <= 5 ? out : [...out.slice(0, 4), out[out.length - 1]];
}
function sampleSeries(series, n) {
  if (series.length <= n) return series.slice();
  const out = [];
  for (let i = 0; i < n; i++) out.push(series[Math.round((i / (n - 1)) * (series.length - 1))]);
  return out;
}

module.exports = { VAL, NAME, BANDS, MATE, MATED, bandOf, moveNo, winPct, replay, eligible, buildFacts, score, detail, headline, cardOf, highlights, forkAt, accuracy };
