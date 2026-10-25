// Analysis engine: game review, live move grades, the evaluation bar, the coach's grading and the playstyle models.
// It keeps its own board (10x12 mailbox with make/unmake and Zobrist hashing), so it searches far more positions per
// second than a search over the shared rules engine (chess.js), and adds a transposition table, null-move pruning,
// late-move reductions, killer/history move ordering, check extensions, repetition and 50-move draws, and a tapered
// evaluation (PeSTO tables, pawn structure, bishop pair, rooks on open files, endgame knowledge).
// Positions and moves go in and out in chess.js's format. Loaded by bot.js (worker) and by Node (tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./chess.js'));
  else root.Engine = factory(root.Chess);
})(typeof self !== 'undefined' ? self : this, function (Chess) {
  const P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6, BLACK = 8, OFF = 7;
  const INF = 1e6, MATE = 100000, MATED = MATE - 1000, MAXPLY = 96;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const STOP = { stop: true };

  const to120 = (s) => 21 + (s >> 3) * 10 + (s & 7);
  const to64 = (s) => ((s / 10 | 0) - 2) * 8 + (s % 10) - 1;
  const SQ = new Int8Array(64); for (let i = 0; i < 64; i++) SQ[i] = to120(i);
  const KN = [-21, -19, -12, -8, 8, 12, 19, 21], KG = [-11, -10, -9, -1, 1, 9, 10, 11];
  const DIAG = [-11, -9, 9, 11], ORTH = [-10, -1, 1, 10];
  const CODE = { P, N, B, R, Q, K }, LETTER = ' PNBRQK';

  // ---------- evaluation tables (PeSTO, a8 first, from White's side) ----------
  const MGV = [0, 82, 337, 365, 477, 1025, 0], EGV = [0, 94, 281, 297, 512, 936, 0], PHASE = [0, 0, 1, 1, 2, 4, 0];
  const MGT = [null,
    [0,0,0,0,0,0,0,0, 98,134,61,95,68,126,34,-11, -6,7,26,31,65,56,25,-20, -14,13,6,21,23,12,17,-23, -27,-2,-5,12,17,6,10,-25, -26,-4,-4,-10,3,3,33,-12, -35,-1,-20,-23,-15,24,38,-22, 0,0,0,0,0,0,0,0],
    [-167,-89,-34,-49,61,-97,-15,-107, -73,-41,72,36,23,62,7,-17, -47,60,37,65,84,129,73,44, -9,17,19,53,37,69,18,22, -13,4,16,13,28,19,21,-8, -23,-9,12,10,19,17,25,-16, -29,-53,-12,-3,-1,18,-14,-19, -105,-21,-58,-33,-17,-28,-19,-23],
    [-29,4,-82,-37,-25,-42,7,-8, -26,16,-18,-13,30,59,18,-47, -16,37,43,40,35,50,37,-2, -4,5,19,50,37,37,7,-2, -6,13,13,26,34,12,10,4, 0,15,15,15,14,27,18,10, 4,15,16,0,7,21,33,1, -33,-3,-14,-21,-13,-12,-39,-21],
    [32,42,32,51,63,9,31,43, 27,32,58,62,80,67,26,44, -5,19,26,36,17,45,61,16, -24,-11,7,26,24,35,-8,-20, -36,-26,-12,-1,9,-7,6,-23, -45,-25,-16,-17,3,0,-5,-33, -44,-16,-20,-9,-1,11,-6,-71, -19,-13,1,17,16,7,-37,-26],
    [-28,0,29,12,59,44,43,45, -24,-39,-5,1,-16,57,28,54, -13,-17,7,8,29,56,47,57, -27,-27,-16,-16,-1,17,-2,1, -9,-26,-9,-10,-2,-4,3,-3, -14,2,-11,-2,-5,2,14,5, -35,-8,11,2,8,15,-3,1, -1,-18,-9,10,-15,-25,-31,-50],
    [-65,23,16,-15,-56,-34,2,13, 29,-1,-20,-7,-8,-4,-38,-29, -9,24,2,-16,-20,6,22,-22, -17,-20,-12,-27,-30,-25,-14,-36, -49,-1,-27,-39,-46,-44,-33,-51, -14,-14,-22,-46,-44,-30,-15,-27, 1,7,-8,-64,-43,-16,9,8, -15,36,12,-54,8,-28,24,14],
  ];
  const EGT = [null,
    [0,0,0,0,0,0,0,0, 178,173,158,134,147,132,165,187, 94,100,85,67,56,53,82,84, 32,24,13,5,-2,4,17,17, 13,9,-3,-7,-7,-8,3,-1, 4,7,-6,1,0,-5,-1,-8, 13,8,8,10,13,0,2,-7, 0,0,0,0,0,0,0,0],
    [-58,-38,-13,-28,-31,-27,-63,-99, -25,-8,-25,-2,-9,-25,-24,-52, -24,-20,10,9,-1,-9,-19,-41, -17,3,22,22,22,11,8,-18, -18,-6,16,25,16,17,4,-18, -23,-3,-1,15,10,-3,-20,-22, -42,-20,-10,-5,-2,-20,-23,-44, -29,-51,-23,-15,-22,-18,-50,-64],
    [-14,-21,-11,-8,-7,-9,-17,-24, -8,-4,7,-12,-3,-13,-4,-14, 2,-8,0,-1,-2,6,0,4, -3,9,12,9,14,10,3,2, -6,3,13,19,7,10,-3,-9, -12,-3,8,10,13,3,-7,-15, -14,-18,-7,-1,4,-9,-15,-27, -23,-9,-23,-5,-9,-16,-5,-17],
    [13,10,18,15,12,12,8,5, 11,13,13,11,-3,3,8,3, 7,7,7,5,4,-3,-5,-3, 4,3,13,1,2,1,-1,2, 3,5,8,4,-5,-6,-8,-11, -4,0,-5,-1,-7,-12,-8,-16, -6,-6,0,2,-9,-9,-11,-3, -9,2,3,-1,-5,-13,4,-20],
    [-9,22,22,27,27,19,10,20, -17,20,32,41,58,25,30,0, -20,6,9,49,47,35,19,9, 3,22,24,45,57,40,57,36, -18,28,19,47,31,34,39,23, -16,-27,15,6,9,17,10,5, -22,-23,-30,-16,-16,-23,-36,-32, -33,-28,-22,-43,-5,-32,-20,-41],
    [-74,-35,-18,-18,-11,15,4,-17, -12,17,14,17,17,38,23,11, 10,17,23,15,20,45,44,13, -8,22,24,27,26,33,26,3, -18,-4,21,24,27,23,9,-11, -19,-3,11,21,23,16,7,-9, -27,-11,4,13,14,4,-5,-17, -53,-34,-21,-11,-28,-14,-24,-43],
  ];
  // per piece code and square (10x12), signed from White's side: material + square bonus
  const PMG = new Int16Array(16 * 120), PEG = new Int16Array(16 * 120);
  for (let t = P; t <= K; t++) for (let i = 0; i < 64; i++) {
    PMG[t * 120 + SQ[i]] = MGV[t] + MGT[t][i]; PEG[t * 120 + SQ[i]] = EGV[t] + EGT[t][i];
    PMG[(t | BLACK) * 120 + SQ[i]] = -(MGV[t] + MGT[t][i ^ 56]); PEG[(t | BLACK) * 120 + SQ[i]] = -(EGV[t] + EGT[t][i ^ 56]);
  }
  const MOB_MG = [0, 0, 4, 5, 2, 1], MOB_EG = [0, 0, 4, 5, 4, 2], MOB_AVG = [0, 0, 4, 6, 6, 12];   // per reachable square
  const PASS_MG = [0, 5, 8, 12, 20, 35, 55, 0], PASS_EG = [0, 8, 12, 22, 40, 65, 100, 0];   // by ranks advanced

  // ---------- Zobrist keys (two 32-bit halves: one picks the table slot, the other checks it) ----------
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; };
  const ZPL = new Int32Array(16 * 120), ZPH = new Int32Array(16 * 120), ZCL = new Int32Array(16), ZCH = new Int32Array(16);
  const ZEL = new Int32Array(120), ZEH = new Int32Array(120);
  for (let i = 0; i < 16 * 120; i++) { ZPL[i] = rnd(); ZPH[i] = rnd(); }
  for (let i = 0; i < 16; i++) { ZCL[i] = rnd(); ZCH[i] = rnd(); }
  for (let i = 0; i < 120; i++) { ZEL[i] = rnd(); ZEH[i] = rnd(); }
  const ZSL = rnd(), ZSH = rnd();
  ZEL[0] = ZEH[0] = 0;                // no en passant square

  // castling rights: 1 = White short, 2 = White long, 4 = Black short, 8 = Black long; cleared when these squares move
  const CMASK = new Int8Array(120).fill(15);
  CMASK[95] = 15 & ~3; CMASK[98] = 15 & ~1; CMASK[91] = 15 & ~2; CMASK[25] = 15 & ~12; CMASK[28] = 15 & ~4; CMASK[21] = 15 & ~8;

  // ---------- board state ----------
  const bd = new Int8Array(120);
  let side = 0, castle = 0, ep = 0, half = 0, hl = 0, hh = 0, mg = 0, eg = 0, phase = 0, hp = 0;
  const king = new Int8Array(2), count = new Int8Array(16);
  const HL = new Int32Array(1024), HH = new Int32Array(1024);   // position hashes along the game + search path (repetitions)
  const U_CAP = new Int8Array(1024), U_CASTLE = new Int8Array(1024), U_EP = new Int8Array(1024), U_HALF = new Int16Array(1024);

  function put(s, p) { bd[s] = p; hl ^= ZPL[p * 120 + s]; hh ^= ZPH[p * 120 + s]; mg += PMG[p * 120 + s]; eg += PEG[p * 120 + s]; phase += PHASE[p & 7]; count[p]++; }
  function take(s) { const p = bd[s]; bd[s] = 0; hl ^= ZPL[p * 120 + s]; hh ^= ZPH[p * 120 + s]; mg -= PMG[p * 120 + s]; eg -= PEG[p * 120 + s]; phase -= PHASE[p & 7]; count[p]--; return p; }

  function load(st) {
    bd.fill(OFF); count.fill(0);
    hl = hh = mg = eg = phase = 0;
    for (let i = 0; i < 64; i++) {
      const x = st.board[i], s = SQ[i];
      bd[s] = 0;
      if (!x) continue;
      const p = CODE[x[1]] | (x[0] === 'b' ? BLACK : 0);
      put(s, p);
      if ((p & 7) === K) king[p >> 3] = s;
    }
    side = st.turn === 'w' ? 0 : 1;
    const c = st.castle;
    castle = (c.wK ? 1 : 0) | (c.wQ ? 2 : 0) | (c.bK ? 4 : 0) | (c.bQ ? 8 : 0);
    ep = st.ep != null ? to120(st.ep) : 0;
    half = st.half || 0;
    hl ^= ZCL[castle] ^ ZEL[ep]; hh ^= ZCH[castle] ^ ZEH[ep];
    if (side) { hl ^= ZSL; hh ^= ZSH; }
    hp = 0; HL[0] = hl; HH[0] = hh;
  }

  function attacked(s, by) {
    const c = by << 3;
    if (by === 0) { if (bd[s + 9] === P || bd[s + 11] === P) return true; }
    else if (bd[s - 9] === (P | BLACK) || bd[s - 11] === (P | BLACK)) return true;
    for (let i = 0; i < 8; i++) { if (bd[s + KN[i]] === (N | c)) return true; if (bd[s + KG[i]] === (K | c)) return true; }
    for (let i = 0; i < 4; i++) {
      let d = DIAG[i], t = s + d, p;
      while ((p = bd[t]) === 0) t += d;
      if (p === (B | c) || p === (Q | c)) return true;
      d = ORTH[i]; t = s + d;
      while ((p = bd[t]) === 0) t += d;
      if (p === (R | c) || p === (Q | c)) return true;
    }
    return false;
  }
  const inCheck = () => attacked(king[side], side ^ 1);

  // move = from | to << 7 | promo piece type << 14 | flags << 17 (1 en passant, 2 castling, 4 double pawn push)
  const MOVES = new Int32Array(256 * MAXPLY), SCORES = new Int32Array(256 * MAXPLY);
  const mFrom = (m) => m & 127, mTo = (m) => (m >> 7) & 127, mPromo = (m) => (m >> 14) & 7, mFlag = (m) => m >> 17;

  // pseudo-legal moves into MOVES[at...]; returns the end index (quiet = false: captures and queen promotions only)
  function gen(at, quiet) {
    let n = at;
    const me = side << 3, them = (side ^ 1) << 3;
    for (let i = 0; i < 64; i++) {
      const s = SQ[i], p = bd[s];
      if (!p || (p & BLACK) !== me) continue;
      const t = p & 7;
      if (t === P) {
        const dir = side ? 10 : -10, last = side ? 9 : 2, start = side ? 3 : 8, row = s / 10 | 0;
        const fwd = s + dir;
        const promoRow = (fwd / 10 | 0) === last;
        if (bd[fwd] === 0) {
          if (promoRow) { MOVES[n++] = s | fwd << 7 | Q << 14; if (quiet) { MOVES[n++] = s | fwd << 7 | R << 14; MOVES[n++] = s | fwd << 7 | B << 14; MOVES[n++] = s | fwd << 7 | N << 14; } }
          else if (quiet) {
            MOVES[n++] = s | fwd << 7;
            if (row === start && bd[fwd + dir] === 0) MOVES[n++] = s | (fwd + dir) << 7 | 4 << 17;
          }
        }
        for (const d of [dir - 1, dir + 1]) {
          const to = s + d, q = bd[to];
          if (q && q !== OFF && (q & BLACK) === them) {
            if (promoRow) { MOVES[n++] = s | to << 7 | Q << 14; if (quiet) { MOVES[n++] = s | to << 7 | R << 14; MOVES[n++] = s | to << 7 | B << 14; MOVES[n++] = s | to << 7 | N << 14; } }
            else MOVES[n++] = s | to << 7;
          } else if (to === ep && ep) MOVES[n++] = s | to << 7 | 1 << 17;
        }
      } else if (t === N || t === K) {
        const D = t === N ? KN : KG;
        for (let j = 0; j < 8; j++) {
          const to = s + D[j], q = bd[to];
          if (q === 0 ? quiet : q !== OFF && (q & BLACK) === them) MOVES[n++] = s | to << 7;
        }
        if (t === K && quiet) {
          if (side === 0 && s === 95) {
            if ((castle & 1) && !bd[96] && !bd[97] && bd[98] === R && !attacked(95, 1) && !attacked(96, 1) && !attacked(97, 1)) MOVES[n++] = 95 | 97 << 7 | 2 << 17;
            if ((castle & 2) && !bd[94] && !bd[93] && !bd[92] && bd[91] === R && !attacked(95, 1) && !attacked(94, 1) && !attacked(93, 1)) MOVES[n++] = 95 | 93 << 7 | 2 << 17;
          } else if (side === 1 && s === 25) {
            if ((castle & 4) && !bd[26] && !bd[27] && bd[28] === (R | BLACK) && !attacked(25, 0) && !attacked(26, 0) && !attacked(27, 0)) MOVES[n++] = 25 | 27 << 7 | 2 << 17;
            if ((castle & 8) && !bd[24] && !bd[23] && !bd[22] && bd[21] === (R | BLACK) && !attacked(25, 0) && !attacked(24, 0) && !attacked(23, 0)) MOVES[n++] = 25 | 23 << 7 | 2 << 17;
          }
        }
      } else {
        const D = t === B ? DIAG : t === R ? ORTH : KG;
        for (let j = 0; j < D.length; j++) {
          const d = D[j];
          let to = s + d, q;
          while ((q = bd[to]) === 0) { if (quiet) MOVES[n++] = s | to << 7; to += d; }
          if (q !== OFF && (q & BLACK) === them) MOVES[n++] = s | to << 7;
        }
      }
    }
    return n;
  }

  // play a pseudo-legal move; false (and nothing changed) if it leaves the mover's king in check
  function make(m) {
    const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flag = m >> 17;
    U_CASTLE[hp] = castle; U_EP[hp] = ep; U_HALF[hp] = half;
    hl ^= ZCL[castle] ^ ZEL[ep]; hh ^= ZCH[castle] ^ ZEH[ep];
    let cap = 0;
    if (flag & 1) cap = take(side ? to - 10 : to + 10);
    else if (bd[to]) cap = take(to);
    U_CAP[hp] = cap;
    const p = take(from);
    put(to, promo ? promo | (side << 3) : p);
    if (flag & 2) {
      if (to === 97) put(96, take(98)); else if (to === 93) put(94, take(91));
      else if (to === 27) put(26, take(28)); else put(24, take(21));
    }
    if ((p & 7) === K) king[side] = to;
    castle &= CMASK[from] & CMASK[to];
    ep = flag & 4 ? (from + to) >> 1 : 0;
    half = cap || (p & 7) === P ? 0 : half + 1;
    hl ^= ZCL[castle] ^ ZEL[ep] ^ ZSL; hh ^= ZCH[castle] ^ ZEH[ep] ^ ZSH;
    side ^= 1; hp++; HL[hp] = hl; HH[hp] = hh;
    if (attacked(king[side ^ 1], side)) { unmake(m); return false; }
    return true;
  }
  function unmake(m) {
    const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flag = m >> 17;
    hp--; side ^= 1;
    hl ^= ZCL[castle] ^ ZEL[ep] ^ ZSL; hh ^= ZCH[castle] ^ ZEH[ep] ^ ZSH;
    if (flag & 2) {
      if (to === 97) put(98, take(96)); else if (to === 93) put(91, take(94));
      else if (to === 27) put(28, take(26)); else put(21, take(24));
    }
    const p = take(to);
    put(from, promo ? P | (side << 3) : p);
    if ((p & 7) === K) king[side] = from;
    const cap = U_CAP[hp];
    if (cap) put(flag & 1 ? (side ? to - 10 : to + 10) : to, cap);
    castle = U_CASTLE[hp]; ep = U_EP[hp]; half = U_HALF[hp];
    hl ^= ZCL[castle] ^ ZEL[ep]; hh ^= ZCH[castle] ^ ZEH[ep];
  }
  function makeNull() {
    U_EP[hp] = ep; U_HALF[hp] = half;
    hl ^= ZEL[ep] ^ ZSL; hh ^= ZEH[ep] ^ ZSH;
    ep = 0; half = 0;                 // a null move ends the repetition window
    side ^= 1; hp++; HL[hp] = hl; HH[hp] = hh;
  }
  function unmakeNull() {
    hp--; side ^= 1;
    ep = U_EP[hp]; half = U_HALF[hp];
    hl ^= ZEL[ep] ^ ZSL; hh ^= ZEH[ep] ^ ZSH;
  }
  function repeated() {
    for (let k = hp - 2, stop = Math.max(0, hp - half); k >= stop; k -= 2) if (HL[k] === hl && HH[k] === hh) return true;
    return false;
  }

  // ---------- evaluation, from the side to move's point of view ----------
  const minB = new Int8Array(10), maxW = new Int8Array(10), pawnsW = new Int8Array(10), pawnsB = new Int8Array(10);
  function evaluate() {
    const wMinor = count[N] + count[B], bMinor = count[N | BLACK] + count[B | BLACK];
    const wHeavy = count[R] + count[Q], bHeavy = count[R | BLACK] + count[Q | BLACK];
    const wp = count[P], bp = count[P | BLACK];
    if (!wp && !bp && !wHeavy && !bHeavy && wMinor <= 1 && bMinor <= 1) return 0;   // K, K+minor vs K(+minor): no mate
    let m = mg, e = eg;
    // pawn structure: pawns per file, and per file the row of the most advanced enemy pawn (for passed pawns)
    minB.fill(9); maxW.fill(0); pawnsW.fill(0); pawnsB.fill(0);
    for (let i = 0; i < 64; i++) {
      const s = SQ[i], p = bd[s];
      if (p === P) { const f = (s % 10); pawnsW[f]++; const r = s / 10 | 0; if (r > maxW[f]) maxW[f] = r; }
      else if (p === (P | BLACK)) { const f = (s % 10); pawnsB[f]++; const r = s / 10 | 0; if (r < minB[f]) minB[f] = r; }
    }
    for (let i = 0; i < 64; i++) {
      const s = SQ[i], p = bd[s];
      if (!p) continue;
      const f = s % 10, r = s / 10 | 0;   // rows 2 (rank 8) .. 9 (rank 1)
      if (p === P) {
        if (!pawnsW[f - 1] && !pawnsW[f + 1]) { m -= 8; e -= 12; }
        if (minB[f - 1] >= r && minB[f] >= r && minB[f + 1] >= r) { m += PASS_MG[9 - r]; e += PASS_EG[9 - r]; }   // passed
      } else if (p === (P | BLACK)) {
        if (!pawnsB[f - 1] && !pawnsB[f + 1]) { m += 8; e += 12; }
        if (maxW[f - 1] <= r && maxW[f] <= r && maxW[f + 1] <= r) { m -= PASS_MG[r - 2]; e -= PASS_EG[r - 2]; }
      } else {
        const t = p & 7;
        if (t === K) continue;
        const sg = p & BLACK ? -1 : 1;
        if (t === R) {
          const mine = sg > 0 ? pawnsW[f] : pawnsB[f], theirs = sg > 0 ? pawnsB[f] : pawnsW[f];
          if (!mine) { if (!theirs) { m += sg * 25; e += sg * 10; } else { m += sg * 12; e += sg * 5; } }
        }
        // mobility: squares the piece reaches that are empty or hold an enemy piece
        let mob = 0;
        if (t === N) { for (let j = 0; j < 8; j++) { const q = bd[s + KN[j]]; if (q === 0 || (q !== OFF && (q & BLACK) !== (p & BLACK))) mob++; } }
        else {
          const D = t === B ? DIAG : t === R ? ORTH : KG;
          for (let j = 0; j < D.length; j++) {
            let to = s + D[j], q;
            while ((q = bd[to]) === 0) { mob++; to += D[j]; }
            if (q !== OFF && (q & BLACK) !== (p & BLACK)) mob++;
          }
        }
        m += sg * MOB_MG[t] * (mob - MOB_AVG[t]); e += sg * MOB_EG[t] * (mob - MOB_AVG[t]);
      }
    }
    for (let f = 1; f <= 8; f++) {
      if (pawnsW[f] > 1) { m -= 10 * (pawnsW[f] - 1); e -= 20 * (pawnsW[f] - 1); }
      if (pawnsB[f] > 1) { m += 10 * (pawnsB[f] - 1); e += 20 * (pawnsB[f] - 1); }
    }
    if (count[B] >= 2) { m += 30; e += 50; }
    if (count[B | BLACK] >= 2) { m -= 30; e -= 50; }
    const ph = phase > 24 ? 24 : phase;
    let s = (m * ph + e * (24 - ph)) / 24;
    // endgame knowledge: without pawns, a small material edge rarely wins; with a big one, drive the king to the edge
    const wMat = count[N] * 300 + count[B] * 300 + count[R] * 500 + count[Q] * 900;
    const bMat = count[N | BLACK] * 300 + count[B | BLACK] * 300 + count[R | BLACK] * 500 + count[Q | BLACK] * 900;
    const strong = s > 0 ? 0 : 1, sMat = strong ? bMat : wMat, wMatL = strong ? wMat : bMat, sPawns = strong ? bp : wp, lPawns = strong ? wp : bp;
    const onlyKnights = strong ? (count[N | BLACK] === 2 && bMat === 600) : (count[N] === 2 && wMat === 600);
    if (!sPawns && (sMat - wMatL < 400 || onlyKnights)) s /= 8;
    else if (!lPawns && sMat - wMatL >= 400 && ph <= 8) {
      const lk = king[strong ^ 1], sk = king[strong];
      const lr = (lk / 10 | 0) - 2, lf = lk % 10 - 1, sr = (sk / 10 | 0) - 2, sf = sk % 10 - 1;
      const edge = Math.max(3 - lr, lr - 4) + Math.max(3 - lf, lf - 4), dist = Math.abs(lr - sr) + Math.abs(lf - sf);
      s += (strong ? -1 : 1) * (edge * 20 + (14 - dist) * 8);
    }
    s = s | 0;
    return (side ? -s : s) + 10;      // + a small bonus for having the move
  }

  // ---------- search ----------
  const TT_BITS = 18, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
  const TTK = new Int32Array(TT_SIZE), TTM = new Int32Array(TT_SIZE), TTS = new Int32Array(TT_SIZE), TTD = new Int8Array(TT_SIZE), TTF = new Int8Array(TT_SIZE);
  const EXACT = 1, LOWER = 2, UPPER = 3;
  const KILL = new Int32Array(MAXPLY * 2), HIST = new Int32Array(16 * 120);
  const VICTIM = [0, 100, 300, 320, 500, 900, 0];
  let nodes = 0, deadline = Infinity;

  const ttScore = (s, ply) => (s > MATED ? s + ply : s < -MATED ? s - ply : s);
  const ttRead = (s, ply) => (s > MATED ? s - ply : s < -MATED ? s + ply : s);
  function ttStore(depth, flag, score, move, ply) {
    const i = hl & TT_MASK;
    if (TTK[i] === hh && TTD[i] > depth && TTF[i] === EXACT && flag !== EXACT) return;   // keep a deeper exact result
    TTK[i] = hh; TTM[i] = move; TTS[i] = ttScore(score, ply); TTD[i] = depth; TTF[i] = flag;
  }

  function scoreMoves(a, n, ttMove, ply) {
    const k1 = KILL[ply * 2], k2 = KILL[ply * 2 + 1];
    for (let i = a; i < n; i++) {
      const m = MOVES[i], to = (m >> 7) & 127, promo = (m >> 14) & 7, v = bd[to] & 7;
      let s;
      if (m === ttMove) s = 1 << 30;
      else if (v || (m >> 17) & 1) s = (1 << 29) + VICTIM[v || P] * 16 - (bd[m & 127] & 7);
      else if (promo) s = (1 << 29) - 1000 + promo;
      else if (m === k1) s = (1 << 28) + 1;
      else if (m === k2) s = 1 << 28;
      else s = HIST[bd[m & 127] * 120 + to];
      SCORES[i] = s;
    }
  }
  function pick(i, n) {   // bring the best-scored remaining move to index i
    let b = i;
    for (let j = i + 1; j < n; j++) if (SCORES[j] > SCORES[b]) b = j;
    if (b !== i) { const m = MOVES[i], s = SCORES[i]; MOVES[i] = MOVES[b]; SCORES[i] = SCORES[b]; MOVES[b] = m; SCORES[b] = s; }
    return MOVES[i];
  }
  const nonPawn = (c) => count[N | c] + count[B | c] + count[R | c] + count[Q | c] > 0;

  function quiesce(alpha, beta, ply) {
    if ((++nodes & 1023) === 0 && now() > deadline) throw STOP;
    if (ply >= MAXPLY - 1) return evaluate();
    const check = inCheck();
    let best = -INF, stand = 0;
    if (!check) {
      stand = evaluate();
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
      best = stand;
    }
    const a = ply * 256, n = gen(a, check);
    scoreMoves(a, n, 0, ply);
    let legal = 0;
    for (let i = a; i < n; i++) {
      const m = pick(i, n);
      if (!check && !((m >> 14) & 7)) {          // delta pruning: even winning this piece can't lift the score to alpha
        const v = (m >> 17) & 1 ? 100 : VICTIM[bd[(m >> 7) & 127] & 7];
        if (stand + v + 200 <= alpha) continue;
        // a capture by a more valuable piece onto a defended square usually just loses material
        if (VICTIM[bd[m & 127] & 7] > v + 50 && attacked((m >> 7) & 127, side ^ 1)) continue;
      }
      if (!make(m)) continue;
      legal++;
      const sc = -quiesce(-beta, -alpha, ply + 1);
      unmake(m);
      if (sc > best) { best = sc; if (sc > alpha) { alpha = sc; if (sc >= beta) break; } }
    }
    if (check && !legal) return -MATE + ply;
    return best;
  }

  function search(depth, alpha, beta, ply, nullOk) {
    if ((++nodes & 1023) === 0 && now() > deadline) throw STOP;
    if (half >= 100 || repeated()) return 0;
    if (ply >= MAXPLY - 1) return evaluate();
    const check = inCheck();
    if (check) depth++;                              // never stop the search in the middle of a check
    if (depth <= 0) return quiesce(alpha, beta, ply);
    // mate distance: no line from here can beat a mate already found nearer the root
    alpha = Math.max(alpha, -MATE + ply); beta = Math.min(beta, MATE - ply - 1);
    if (alpha >= beta) return alpha;
    const pv = beta - alpha > 1;
    const ti = hl & TT_MASK;
    let ttMove = 0;
    if (TTK[ti] === hh) {
      ttMove = TTM[ti];
      if (!pv && TTD[ti] >= depth) {
        const s = ttRead(TTS[ti], ply), f = TTF[ti];
        if (f === EXACT || (f === LOWER && s >= beta) || (f === UPPER && s <= alpha)) return s;
      }
    }
    let futile = false;
    if (!pv && !check) {
      const ev = evaluate();
      futile = depth <= 2 && ev + 150 * depth <= alpha;   // quiet moves can't catch up: only captures, promotions, checks
      if (depth <= 3 && ev - 110 * depth >= beta && Math.abs(beta) < MATED) return ev;   // far above beta: assume it holds
      if (nullOk && depth >= 3 && ev >= beta && nonPawn(side << 3)) {
        makeNull();
        const sc = -search(depth - 3 - (depth >= 7 ? 1 : 0), -beta, -beta + 1, ply + 1, false);
        unmakeNull();
        if (sc >= beta) return sc > MATED ? beta : sc;
      }
    }
    const a = ply * 256, n = gen(a, true);
    scoreMoves(a, n, ttMove, ply);
    const alpha0 = alpha;
    let best = -INF, bestMove = 0, legal = 0;
    for (let i = a; i < n; i++) {
      const m = pick(i, n);
      const quiet = !bd[(m >> 7) & 127] && !(m >> 14 & 7) && !((m >> 17) & 1);
      if (!make(m)) continue;
      legal++;
      if (futile && quiet && legal > 1 && !inCheck()) { unmake(m); continue; }
      let sc;
      if (legal === 1) sc = -search(depth - 1, -beta, -alpha, ply + 1, true);
      else {
        let red = 0;
        if (depth >= 3 && legal > 3 && quiet && !check && SCORES[i] < (1 << 28) && !inCheck()) red = legal > 10 && depth >= 5 ? 2 : 1;
        sc = -search(depth - 1 - red, -alpha - 1, -alpha, ply + 1, true);
        if (sc > alpha && red) sc = -search(depth - 1, -alpha - 1, -alpha, ply + 1, true);
        if (sc > alpha && sc < beta) sc = -search(depth - 1, -beta, -alpha, ply + 1, true);
      }
      unmake(m);
      if (sc > best) {
        best = sc; bestMove = m;
        if (sc > alpha) {
          alpha = sc;
          if (sc >= beta) {
            if (quiet) {
              if (KILL[ply * 2] !== m) { KILL[ply * 2 + 1] = KILL[ply * 2]; KILL[ply * 2] = m; }
              const h = bd[m & 127] * 120 + ((m >> 7) & 127);
              HIST[h] = Math.min(HIST[h] + depth * depth, 1 << 26);
            }
            break;
          }
        }
      }
    }
    if (!legal) return check ? -MATE + ply : 0;
    ttStore(depth, best >= beta ? LOWER : best > alpha0 ? EXACT : UPPER, best, bestMove, ply);
    return best;
  }

  // legal moves at the root, in chess.js format, paired with the internal encoding
  function rootMoves(st) {
    const legal = Chess.legalMoves(st), out = [];
    const n = gen(0, true);
    for (let i = 0; i < n; i++) {
      const m = MOVES[i];
      const from = to64(m & 127), to = to64((m >> 7) & 127), promo = (m >> 14) & 7;
      const cm = legal.find((x) => x.from === from && x.to === to && (x.promo ? CODE[x.promo] : 0) === promo);
      if (cm) out.push({ im: m, m: cm });
    }
    return out;
  }
  const same = (a, b) => a.from === b.from && a.to === b.to && (a.promo || undefined) === (b.promo || undefined);

  // Score the root moves of a position with iterative deepening until the time is up (depth 1 always completes).
  // opts.exact (default true): every move's score is exact. With exact = false only the best two moves and the
  //   opts.focus moves (e.g. the move that was played) get exact scores; the others are upper bounds, which makes
  //   the search much deeper in the same time. opts.history: earlier positions of the game (repetitions are draws).
  // Returns { best, score, scores: [{ m, s }] (best first), depth, legal, layers: [scores after each depth] }.
  function analyze(st, ms, maxDepth = 24, opts = {}, t0 = now()) {
    const exact = opts.exact !== false, focus = opts.focus || [];
    const back = Math.min(st.half || 0, 900), prev = opts.history || [];
    const hist = back ? prev.slice(-back).map((h) => { load(h); return [hl, hh]; }) : [];
    load(st);
    for (let i = 0; i < hist.length; i++) { HL[i] = hist[i][0]; HH[i] = hist[i][1]; }
    hp = hist.length; HL[hp] = hl; HH[hp] = hh;
    const rootHp = hp;
    const list = rootMoves(st);
    if (!list.length) return { terminal: true, best: null, scores: [], depth: 0, score: Chess.inCheck(st, st.turn) ? -MATE : 0, legal: 0, layers: [] };
    for (let i = 0; i < HIST.length; i++) HIST[i] >>= 2;
    KILL.fill(0);
    // first guess at the order: captures and promotions first
    for (const x of list) { x.f = focus.some((f) => same(f, x.m)); const v = bd[(x.im >> 7) & 127] & 7; x.s = v ? VICTIM[v] * 16 - (bd[x.im & 127] & 7) : (x.im >> 14) & 7 ? 1000 : 0; }
    list.sort((a, b) => b.s - a.s);
    let done = null, depth = 0;
    const layers = [];
    for (let d = 1; d <= maxDepth; d++) {
      nodes = 0;
      deadline = d === 1 ? Infinity : t0 + ms;
      const res = [];
      try {
        let b1 = -INF, b2 = -INF;
        for (let k = 0; k < list.length; k++) {
          const x = list[k];
          make(x.im);
          let sc, ex = true;
          if (exact || x.f || k < 2) sc = -search(d - 1, -INF, INF, 1, true);
          else {
            // only needs an exact score if it beats the second best so far
            sc = -search(d - 1, -b2 - 1, -b2, 1, true);
            if (sc > b2) sc = -search(d - 1, -INF, -b2, 1, true);
            if (sc <= b2) ex = false;
          }
          unmake(x.im);
          if (hp !== rootHp) throw new Error('engine: board out of sync');
          res.push({ x, s: sc, ex });
          if (sc > b1) { b2 = b1; b1 = sc; } else if (sc > b2) b2 = sc;
        }
      } catch (e) { if (e !== STOP) throw e; break; }
      res.sort((a, b) => b.s - a.s || (b.ex - a.ex));
      done = res; depth = d;
      layers.push(res.map((r) => ({ m: r.x.m, s: r.s })));
      list.length = 0; list.push(...res.map((r) => r.x));     // the next depth searches the best moves first
      if (Math.abs(res[0].s) > MATED) break;                   // forced mate found
      if (now() > t0 + ms) break;
    }
    return { best: done[0].x.m, score: done[0].s, scores: done.map((r) => ({ m: r.x.m, s: r.s, exact: r.ex })), depth, legal: done.length, layers, nodes };
  }

  // node count of the move tree (tests the move generator against chess.js)
  function perft(st, depth) {
    load(st);
    const run = (d, ply) => {
      if (!d) return 1;
      const a = ply * 256, n = gen(a, true);
      let c = 0;
      for (let i = a; i < n; i++) { const m = MOVES[i]; if (!make(m)) continue; c += run(d - 1, ply + 1); unmake(m); }
      return c;
    };
    return run(depth, 0);
  }
  function evalOf(st) { load(st); return evaluate(); }
  function hashOf(st) { load(st); return [hl, hh]; }
  function clear() { TTK.fill(0); TTM.fill(0); HIST.fill(0); }

  return { analyze, perft, evaluate: evalOf, hashOf, clear, MATE, LETTER };
});
