// Play against a style: reads how someone plays from their archived games, and plays like them.
// Shared by the browser page, the engine worker (bot.js) and Node (tests). No engine search lives here: the
// caller passes engine scores in, and this file turns them into a profile, a move choice or a comparison.
//
//  - profile(name, games, analyze)  builds a playstyle profile: openings (and an opening book of the moves the
//    player actually chose), aggression, tactical vs positional play, risk, sacrifices, castling and other habits,
//    time management, and the mistakes they tend to make (how often, in which phase, of which kind).
//  - choose(state, scored, profile, opts)  picks a move like the player would: their book moves first, then the
//    engine's scores nudged by their style, with their own error rate (mistakes and blunders included).
//  - predict(...)  the single most likely move for the player in a position (no randomness).
//  - sideStats / similarity  measure one side of one game the same way as a profile, so the two can be compared.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./chess.js'));
  else root.Style = factory(root.Chess);
})(typeof self !== 'undefined' ? self : this, function (Chess) {
  const V = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };
  const BOOK_PLY = 16;                 // the opening book covers each side's first 8 moves
  const WP = (cp) => (cp > 90000 ? 1 : cp < -90000 ? 0 : 1 / (1 + Math.exp(-0.00368208 * cp)));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const S = (x, mid, w) => Math.round(100 / (1 + Math.exp(-(x - mid) / w)));     // a raw rate -> 0..100 scale
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const sq = (q) => 'abcdefgh'.indexOf(q[0]) + (8 - +q[1]) * 8;
  const uci = (m) => Chess.sqName(m.from) + Chess.sqName(m.to) + (m.promo ? m.promo.toLowerCase() : '');
  const same = (a, b) => a.from === b.from && a.to === b.to && (a.promo || undefined) === (b.promo || undefined);

  // short position id for the opening book (FNV-1a over board, side to move and castling rights)
  function bookKey(st) {
    const c = st.castle, s = st.board.map((p) => p || '-').join('') + st.turn + (c.wK ? 'K' : '') + (c.wQ ? 'Q' : '') + (c.bK ? 'k' : '') + (c.bQ ? 'q' : '');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  // opening / middlegame / endgame, from the move number and the pieces left (kings and pawns not counted)
  function phase(st, ply) {
    let npm = 0;
    for (const p of st.board) if (p && p[1] !== 'P' && p[1] !== 'K') npm += V[p[1]];
    if (npm <= 2600) return 'e';
    return ply < 20 && npm >= 5600 ? 'o' : 'm';
  }

  // Did the move give up material on purpose? (the moved piece can be taken by something cheaper; same rule as the game review)
  function isSac(st, m, after) {
    const piece = st.board[m.from][1];
    if (piece === 'P' || piece === 'K') return false;
    const got = st.board[m.to] ? V[st.board[m.to][1]] : 0;
    const takers = Chess.legalMoves(after).filter((x) => x.to === m.to).map((x) => V[after.board[x.from][1]]);
    return takers.length > 0 && Math.min(...takers) < V[piece] && V[piece] - got >= 200;
  }

  // ---------- tactics: which motif a move uses ----------
  const RAYS = { B: [[-1, -1], [-1, 1], [1, -1], [1, 1]], R: [[-1, 0], [1, 0], [0, -1], [0, 1]] };
  RAYS.Q = RAYS.B.concat(RAYS.R);
  // the first two pieces along each ray from a slider: [[sq1, sq2 or -1], …]
  function rays(board, from, t) {
    const out = [];
    for (const [dr, dc] of RAYS[t]) {
      let r = (from >> 3) + dr, c = (from & 7) + dc, hit = [];
      while (r >= 0 && r < 8 && c >= 0 && c < 8 && hit.length < 2) { if (board[r * 8 + c]) hit.push(r * 8 + c); r += dr; c += dc; }
      if (hit.length) out.push([hit[0], hit.length > 1 ? hit[1] : -1, dr, dc]);
    }
    return out;
  }
  const between = (a, b, x, dr, dc) => { let r = (a >> 3) + dr, c = (a & 7) + dc; while (r * 8 + c !== b) { if (r * 8 + c === x) return true; r += dr; c += dc; if (r < 0 || r > 7 || c < 0 || c > 7) return false; } return false; };
  const TACTICS = { mate: 'Checkmate', fork: 'Fork', pin: 'Pin', skewer: 'Skewer', discovered: 'Discovered attack', sac: 'Sacrifice', promo: 'Promotion' };
  function motifs(st, m, after, f) {
    const me = st.turn, opp = me === 'w' ? 'b' : 'w', b = after.board, out = [];
    const val = (q) => (b[q][1] === 'K' ? 2000 : V[b[q][1]]);
    if (f.check && !Chess.legalMoves(after).length) out.push('mate');
    if (f.threats >= 2) out.push('fork');                       // the king counts as one of the targets
    if (f.sac) out.push('sac');
    if (m.promo) out.push('promo');
    const t = b[m.to][1];
    if (RAYS[t]) {
      for (const [x, y] of rays(b, m.to, t)) {
        if (y < 0 || b[x][0] !== opp || b[y][0] !== opp) continue;
        if (b[x][1] !== 'K' && val(y) > val(x) && val(y) >= 300) { out.push('pin'); break; }
        if (val(x) > val(y) && V[b[y][1]] >= 300 && val(x) > V[t]) { out.push('skewer'); break; }
      }
    }
    // another of our sliders now attacks something valuable through the square the piece left
    for (let s0 = 0; s0 < 64 && !out.includes('discovered'); s0++) {
      const p = b[s0];
      if (!p || p[0] !== me || s0 === m.to || !RAYS[p[1]]) continue;
      for (const [x, , dr, dc] of rays(b, s0, p[1])) if (b[x][0] === opp && val(x) >= 300 && between(s0, x, m.from, dr, dc)) { out.push('discovered'); break; }
    }
    return out;
  }

  // ---------- endgames: the kind of ending a game reached ----------
  function endType(board) {
    const side = (c) => board.filter((p) => p && p[0] === c && p[1] !== 'K' && p[1] !== 'P').map((p) => p[1]).sort().join('');
    const all = side('w') + side('b');
    if (!all) return 'Pawn endgame';
    if (/^R+$/.test(all)) return 'Rook endgame';
    if (/^Q+$/.test(all)) return 'Queen endgame';
    if (/^B+$/.test(all)) return 'Bishop endgame';
    if (/^N+$/.test(all)) return 'Knight endgame';
    if (/^[BN]+$/.test(all)) return 'Bishop vs knight endgame';
    if (/^[RBN]+$/.test(all) && all.includes('R')) return 'Rook and minor piece endgame';
    return all.includes('Q') ? 'Queen and other pieces endgame' : 'Mixed endgame';
  }

  // What kind of move is this? Everything the style measures is built from these per-move facts.
  function features(st, m) {
    const me = st.turn, opp = me === 'w' ? 'b' : 'w', piece = st.board[m.from][1], after = Chess.apply(st, m);
    const fr = m.from >> 3, tr = m.to >> 3, adv = me === 'w' ? fr - tr : tr - fr;
    const ek = st.board.indexOf(opp + 'K'), ok = st.board.indexOf(me + 'K');
    const cheb = (a, b) => Math.max(Math.abs((a >> 3) - (b >> 3)), Math.abs((a & 7) - (b & 7)));
    const cap = after._captured ? V[after._captured[1]] : 0;
    const check = Chess.inCheck(after, opp);
    const inOpp = me === 'w' ? tr <= 3 : tr >= 4;
    const kzone = piece !== 'K' && ek >= 0 && cheb(m.to, ek) <= 2;
    const ekWing = ek >= 0 && ((ek & 7) <= 2 || (ek & 7) >= 5);
    const storm = piece === 'P' && adv > 0 && ekWing && Math.abs((m.to & 7) - (ek & 7)) <= 1;
    const okWing = ok >= 0 && ((ok & 7) <= 2 || (ok & 7) >= 5) && (me === 'w' ? ok >> 3 === 7 : ok >> 3 === 0);
    const shield = piece === 'P' && okWing && Math.abs((m.from & 7) - (ok & 7)) <= 1 && !storm;
    const retreat = piece !== 'P' && piece !== 'K' && adv < 0;
    const sac = isSac(st, m, after);
    // a trade: taking something about as valuable as the piece that took it, which can be taken back
    const trade = cap > 0 && Math.abs(cap - V[piece]) <= 60 && piece !== 'K' && Chess.legalMoves(after).some((x) => x.to === m.to);
    // threats: the moved piece now attacks enemy pieces worth more than itself (two at once is a fork)
    let threats = 0;
    if (piece !== 'K') {
      const sim = { ...after, turn: me, ep: null };
      for (const x of Chess.legalMoves(sim)) if (x.from === m.to && sim.board[x.to] && sim.board[x.to][0] === opp && (V[sim.board[x.to][1]] > V[piece] || sim.board[x.to][1] === 'K')) threats++;
    }
    const f = {
      piece, adv, cap, check, inOpp, kzone, storm, shield, retreat, sac, trade, threats,
      castle: m.castle || null, queenEarly: piece === 'Q' && st.full <= 8, kingWalk: piece === 'K' && !m.castle && phase(st, 0) !== 'e',
      forcing: check || cap > 0 || threats > 0,
    };
    f.tac = motifs(st, m, after, f);
    return f;
  }
  // per-move style points
  const aggPts = (f) => 0.5 * f.inOpp + 1.0 * f.kzone + 1.2 * f.check + 0.8 * f.storm + 2.0 * f.sac + 0.5 * (f.threats > 0) + 0.3 * (f.cap > 0 && !f.trade) - 0.7 * f.retreat;
  const riskPts = (f) => 2.5 * f.sac + 0.4 * f.kingWalk + 0.8 * f.shield + 0.4 * f.queenEarly + 0.6 * f.storm;

  // engine scores -> move classes, same thresholds as the game review (win-probability loss)
  function grade(best, played, legal) {
    if (legal <= 1 || best == null || played == null) return null;
    const loss = Math.max(0, WP(best) - WP(played));
    return { loss, cls: loss > 0.2 ? 'blunder' : loss > 0.1 ? 'mistake' : loss > 0.05 ? 'inaccuracy' : 'ok', acc: clamp(103.1668 * Math.exp(-0.04354 * loss * 100) - 3.1669, 0, 100) };
  }
  // what went wrong in a bad move: it left material hanging, or it missed a winning capture/check
  function errType(st, m, best) {
    if (best && (st.board[best.to] || Chess.inCheck(Chess.apply(st, best), st.turn === 'w' ? 'b' : 'w'))) return 'missed';
    return 'hung';
  }

  // ---------- one side of one game, measured the way profiles are ----------
  // recs: [{ f: features, ph, g: grade or null, t: errType, mt, ck, base }]
  function sideStats(recs, games = 1) {
    const n = recs.length || 1, F = recs.map((r) => r.f), cnt = (fn) => F.filter(fn).length;
    const graded = recs.filter((r) => r.g), by = (c) => graded.filter((r) => r.g.cls === c).length;
    const caps = cnt((f) => f.cap > 0), tac = {};
    for (const r of recs) for (const k of r.f.tac || []) tac[k] = (tac[k] || 0) + 1;
    return {
      moves: recs.length, tac,
      aggr: S(mean(F.map(aggPts)), 0.42, 0.16),
      tact: S(cnt((f) => f.forcing) / n, 0.3, 0.08),
      risk: S(mean(F.map(riskPts)), 0.13, 0.07),
      rates: { check: cnt((f) => f.check) / n, capture: caps / n, threat: cnt((f) => f.threats > 0) / n, retreat: cnt((f) => f.retreat) / n,
        storm: cnt((f) => f.storm) / n, trade: caps ? cnt((f) => f.trade) / caps : 0.5, queenEarly: cnt((f) => f.queenEarly) / games, kingWalk: cnt((f) => f.kingWalk) / n },
      sacs: cnt((f) => f.sac), forks: cnt((f) => f.threats >= 2),
      graded: graded.length, blunders: by('blunder'), mistakes: by('mistake'), inaccuracies: by('inaccuracy'),
      acc: graded.length ? Math.round(mean(graded.map((r) => r.g.acc)) * 10) / 10 : null,
    };
  }

  // per-move records for one side of a game (analysis optional: [{ best: uci, bestScore, played, legal }] per ply)
  function sideRecords(hist, color, an, extra = {}) {
    let st = Chess.initial();
    const out = [];
    hist.forEach((h, i) => {
      const m = Chess.legalMoves(st).find((x) => same(x, h));
      if (!m) return;
      if (st.turn === color) {
        const a = an && an[i], g = a ? grade(a.bestScore, a.played, a.legal) : null;
        out.push({ ply: i, f: features(st, m), ph: phase(st, i), g, t: g && g.cls !== 'ok' ? errType(st, m, a.best ? Chess.findUci(st, a.best) : null) : null,
          mt: extra.mt ? extra.mt[i] : null, ck: extra.ck ? extra.ck[i] : null });
      }
      st = Chess.apply(st, m);
    });
    return out;
  }

  // ---------- the profile ----------
  // games: [{ id, color, moves: "e2e4 e7e5 …", result, reason, tc, mt, ck, eco, opening, elo, at }]
  // analyze(state) -> { bestScore, scores: [{ uci, s }], legal, best } (optional; with it, the profile includes mistakes)
  // onProgress(done, total) is called after each game.
  function profile(name, games, analyze, onProgress, opts = {}) {
    const recs = [], rows = [], trows = [], bookTrain = {}, ends = {}, book = {}, first = { w: {}, e4: {}, d4: {}, other: {} }, ops = { w: {}, b: {} };
    const castle = { K: 0, Q: 0, none: 0, at: [] }, res = { win: 0, loss: 0, draw: 0 }, elos = [];
    const time = { o: [], m: [], e: [], fast: 0, trouble: 0, n: 0, secs: [], timeouts: 0 };
    let used = 0;
    games.forEach((g, gi) => {
      const ucis = String(g.moves || '').split(' ').filter(Boolean), color = g.color;
      const test = games.length >= 5 && gi % 5 === 4, tos = [];      // every 5th game is held out to test the models
      let st = Chess.initial(), castled = null, ok = true, prevCk = g.tc ? g.tc.base * 1000 : null, ending = null;
      const mine = [];
      ucis.forEach((u, i) => {
        if (!ok) return;
        const m = Chess.findUci(st, u);
        if (!m) { ok = false; return; }
        if (st.turn === color) {
          const ph = phase(st, i), f = features(st, m), r = { ply: i, f, ph, g: null, t: null };
          const bk = bookKey(st);
          if (i < BOOK_PLY) for (const B of test ? [book] : [book, bookTrain]) { const e = (B[bk] = B[bk] || {}); e[u] = (e[u] || 0) + 1; }
          const ctx = { lastTo: i ? tos[i - 1] : null, ownTo: i > 1 ? tos[i - 2] : null };
          let a = null;
          if (analyze && i >= 4) {                                    // the first couple of moves are book for everyone
            a = analyze(st);
            const played = a.scores.find((x) => x.uci === u);
            r.g = grade(a.bestScore, played ? played.s : null, a.legal);
            if (r.g && r.g.cls !== 'ok') r.t = errType(st, m, a.best ? Chess.findUci(st, a.best) : null);
            // a training row for the move model: every candidate's vector, and which one they chose
            if (a.legal > 1) {
              const c = candidates(st, a, ctx, u), k = c.findIndex((x) => x.u === u);
              if (k >= 0) rows.push({ c: c.map((x) => ({ x: x.x, u: x.u })), k, test, bk, ply: i, g: gi });
            }
          }
          // a training row for the timing model
          if (g.mt && g.mt[i] != null && i >= 2) {
            const o = a ? timeCtx(st, a, ctx, i, g.tc ? { left: prevCk, base: g.tc.base } : null)
              : { ph, ply: i, legal: Chess.legalMoves(st).length, check: Chess.inCheck(st, st.turn), recapture: false, hard: false, timed: !!g.tc, clock: g.tc ? prevCk / (g.tc.base * 1000) : 0, base: g.tc ? g.tc.base : 0 };
            trows.push({ x: tvec(o), y: tlog(g.mt[i]), test });
          }
          if (f.castle && !castled) { castled = f.castle; castle.at.push(st.full); }
          // time: the share of the clock left that this move used
          if (g.mt && g.mt[i] != null) {
            time.n++; time.secs.push(g.mt[i] / 1000);
            if (g.mt[i] < 2000) time.fast++;
            if (g.tc && g.ck && g.ck[i] != null) {
              if (prevCk > 0 && i >= 2) time[ph].push(clamp(g.mt[i] / prevCk, 0, 1));
              if (trouble(g.ck[i], g.tc.base)) time.trouble++;
              prevCk = g.ck[i];
            }
            r.mt = g.mt[i];
          }
          mine.push(r);
        }
        tos.push(m.to);
        if (!ending && i >= 10 && phase(st, i) === 'e') ending = endType(st.board);
        if (i === 0 && color === 'w') first.w[u] = (first.w[u] || 0) + 1;
        if (i === 1 && color === 'b') { const k = ucis[0] === 'e2e4' ? 'e4' : ucis[0] === 'd2d4' ? 'd4' : 'other'; first[k][u] = (first[k][u] || 0) + 1; }
        st = Chess.apply(st, m);
      });
      if (!mine.length) return;
      used++;
      recs.push(...mine);
      castle[castled || 'none']++;
      const outcome = g.result === 'draw' ? 'draw' : g.result === color ? 'win' : 'loss';
      res[outcome]++;
      if (g.reason === 'timeout' && outcome === 'loss') time.timeouts++;
      if (ending) {
        const e = (ends[ending] = ends[ending] || { name: ending, n: 0, pts: 0, acc: [] });
        e.n++; e.pts += outcome === 'win' ? 1 : outcome === 'draw' ? 0.5 : 0;
        for (const r of mine) if (r.ph === 'e' && r.g) e.acc.push(r.g.acc);
      }
      if (g.elo) elos.push(+g.elo);
      if (g.opening) {
        const o = (ops[color][g.opening] = ops[color][g.opening] || { eco: g.eco, name: g.opening, n: 0, pts: 0 });
        o.n++; o.pts += outcome === 'win' ? 1 : outcome === 'draw' ? 0.5 : 0;
      }
      if (onProgress) onProgress(gi + 1, games.length);
    });
    const s = sideStats(recs, Math.max(1, used));
    const perPhase = {};
    for (const ph of ['o', 'm', 'e']) {
      const r = recs.filter((x) => x.ph === ph && x.g);
      perPhase[ph] = { n: r.length, blunder: r.filter((x) => x.g.cls === 'blunder').length / (r.length || 1), mistake: r.filter((x) => x.g.cls === 'mistake').length / (r.length || 1),
        inaccuracy: r.filter((x) => x.g.cls === 'inaccuracy').length / (r.length || 1) };
    }
    const bad = recs.filter((x) => x.t);
    const top = (o) => Object.values(o).sort((a, b) => b.n - a.n).slice(0, 5).map((x) => ({ ...x, score: Math.round((100 * x.pts) / x.n) }));
    const rating = elos.length ? Math.round(mean(elos)) : 1200;
    // the models: tested on the held-out games first, then refitted on everything
    const train = rows.filter((r) => !r.test), held = rows.filter((r) => r.test);
    let backtest = null;
    if (held.length >= 15 && train.length >= 30) {
      const sc = evalRows(held, fit(train), bookTrain), tt = trows.filter((r) => !r.test), th = trows.filter((r) => r.test), T = fitTime(tt);
      backtest = { ...sc, engine: evalRows(held, null, bookTrain).top1, moves: held.length, games: new Set(held.map((r) => r.g)).size,
        time: T && th.length >= 10 ? Math.round(Math.exp(mean(th.map((r) => Math.abs(r.y - dot(T.w, r.x))))) * 10) / 10 : null };
    }
    const P = {
      v: 2, model: rows.length >= 20 ? { w: fit(rows), n: rows.length } : null, timeModel: fitTime(trows), backtest, name, games: used, src: games.length, built: Date.now(), last: games[0] ? games[0].id : null, rating,
      aggr: s.aggr, tact: s.tact, risk: s.risk, rates: s.rates, sacs: s.sacs / Math.max(1, used), forks: s.forks / Math.max(1, used),
      castle: { K: castle.K / Math.max(1, used), Q: castle.Q / Math.max(1, used), none: castle.none / Math.max(1, used), at: castle.at.length ? Math.round(mean(castle.at)) : null },
      openings: { w: top(ops.w), b: top(ops.b) }, first,
      // tactics they used: per game, most frequent first
      tactics: Object.entries(s.tac).map(([k, n]) => ({ k, name: TACTICS[k], n, perGame: Math.round((100 * n) / Math.max(1, used)) / 100 })).sort((a, b) => b.n - a.n),
      endgames: Object.values(ends).sort((a, b) => b.n - a.n).map((e) => ({ name: e.name, n: e.n, score: Math.round((100 * e.pts) / e.n), acc: e.acc.length ? Math.round(mean(e.acc)) : null })),
      reachedEnd: Object.values(ends).reduce((a, e) => a + e.n, 0) / Math.max(1, used),
      book, results: res,
      err: s.graded ? {
        graded: s.graded, acc: s.acc, perGame: { blunder: s.blunders / used, mistake: s.mistakes / used, inaccuracy: s.inaccuracies / used },
        phase: perPhase, hung: bad.filter((x) => x.t === 'hung').length / Math.max(1, bad.length),
      } : null,
      time: time.n ? {
        moves: time.n, avgSec: Math.round(mean(time.secs) * 10) / 10, fast: time.fast / time.n, trouble: time.trouble / time.n, timeouts: time.timeouts,
        share: { o: time.o.length ? mean(time.o) : null, m: time.m.length ? mean(time.m) : null, e: time.e.length ? mean(time.e) : null },
      } : null,
    };
    P.tags = tags(P);
    if (opts.rows) Object.defineProperty(P, 'rows', { value: { rows, bookTrain } });   // for tuning (not saved)
    return P;
  }

  // a few words that sum up a profile
  function tags(P) {
    const t = [];
    t.push(P.aggr >= 65 ? 'Aggressive attacker' : P.aggr <= 35 ? 'Solid defender' : 'Balanced');
    t.push(P.tact >= 60 ? 'Tactical' : P.tact <= 40 ? 'Positional' : 'Mixed tactical / positional');
    if (P.risk >= 65) t.push('Risk-taker'); else if (P.risk <= 30) t.push('Plays it safe');
    if (P.sacs >= 0.6) t.push('Loves a sacrifice');
    if (P.rates.trade >= 0.65) t.push('Trades pieces off'); else if (P.rates.trade <= 0.35) t.push('Keeps pieces on');
    if (P.castle.none >= 0.4) t.push('Often leaves the king in the centre');
    else if (P.castle.Q >= 0.35) t.push('Castles queenside');
    if (P.rates.queenEarly >= 0.5) t.push('Early queen');
    if (P.time) { if (P.time.trouble >= 0.15) t.push('Gets into time trouble'); else if (P.time.fast >= 0.6) t.push('Plays fast'); }
    if (P.err && P.err.perGame.blunder >= 1.5) t.push('Blunder-prone');
    const fav = P.tactics.find((x) => x.k !== 'promo' && x.perGame >= 0.3);
    if (fav) t.push(`Favourite tactic: ${fav.name.toLowerCase()}`);
    if (P.endgames.length && P.endgames[0].n >= 3) t.push(`Often reaches ${P.endgames[0].name.toLowerCase()}s`);
    return t;
  }

  // ---------- playing like them: a move model learned from their own games ----------
  // Every legal move is described by a vector: how much it loses as seen by a 1-, 2- and 3-move search, and what kind of
  // move it is (check, capture, retreat, which piece, recapture…). P(move) ∝ exp(w · x), with w fitted to the moves the
  // player actually chose. The three loss columns let it learn how deep they look: a weak player's weight sits on the
  // shallow search, so the bot misses the same deep tactics they miss. The opening book still comes first.
  const DEPTH = 3, CAND = 16;
  const trouble = (left, base) => left < Math.max(10000, base * 100);   // "in time trouble": the same rule for the profile and for play
  const FEAT = ['loss1', 'loss2', 'loss3', 'check', 'capture', 'trade', 'sacrifice', 'threat', 'fork', 'enemyHalf', 'kingZone', 'pawnStorm', 'shieldPawn', 'retreat',
    'castle', 'earlyQueen', 'kingWalk', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king', 'advance', 'pinSkewer', 'promotion', 'recapture', 'samePiece'];
  // a generic club player: the starting point, and what few games are pulled toward
  const W0 = [-0.5, -0.8, -1.4, 0.3, 0.6, 0.2, -0.5, 0.3, 0.3, 0, 0.2, 0, -0.2, -0.2, 1.0, -0.3, -0.5, 0, 0, 0, 0, -0.2, -0.4, 0.2, 0.3, 0.5, 1.0, -0.2];
  const legalOf = (state, a) => a._legal || (a._legal = Chess.legalMoves(state));   // generated once per engine result
  const dot = (w, x) => { let s = 0; for (let i = 0; i < w.length; i++) s += w[i] * x[i]; return s; };
  // a = engine result with layers ([{ uci: score }] per depth); ctx = { lastTo, ownTo } (where the last two moves went)
  function candidates(state, a, ctx = {}, played) {
    const L = [0, 1, 2].map((d) => a.layers[Math.min(d, a.layers.length - 1)]);
    const top = L.map((x) => WP(Math.max(...Object.values(x)))), deep = L[2];
    let list = Object.keys(deep).sort((x, y) => deep[y] - deep[x]);
    if (list.length > CAND) { const p = played && list.indexOf(played) >= CAND ? played : null; list = list.slice(0, CAND); if (p) list.push(p); }
    const legal = new Map(legalOf(state, a).map((m) => [uci(m), m]));
    return list.filter((u) => legal.has(u)).map((u) => {
      const m = legal.get(u), f = features(state, m), p = f.piece;
      const x = [0, 1, 2].map((d) => 10 * Math.max(0, top[d] - WP(L[d][u] != null ? L[d][u] : deep[u])));   // ×10: same scale as the other columns
      x.push(+f.check, f.cap / 900, +f.trade, +f.sac, +(f.threats > 0), +(f.threats >= 2), +f.inOpp, +f.kzone, +f.storm, +f.shield, +f.retreat, +!!f.castle, +f.queenEarly, +f.kingWalk,
        +(p === 'P'), +(p === 'N'), +(p === 'B'), +(p === 'R'), +(p === 'Q'), +(p === 'K' && !f.castle), f.adv / 7,
        +f.tac.some((t) => t === 'pin' || t === 'skewer' || t === 'discovered'), +!!m.promo, +(f.cap > 0 && m.to === ctx.lastTo), +(m.from === ctx.ownTo));
      return { u, m, s: deep[u], loss: x[2] / 10, x, f };
    });
  }
  // maximum likelihood with a pull toward W0 (so a handful of games can't produce something silly); Adam steps
  function fit(rows, w0 = W0, lam = 0.002, iters = 400) {
    const D = w0.length, w = w0.slice(), m1 = new Array(D).fill(0), m2 = new Array(D).fill(0);
    if (!rows.length) return w;
    for (let t = 1; t <= iters; t++) {
      const g = new Array(D).fill(0);
      for (const r of rows) {
        const us = r.c.map((c) => dot(w, c.x)), mx = Math.max(...us), ex = us.map((u) => Math.exp(u - mx)), z = ex.reduce((a, b) => a + b, 0);
        r.c.forEach((c, j) => { const k = (j === r.k ? 1 : 0) - ex[j] / z; for (let d = 0; d < D; d++) g[d] += k * c.x[d]; });
      }
      for (let d = 0; d < D; d++) {
        const gd = g[d] / rows.length - 2 * lam * (w[d] - w0[d]);
        m1[d] = 0.9 * m1[d] + 0.1 * gd; m2[d] = 0.999 * m2[d] + 0.001 * gd * gd;
        w[d] += (0.08 * m1[d] / (1 - Math.pow(0.9, t))) / (Math.sqrt(m2[d] / (1 - Math.pow(0.999, t))) + 1e-8);
      }
    }
    return w.map((x) => Math.round(x * 1000) / 1000);
  }
  // the backtest: like predict(), the player's book first (from the training games only), then the model
  // (w = null: the engine's order instead, the baseline)
  function evalRows(rows, w, book) {
    let t1 = 0, t3 = 0;
    for (const r of rows) {
      const bk = r.ply < BOOK_PLY && book[r.bk] ? Object.entries(book[r.bk]).sort((a, b) => b[1] - a[1]).map(([u]) => u) : [];
      const model = w ? r.c.map((c) => ({ u: c.u, s: dot(w, c.x) })).sort((a, b) => b.s - a.s).map((x) => x.u) : r.c.map((c) => c.u);
      const list = [...bk, ...model.filter((u) => !bk.includes(u))], played = r.c[r.k].u, at = list.indexOf(played);
      if (at === 0) t1++; if (at >= 0 && at < 3) t3++;
    }
    return { top1: t1 / rows.length, top3: t3 / rows.length };
  }
  // ---------- think time: a second small model, log(seconds) from the situation (least squares) ----------
  const TFEAT = ['bias', 'middlegame', 'endgame', 'clockLeft', 'timed', 'longControl', 'manyMoves', 'onlyMove', 'recapture', 'hardChoice', 'opening', 'inCheck'];
  function tvec(o) {
    return [1, +(o.ph === 'm'), +(o.ph === 'e'), o.timed ? clamp(o.clock, 0, 1.5) : 0, +!!o.timed, o.timed ? Math.log(1 + o.base) / Math.log(5401) : 0,
      Math.min(o.legal, 50) / 40, +(o.legal === 1), +!!o.recapture, +!!o.hard, +(o.ply < BOOK_PLY), +!!o.check];
  }
  function ridge(X, y, lam = 0.5) {
    const D = X[0].length, A = Array.from({ length: D }, (_, i) => Array.from({ length: D + 1 }, (_, j) => (j === i ? lam : 0)));
    X.forEach((x, n) => { for (let i = 0; i < D; i++) { for (let j = 0; j < D; j++) A[i][j] += x[i] * x[j]; A[i][D] += x[i] * y[n]; } });
    for (let i = 0; i < D; i++) {                                  // Gaussian elimination with partial pivoting
      let p = i; for (let r = i + 1; r < D; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]];
      for (let r = 0; r < D; r++) if (r !== i) { const k = A[r][i] / A[i][i]; for (let c = i; c <= D; c++) A[r][c] -= k * A[i][c]; }
    }
    return A.map((row, i) => row[D] / row[i]);
  }
  const tlog = (ms) => Math.log(ms / 1000 + 0.3);
  function fitTime(rows) {
    if (rows.length < 20) return null;
    const w = ridge(rows.map((r) => r.x), rows.map((r) => r.y));
    const res = rows.map((r) => r.y - dot(w, r.x)), sigma = Math.sqrt(mean(res.map((e) => e * e)));
    return { w: w.map((x) => Math.round(x * 1000) / 1000), sigma: Math.round(sigma * 1000) / 1000, n: rows.length,
      timed: rows.filter((r) => r.x[4]).length, untimed: rows.filter((r) => !r.x[4]).length };
  }
  // ms the player would take here: a draw from their fitted distribution
  function thinkTime(P, o, rnd = Math.random) {
    const T = P.timeModel;
    if (!T || (o.timed ? T.timed : T.untimed) < 10) return null;          // no data for this kind of game: the caller falls back
    const z = Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
    return Math.max(0, (Math.exp(dot(T.w, tvec(o)) + T.sigma * z) - 0.3) * 1000);
  }
  // the timing features for a position, from an engine result
  function timeCtx(state, a, ctx, ply, clock) {
    const deep = a.layers.length ? a.layers[a.layers.length - 1] : {}, v = Object.values(deep).sort((x, y) => y - x);
    return { ph: phase(state, ply), ply, legal: a.legal, check: Chess.inCheck(state, state.turn), recapture: ctx.lastTo != null && legalOf(state, a).some((m) => m.to === ctx.lastTo),
      hard: v.length > 1 && WP(v[0]) - WP(v[1]) < 0.03, timed: !!(clock && clock.base), clock: clock && clock.base ? clock.left / (clock.base * 1000) : 0, base: clock ? clock.base : 0 };
  }

  // difficulty: how much the bot looks deeper than they do, or less
  const DIFF = {
    easy: { label: 'Off day', loss: 0.6, deep: 0, desc: 'Their style on a bad day: they see even less than usual.' },
    true: { label: 'True to form', loss: 1, deep: 0, desc: 'As close to how they really play as possible, mistakes included.' },
    sharp: { label: 'On form', loss: 1.3, deep: -1.2, desc: 'Their style on a good day: they spot more of the deep tactics.' },
    best: { label: 'Best day', loss: 1.8, deep: -4, desc: 'Their ideas with almost none of their mistakes.' },
  };
  // search time per move: the same budget the profile was built with (PROFILE_MS), so the bot "sees" what the model was
  // trained on; the stronger settings search longer, and their extra deep weight uses what that finds
  const PROFILE_MS = 50;
  const engineMs = (P, diff) => (diff === 'best' ? 1500 : diff === 'sharp' ? 400 : PROFILE_MS);
  // the weights the bot plays with: the player's own, adjusted for difficulty and time pressure
  function weights(P, diff, hurry) {
    const d = DIFF[diff] || DIFF.true, w = ((P.model && P.model.w) || W0).slice();
    for (let i = 0; i < 3; i++) w[i] *= d.loss * (hurry ? (i === 2 ? 0.5 : 0.7) : 1);
    w[2] += d.deep;
    return w;
  }
  const pickW = (list, w, rnd) => { const tot = list.reduce((a, x) => a + w(x), 0); let r = rnd() * tot; for (const x of list) { r -= w(x); if (r <= 0) return x; } return list[list.length - 1]; };
  function fromBook(state, a, P, ply, tol, rnd) {
    const bk = ply < BOOK_PLY && P.book ? P.book[bookKey(state)] : null;
    if (!bk) return null;
    const deep = a.layers[a.layers.length - 1], best = Math.max(...Object.values(deep));
    const opts = Object.entries(bk).filter(([u]) => deep[u] != null && deep[u] >= best - tol).map(([u, n]) => ({ u, n }));
    return opts.length ? (rnd ? pickW(opts, (o) => o.n, rnd) : opts.sort((x, y) => y.n - x.n)[0]) : null;
  }

  // a = engine result (scoreAll); opts: { ply, diff, ctx: { lastTo, ownTo }, clock: { left, base } (timed games), rnd }
  // -> { move, why: 'book' | 'style' | 'mistake' | 'blunder', think (ms they'd take, or null) }
  function choose(state, a, P, opts = {}) {
    const rnd = opts.rnd || Math.random, ply = opts.ply || 0, ctx = opts.ctx || {}, d = DIFF[opts.diff] || DIFF.true;
    if (!a.legal) return null;
    const think = thinkTime(P, timeCtx(state, a, ctx, ply, opts.clock), rnd);
    const b = fromBook(state, a, P, ply, 150 / d.loss, rnd);
    if (b) return { move: Chess.findUci(state, b.u), why: 'book', think };
    const hurry = !!(opts.clock && opts.clock.base && trouble(opts.clock.left, opts.clock.base));
    const c = candidates(state, a, ctx), w = weights(P, opts.diff, hurry);
    const us = c.map((x) => dot(w, x.x)), mx = Math.max(...us);
    const pick = pickW(c.map((x, i) => ({ x, e: Math.exp(us[i] - mx) })), (o) => o.e, rnd).x;
    return { move: pick.m, why: pick.loss > 0.2 ? 'blunder' : pick.loss > 0.1 ? 'mistake' : 'style', think };
  }
  // the moves the player is most likely to play here (no randomness)
  function predict(state, a, P, opts = {}) {
    if (!a.legal) return null;
    const b = fromBook(state, a, P, opts.ply || 0, 150, null);
    const c = candidates(state, a, opts.ctx || opts), w = weights(P, 'true', false);
    let list = c.map((x) => ({ u: x.u, s: dot(w, x.x) })).sort((x, y) => y.s - x.s).map((x) => x.u);
    if (b) list = [b.u, ...list.filter((u) => u !== b.u)];
    return { move: list[0], top: list.slice(0, 3), book: !!b };
  }

  // ---------- comparing a game with a profile ----------
  // 0..100: how close one side of one game came to a profile's style (single games are noisy, so this is "about")
  function similarity(st, P, extra = {}) {
    const parts = [
      [1 - Math.abs(st.aggr - P.aggr) / 100, 3],
      [1 - Math.abs(st.tact - P.tact) / 100, 3],
      [1 - Math.abs(st.risk - P.risk) / 100, 2],
      [1 - Math.min(1, Math.abs(st.rates.trade - P.rates.trade)), 1],
    ];
    if (P.err && st.acc != null && P.err.acc != null) parts.push([1 - Math.min(1, Math.abs(st.acc - P.err.acc) / 40), 2]);
    if (extra.book != null) parts.push([extra.book, 2]);                 // share of opening moves that came from their book
    if (extra.castle != null) parts.push([extra.castle, 1]);             // castled the way they usually do
    const w = parts.reduce((a, p) => a + p[1], 0);
    return Math.round(clamp((100 * parts.reduce((a, p) => a + p[0] * p[1], 0)) / w, 0, 100));
  }
  // share of a side's book-range moves that the profile's book contains
  function bookShare(hist, color, P) {
    let st = Chess.initial(), hit = 0, seen = 0;
    for (let i = 0; i < Math.min(hist.length, BOOK_PLY); i++) {
      const m = Chess.legalMoves(st).find((x) => same(x, hist[i]));
      if (!m) break;
      if (st.turn === color) { const bk = P.book && P.book[bookKey(st)]; if (bk) { seen++; if (bk[uci(m)]) hit++; } }
      st = Chess.apply(st, m);
    }
    return seen ? hit / seen : null;
  }

  return { TACTICS, FEAT, TFEAT, W0, DEPTH, PROFILE_MS, endType, profile, choose, predict, candidates, fit, evalRows, thinkTime, engineMs, features, sideRecords, sideStats, similarity, bookShare, bookKey, phase, grade, DIFF, BOOK_PLY, uci, sq };
});
