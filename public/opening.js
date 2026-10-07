// Opening recognition shared by browser and server, over the Lichess opening list in openings.js.
// Positions are matched, not move orders, so transpositions are recognised. The name of a game is that of the
// deepest book position it reached; it stays once the game leaves theory, like "Sicilian Defense: Najdorf Variation".
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./chess.js'));
  else root.Opening = factory(root.Chess);
})(typeof self !== 'undefined' ? self : this, function (Chess) {
  let map = null, depth = 0;
  const key = (st) => st.board.map((p) => p || '-').join('') + st.turn + (st.castle.wK ? 'K' : '') + (st.castle.wQ ? 'Q' : '') + (st.castle.bK ? 'k' : '') + (st.castle.bQ ? 'q' : '');

  function applyUci(st, u) {   // book moves are known to be legal, so skip move generation
    const sq = (q) => 'abcdefgh'.indexOf(q[0]) + (8 - +q[1]) * 8;
    const from = sq(u.slice(0, 2)), to = sq(u.slice(2, 4)), pc = st.board[from][1], df = (to & 7) - (from & 7);
    return Chess.apply(st, { from, to, promo: u[4] ? u[4].toUpperCase() : undefined,
      castle: pc === 'K' && Math.abs(df) === 2 ? (df > 0 ? 'K' : 'Q') : undefined,
      double: pc === 'P' && Math.abs((to >> 3) - (from >> 3)) === 2 || undefined,
      enPassant: pc === 'P' && df !== 0 && !st.board[to] || undefined });
  }

  // position key -> { eco, name, moves }, built once from the TSV (null until the list is loaded)
  function index(tsv) {
    if (map || !tsv) return map;
    const m = new Map(), seen = new Map();
    for (const line of tsv.split('\n')) {
      const [eco, name, ucis] = line.split('\t'), moves = ucis.split(' ');
      let st = Chess.initial(), pre = '';
      for (const u of moves) { pre += u + ' '; let nx = seen.get(pre); if (!nx) seen.set(pre, nx = applyUci(st, u)); st = nx; }
      const k = key(st);
      if (!m.has(k)) m.set(k, { eco, name, moves });
      depth = Math.max(depth, moves.length);
    }
    return (map = m);
  }

  // deepest named position among states[1..upto] -> { eco, name, moves, ply } or null
  function at(states, upto) {
    if (!map) return null;
    for (let i = Math.min(upto, depth); i >= 1; i--) {
      const st = states[i];
      if (st._op === undefined) st._op = map.get(key(st)) || null;
      if (st._op) return { ...st._op, ply: i };
    }
    return null;
  }

  // the opening of a whole game, from its moves ([{from, to, promo}])
  function ofGame(hist, tsv) {
    if (!index(tsv)) return null;
    const states = [Chess.initial()];
    for (const h of hist.slice(0, depth)) {
      const st = states[states.length - 1];
      const m = Chess.legalMoves(st).find((x) => x.from === h.from && x.to === h.to && (x.promo || undefined) === (h.promo || undefined));
      if (!m) break;
      states.push(Chess.apply(st, m));
    }
    return at(states, states.length - 1);
  }

  return { key, index, at, ofGame };
});
