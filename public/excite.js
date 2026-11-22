// LIVE TUNE-IN and REELS share this: how exciting is a game right now, and what just happened in it?
// Pure and deterministic, shared by browser and server like chess.js. The browser runs Stockfish (sfengine.js) and sends
// only evaluations; the server checks them and runs THIS code itself, so no browser can submit a score or a claim.
// ev[i] = Stockfish's evaluation of the position after i plies, in centipawns from WHITE's side (mates: +-(100000 - plies)),
// or null where nothing has been analysed. Nothing here invents an evaluation: no evaluations, no engine-based signal.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./chess.js'));
  else root.Excite = factory(root.Chess);
})(typeof self !== 'undefined' ? self : this, function (Chess) {
  const MATE = 100000, MATED = MATE - 1000;
  const VAL = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 }, NAME = { P: 'PAWN', N: 'KNIGHT', B: 'BISHOP', R: 'ROOK', Q: 'QUEEN', K: 'KING' };
  const WINDOW = 8;                       // plies that count as "what is happening now"
  const isMate = (cp) => cp != null && Math.abs(cp) >= MATED;
  // win probability for White (the lichess curve); a mate is certain
  const wp = (cp) => (cp == null ? null : cp >= MATED ? 1 : cp <= -MATED ? 0 : 1 / (1 + Math.exp(-0.00368208 * cp)));
  const side = (c, x) => (x == null ? null : c === 'w' ? x : 1 - x);         // White's win probability -> c's

  // the game, move by move: material, checks, captures (from the moves alone, no engine)
  function replay(hist) {
    let st = Chess.initial();
    const plies = [], mat = [{ w: 39, b: 39 }];
    for (const h of hist || []) {
      const m = Chess.legalMoves(st).find((x) => x.from === h.from && x.to === h.to && (x.promo || null) === (h.promo || null));
      if (!m) return null;                                                    // not a legal game: nothing to say about it
      const color = st.turn, piece = st.board[m.from][1], cap = st.board[m.to] ? st.board[m.to][1] : m.enPassant ? 'P' : null;
      const ns = Chess.apply(st, m), prev = mat[mat.length - 1], next = { ...prev };
      if (cap) next[color === 'w' ? 'b' : 'w'] -= VAL[cap];
      if (m.promo) next[color] += VAL[m.promo] - 1;
      const over = Chess.status(ns);
      plies.push({ color, piece, from: m.from, to: m.to, cap, check: Chess.inCheck(ns, ns.turn), mate: over.over && over.result === color, san: Chess.notate(st, m) });
      mat.push(next); st = ns;
    }
    return { plies, mat, final: st };
  }

  // A sacrifice at ply i (1-based: the i-th move): the mover is down at least 2 points of material after the reply (or
  // the piece is left hanging) and the engine still likes the position for them (no worse than before the move).
  function sacAt(rep, ev, i) {
    const p = rep.plies[i - 1]; if (!p || ev[i - 1] == null) return null;
    // judged after the reply AND the mover's next move (a recapture is a trade, not a sacrifice); a game that ended sooner counts as it stands
    const last = rep.plies.length, settle = Math.min(i + 2, last);
    if (settle < i + 2 && !(rep.plies[last - 1] && rep.plies[last - 1].mate)) return null;
    const after = [settle, i + 1, i].find((k) => k <= last && ev[k] != null); if (after == null) return null;
    const m0 = rep.mat[i - 1], m1 = rep.mat[settle], c = p.color, o = c === 'w' ? 'b' : 'w';
    const lost = (m0[c] - m0[o]) - (m1[c] - m1[o]);
    if (lost < 2) return null;
    const before = side(c, wp(ev[i - 1])), now = side(c, wp(ev[after]));
    if (now < before - 0.03 || now < 0.45) return null;                      // a real sacrifice keeps (or improves) the game
    const reply = rep.plies[i];
    const gone = reply && reply.cap && reply.cap !== 'P' ? reply.cap : p.piece;  // the piece that was given up: what the opponent took next (5.Nxe5!! Bxd1: the queen)
    return { ply: i, side: c, piece: gone, name: NAME[gone], lost, san: p.san };
  }

  // Everything notable that can be said about the game so far, from verified facts only.
  // ctx: { clocks: { w, b } ms left (or null), tc, ratings: { w, b }, viewers, streaks: { w, b } current win streaks }
  function analyse(hist, ev, ctx = {}) {
    const rep = replay(hist); if (!rep) return null;
    const n = rep.plies.length, events = [], reasons = [];
    const W = (i) => wp(ev[i]);
    const add = (k, pts, text, extra = {}) => reasons.push({ k, pts, text, ...extra });
    const lo = Math.max(1, n - WINDOW + 1);
    // 1. evaluation swings and blunders (needs engine evaluations on both sides of the move)
    let swing = 0, swingAt = null;
    for (let i = lo; i <= n; i++) {
      if (W(i) == null || W(i - 1) == null) continue;
      const d = Math.abs(W(i) - W(i - 1));
      if (d > swing) { swing = d; swingAt = i; }
      const mover = rep.plies[i - 1].color, drop = side(mover, W(i - 1)) - side(mover, W(i));
      if (drop >= 0.3 && !isMate(ev[i - 1])) events.push({ type: 'blunder', ply: i, side: mover, san: rep.plies[i - 1].san, size: drop });
    }
    if (swing >= 0.2) add('swing', Math.round(10 + swing * 40), 'THIS GAME IS GETTING OUT OF HAND.', { ply: swingAt });
    // 2. comebacks: a side that was clearly lost (<= 15%) is now level or better
    for (const c of ['w', 'b']) {
      let worst = 1, worstAt = null;
      for (let i = 0; i <= n; i++) { const x = side(c, W(i)); if (x != null && x < worst) { worst = x; worstAt = i; } }
      const now = side(c, W(n) != null ? W(n) : W(n - 1));
      if (worst <= 0.15 && now != null && now >= 0.5 && worstAt < n) {
        add('comeback', 30, 'MASSIVE COMEBACK. THE POSITION HAS COMPLETELY TURNED.', { side: c });
        const turn = (() => { for (let i = worstAt + 1; i <= n; i++) if (side(c, W(i)) != null && side(c, W(i)) >= 0.5) return i; return n; })();
        events.push({ type: 'comeback', ply: turn, side: c, from: ev[worstAt] });
      }
    }
    // 3. sacrifices in the window
    for (let i = lo; i <= n; i++) { const s = sacAt(rep, ev, i); if (s) { events.push({ type: 'sac', ...s }); add('sac', 28, `A ${s.name} SACRIFICE JUST CHANGED EVERYTHING.`, { ply: i }); } }
    // 4. forced mate on the board, king attacks, tactics
    const cur = ev[n] != null ? ev[n] : null;
    if (isMate(cur) && !rep.plies[n - 1]?.mate) { add('mate', 22, 'THERE IS A FORCED MATE ON THE BOARD.'); events.push({ type: 'mate', ply: n, side: cur > 0 ? 'w' : 'b', in: Math.ceil((MATE - Math.abs(cur)) / 2) }); }
    const recent = rep.plies.slice(lo - 1);
    for (const c of ['w', 'b']) {
      const checks = recent.filter((p) => p.color === c && p.check).length;
      if (checks >= 2) { add('attack', 12 + 3 * Math.min(checks, 4), 'A DANGEROUS KING ATTACK IS DEVELOPING.', { side: c }); break; }
    }
    const sharp = recent.filter((p) => p.cap || p.check).length;
    if (sharp >= 4) add('tactics', 8 + 2 * Math.min(sharp, 6), 'PIECES ARE FLYING.');
    // 5. close and competitive, late in the game
    if (cur != null && !isMate(cur) && Math.abs(cur) <= 120 && n >= 30) add('close', 12, 'DEAD LEVEL, DEEP INTO THE GAME.');
    // 6. time scramble (clocks are the server's own)
    const cl = ctx.clocks;
    if (ctx.tc && cl && cl.w != null && cl.b != null) {
      const s = Math.ceil(Math.max(cl.w, cl.b) / 1000), lowS = Math.ceil(Math.min(cl.w, cl.b) / 1000);
      if (s <= 30) { add('scramble', 24 + (s <= 15 ? 6 : 0), `TWO PLAYERS. ${s} SECONDS. ONE WINNER.`); events.push({ type: 'scramble', ply: n, secs: s }); }
      else if (lowS <= 15 && n >= 20) add('scramble', 12, `${lowS} SECONDS ON THE CLOCK. EVERY MOVE COUNTS.`);
    }
    // 7. a significant streak under threat (engine-confirmed disadvantage for the streak holder)
    const st = ctx.streaks || {};
    for (const c of ['w', 'b']) if ((st[c] || 0) >= 5 && cur != null && side(c, wp(cur)) <= 0.25) { add('streak', 20, `A ${st[c]}-GAME WIN STREAK IS UNDER THREAT.`, { side: c, len: st[c] }); events.push({ type: 'streak', ply: n, side: c, len: st[c] }); }
    // 8. secondary: strong players, people watching (never enough on their own)
    const r = ctx.ratings || {}, avg = r.w && r.b ? (r.w + r.b) / 2 : 0;
    if (avg > 1300) add('rating', Math.min(5, Math.round((avg - 1300) / 100)), '');
    if (ctx.viewers) add('viewers', Math.min(5, ctx.viewers), '');
    const engine = ev.some((x, i) => i > 0 && x != null);
    const raw = Math.min(100, reasons.reduce((s, x) => s + x.pts, 0));
    const top = reasons.filter((x) => x.text).sort((a, b) => b.pts - a.pts)[0] || null;
    return { raw, engine, top: top ? { k: top.k, text: top.text } : null, reasons: reasons.map((x) => x.k), events, n };
  }

  // Smoothing and hysteresis: a single spike can't throw a game to the top, and a game doesn't flicker in and out.
  const ENTER = 40, LEAVE = 28;
  function smooth(prev, raw) {
    const s = prev && Number.isFinite(prev.s) ? prev.s * 0.7 + raw * 0.3 : raw * 0.4;
    const sus = prev && Number.isFinite(prev.sus) ? prev.sus * 0.85 + s * 0.15 : s * 0.3;      // the slow average: MATCH OF THE MOMENT
    const hot = prev && prev.hot ? s >= LEAVE : s >= ENTER;
    return { s: Math.round(s * 10) / 10, sus: Math.round(sus * 10) / 10, hot };
  }

  return { MATE, MATED, VAL, NAME, wp, isMate, replay, sacAt, analyse, smooth, ENTER, LEAVE };
});
