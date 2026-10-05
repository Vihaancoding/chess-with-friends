// Chess engine shared by server (authoritative) and browser (move hints).
// Board: array of 64, index = row*8 + col, row 0 = rank 8. Piece = 'wP','bN',...
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Chess = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const BACK = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
  const KN = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  const KG = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  const DIAG = [[-1,-1],[-1,1],[1,-1],[1,1]];
  const ORTH = [[-1,0],[1,0],[0,-1],[0,1]];

  function initial() {
    const board = new Array(64).fill(null);
    for (let c = 0; c < 8; c++) {
      board[c] = 'b' + BACK[c];
      board[8 + c] = 'bP';
      board[48 + c] = 'wP';
      board[56 + c] = 'w' + BACK[c];
    }
    return { board, turn: 'w', castle: { wK: true, wQ: true, bK: true, bQ: true }, ep: null, half: 0, full: 1 };
  }

  const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

  function isAttacked(board, sq, by) {
    const r = sq >> 3, c = sq & 7;
    const pr = by === 'w' ? r + 1 : r - 1; // row a pawn of `by` would sit on
    for (const dc of [-1, 1]) if (inB(pr, c + dc) && board[pr * 8 + c + dc] === by + 'P') return true;
    for (const [dr, dc] of KN) if (inB(r + dr, c + dc) && board[(r + dr) * 8 + c + dc] === by + 'N') return true;
    for (const [dr, dc] of KG) if (inB(r + dr, c + dc) && board[(r + dr) * 8 + c + dc] === by + 'K') return true;
    for (const [dirs, kinds] of [[DIAG, 'BQ'], [ORTH, 'RQ']]) {
      for (const [dr, dc] of dirs) {
        let rr = r + dr, cc = c + dc;
        while (inB(rr, cc)) {
          const p = board[rr * 8 + cc];
          if (p) { if (p[0] === by && kinds.includes(p[1])) return true; break; }
          rr += dr; cc += dc;
        }
      }
    }
    return false;
  }

  function inCheck(state, color) {
    const k = state.board.indexOf(color + 'K');
    return k >= 0 && isAttacked(state.board, k, color === 'w' ? 'b' : 'w');
  }

  function pseudoMoves(state) {
    const { board, turn, castle, ep } = state;
    const opp = turn === 'w' ? 'b' : 'w';
    const out = [];
    const add = (from, to, extra) => out.push(Object.assign({ from, to }, extra));
    for (let sq = 0; sq < 64; sq++) {
      const p = board[sq];
      if (!p || p[0] !== turn) continue;
      const r = sq >> 3, c = sq & 7, t = p[1];
      if (t === 'P') {
        const dir = turn === 'w' ? -1 : 1, start = turn === 'w' ? 6 : 1, last = turn === 'w' ? 0 : 7;
        const push = (to, extra) => {
          if ((to >> 3) === last) for (const promo of 'QRBN') add(sq, to, Object.assign({ promo }, extra));
          else add(sq, to, extra);
        };
        if (inB(r + dir, c) && !board[(r + dir) * 8 + c]) {
          push((r + dir) * 8 + c);
          if (r === start && !board[(r + 2 * dir) * 8 + c]) add(sq, (r + 2 * dir) * 8 + c, { double: true });
        }
        for (const dc of [-1, 1]) {
          if (!inB(r + dir, c + dc)) continue;
          const to = (r + dir) * 8 + c + dc;
          if (board[to] && board[to][0] === opp) push(to);
          else if (to === ep) add(sq, to, { enPassant: true });
        }
      } else if (t === 'N' || t === 'K') {
        for (const [dr, dc] of t === 'N' ? KN : KG) {
          if (!inB(r + dr, c + dc)) continue;
          const to = (r + dr) * 8 + c + dc;
          if (!board[to] || board[to][0] === opp) add(sq, to);
        }
        if (t === 'K') {
          const home = turn === 'w' ? 60 : 4;
          if (sq === home && !isAttacked(board, sq, opp)) {
            if (castle[turn + 'K'] && !board[home + 1] && !board[home + 2] && board[home + 3] === turn + 'R' &&
                !isAttacked(board, home + 1, opp) && !isAttacked(board, home + 2, opp))
              add(sq, home + 2, { castle: 'K' });
            if (castle[turn + 'Q'] && !board[home - 1] && !board[home - 2] && !board[home - 3] && board[home - 4] === turn + 'R' &&
                !isAttacked(board, home - 1, opp) && !isAttacked(board, home - 2, opp))
              add(sq, home - 2, { castle: 'Q' });
          }
        }
      } else {
        const dirs = t === 'B' ? DIAG : t === 'R' ? ORTH : DIAG.concat(ORTH);
        for (const [dr, dc] of dirs) {
          let rr = r + dr, cc = c + dc;
          while (inB(rr, cc)) {
            const to = rr * 8 + cc;
            if (!board[to]) add(sq, to);
            else { if (board[to][0] === opp) add(sq, to); break; }
            rr += dr; cc += dc;
          }
        }
      }
    }
    return out;
  }

  function apply(state, m) {
    const board = state.board.slice();
    const turn = state.turn, opp = turn === 'w' ? 'b' : 'w';
    const piece = board[m.from];
    const captured = board[m.to] || (m.enPassant ? board[m.to + (turn === 'w' ? 8 : -8)] : null);
    board[m.to] = m.promo ? turn + m.promo : piece;
    board[m.from] = null;
    if (m.enPassant) board[m.to + (turn === 'w' ? 8 : -8)] = null;
    if (m.castle === 'K') { board[m.to - 1] = board[m.to + 1]; board[m.to + 1] = null; }
    if (m.castle === 'Q') { board[m.to + 1] = board[m.to - 2]; board[m.to - 2] = null; }
    const castle = Object.assign({}, state.castle);
    if (piece[1] === 'K') { castle[turn + 'K'] = false; castle[turn + 'Q'] = false; }
    for (const [sq, key] of [[63, 'wK'], [56, 'wQ'], [7, 'bK'], [0, 'bQ']])
      if (m.from === sq || m.to === sq) castle[key] = false;
    return {
      board, turn: opp, castle,
      ep: m.double ? (m.from + m.to) / 2 : null,
      half: piece[1] === 'P' || captured ? 0 : state.half + 1,
      full: state.full + (turn === 'b' ? 1 : 0),
      _captured: captured,
    };
  }

  function legalMoves(state) {
    return pseudoMoves(state).filter((m) => !inCheck(apply(state, m), state.turn));
  }

  function insufficient(board) {
    const rest = board.filter((p) => p && p[1] !== 'K');
    if (rest.length === 0) return true;
    return rest.length === 1 && 'BN'.includes(rest[0][1]);
  }

  // returns { over, result: 'w'|'b'|'draw'|null, reason, check }
  function status(state) {
    const moves = legalMoves(state);
    const check = inCheck(state, state.turn);
    if (!moves.length) {
      return check
        ? { over: true, result: state.turn === 'w' ? 'b' : 'w', reason: 'checkmate', check }
        : { over: true, result: 'draw', reason: 'stalemate', check };
    }
    if (insufficient(state.board)) return { over: true, result: 'draw', reason: 'insufficient material', check };
    if (state.half >= 100) return { over: true, result: 'draw', reason: '50-move rule', check };
    return { over: false, result: null, reason: null, check };
  }

  const sqName = (i) => 'abcdefgh'[i & 7] + (8 - (i >> 3));

  // Long-ish algebraic for the move list, computed BEFORE applying m.
  function notate(state, m) {
    if (m.castle) return m.castle === 'K' ? 'O-O' : 'O-O-O';
    const p = state.board[m.from][1];
    const cap = state.board[m.to] || m.enPassant;
    let s = (p === 'P' ? (cap ? sqName(m.from)[0] : '') : p) + (cap ? 'x' : '') + sqName(m.to);
    if (m.promo) s += '=' + m.promo;
    const next = apply(state, m), st = status(next);
    return s + (st.reason === 'checkmate' ? '#' : st.check ? '+' : '');
  }

  // Position identity for threefold repetition (en passant counts only when it is actually legal).
  function key(state) {
    const c = state.castle;
    const ep = state.ep != null && legalMoves(state).some((m) => m.enPassant) ? state.ep : '';
    return state.board.map((p) => p || '--').join('') + state.turn + (c.wK ? 'K' : '') + (c.wQ ? 'Q' : '') + (c.bK ? 'k' : '') + (c.bQ ? 'q' : '') + ep;
  }

  return { initial, legalMoves, apply, status, inCheck, notate, sqName, key };
});
