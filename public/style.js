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
      piece, cap, check, inOpp, kzone, storm, shield, retreat, sac, trade, threats,
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
  function profile(name, games, analyze, onProgress) {
    const recs = [], ends = {}, book = {}, first = { w: {}, e4: {}, d4: {}, other: {} }, ops = { w: {}, b: {} };
    const castle = { K: 0, Q: 0, none: 0, at: [] }, res = { win: 0, loss: 0, draw: 0 }, elos = [];
    const time = { o: [], m: [], e: [], fast: 0, trouble: 0, n: 0, secs: [], timeouts: 0 };
    let used = 0;
    games.forEach((g, gi) => {
      const ucis = String(g.moves || '').split(' ').filter(Boolean), color = g.color;
      let st = Chess.initial(), castled = null, ok = true, prevCk = g.tc ? g.tc.base * 1000 : null, ending = null;
      const mine = [];
      ucis.forEach((u, i) => {
        if (!ok) return;
        const m = Chess.findUci(st, u);
        if (!m) { ok = false; return; }
        if (st.turn === color) {
          const ph = phase(st, i), f = features(st, m), r = { ply: i, f, ph, g: null, t: null };
          if (i < BOOK_PLY) { const k = bookKey(st), e = (book[k] = book[k] || {}); e[u] = (e[u] || 0) + 1; }
          if (analyze && i >= 4) {                                    // the first couple of moves are book for everyone
            const a = analyze(st), played = a.scores.find((x) => x.uci === u);
            r.g = grade(a.bestScore, played ? played.s : null, a.legal);
            if (r.g && r.g.cls !== 'ok') r.t = errType(st, m, a.best ? Chess.findUci(st, a.best) : null);
          }
          if (f.castle && !castled) { castled = f.castle; castle.at.push(st.full); }
          // time: the share of the clock left that this move used
          if (g.mt && g.mt[i] != null) {
            time.n++; time.secs.push(g.mt[i] / 1000);
            if (g.mt[i] < 2000) time.fast++;
            if (g.tc && g.ck && g.ck[i] != null) {
              if (prevCk > 0 && i >= 2) time[ph].push(clamp(g.mt[i] / prevCk, 0, 1));
              if (g.ck[i] < Math.max(10000, g.tc.base * 100)) time.trouble++;
              prevCk = g.ck[i];
            }
            r.mt = g.mt[i];
          }
          mine.push(r);
        }
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
    const bad = recs.filter((x) => x.t), okLoss = recs.filter((x) => x.g && x.g.cls === 'ok').map((x) => x.g.loss);
    const top = (o) => Object.values(o).sort((a, b) => b.n - a.n).slice(0, 5).map((x) => ({ ...x, score: Math.round((100 * x.pts) / x.n) }));
    const rating = elos.length ? Math.round(mean(elos)) : 1200;
    const P = {
      v: 1, name, games: used, src: games.length, built: Date.now(), last: games[0] ? games[0].id : null, rating,
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
        // how far from the best move their ordinary (non-mistake) moves are: sets the bot's "noise"
        temp: Math.round(clamp(35 + 1400 * mean(okLoss), 15, 120)),
      } : null,
      time: time.n ? {
        moves: time.n, avgSec: Math.round(mean(time.secs) * 10) / 10, fast: time.fast / time.n, trouble: time.trouble / time.n, timeouts: time.timeouts,
        share: { o: time.o.length ? mean(time.o) : null, m: time.m.length ? mean(time.m) : null, e: time.e.length ? mean(time.e) : null },
      } : null,
    };
    P.tags = tags(P);
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

  // ---------- playing like them ----------
  // difficulty: how close to their own level the bot plays
  const DIFF = {
    easy: { label: 'Off day', err: 1.7, temp: 1.5, depth: -1, desc: 'Their style on a bad day: more of their typical mistakes.' },
    true: { label: 'True to form', err: 1, temp: 1, depth: 0, desc: 'As close to how they really play as possible, mistakes included.' },
    sharp: { label: 'On form', err: 0.5, temp: 0.6, depth: 1, desc: 'Their style on a good day: half the mistakes.' },
    best: { label: 'Best day', err: 0.15, temp: 0.3, depth: 2, desc: 'Their ideas with almost none of their mistakes.' },
  };
  // engine settings for the bot's search: deeper for stronger players
  function engine(P, diff) {
    const d = DIFF[diff] || DIFF.true, r = P.rating || 1200;
    const depth = clamp((r < 1000 ? 2 : r < 1400 ? 3 : r < 1800 ? 4 : 5) + d.depth, 1, 6);
    return { depth, ms: 300 + depth * 220 };
  }
  // how many points (cp) a move earns for fitting the style; it decides between moves of similar value
  function bonus(f, P) {
    const wA = (P.aggr - 50) / 50, wT = (P.tact - 50) / 50, wR = (P.risk - 50) / 50;
    let b = wA * 22 * aggPts(f) + wT * 18 * (f.forcing ? 1 : -0.3) + wR * 25 * riskPts(f);
    if (f.trade) b += (P.rates.trade - 0.5) * 50;
    if (f.castle) b += 20 + 40 * (P.castle[f.castle] - 0.5);
    if (f.queenEarly) b += clamp((P.rates.queenEarly - 0.3) * 40, -25, 15);
    return clamp(b, -70, 70);
  }
  function rank(state, scored, P) {
    const top = scored[0].s;
    return scored.map((x) => {
      const m = x.m || Chess.findUci(state, x.uci), f = features(state, m), loss = Math.max(0, WP(top) - WP(x.s));
      return { m, s: x.s, f, loss, u: x.s + bonus(f, P) };
    });
  }
  const pickW = (list, w, rnd) => { const tot = list.reduce((a, x) => a + w(x), 0); let r = rnd() * tot; for (const x of list) { r -= w(x); if (r <= 0) return x; } return list[list.length - 1]; };

  // scored: [{ m (or uci), s }] engine score of every legal move (mover's view), best first.
  // opts: { ply, diff, clockLeft (share of the starting clock still left, timed games), rnd }
  function choose(state, scored, P, opts = {}) {
    const rnd = opts.rnd || Math.random, d = DIFF[opts.diff] || DIFF.true, ply = opts.ply || 0;
    if (!scored.length) return null;
    // 1. their own opening moves, as often as they played them
    const bk = ply < BOOK_PLY && P.book ? P.book[bookKey(state)] : null;
    if (bk) {
      const opts2 = Object.entries(bk).map(([u, n]) => ({ u, n, x: scored.find((x) => (x.uci || uci(x.m)) === u) })).filter((o) => o.x && o.x.s >= scored[0].s - 150 * d.err);   // stronger settings drop book moves that lose more
      if (opts2.length) { const o = pickW(opts2, (o) => o.n, rnd); return { move: o.x.m || Chess.findUci(state, o.u), why: 'book' }; }
    }
    const R = rank(state, scored, P);
    if (R.length === 1) return { move: R[0].m, why: 'forced' };
    // 2. their kind of mistakes, about as often as they make them (more of them when short of time)
    const ph = phase(state, ply), E = P.err && P.err.phase[ph] && P.err.phase[ph].n >= 8 ? P.err.phase[ph] : P.err ? { blunder: P.err.perGame.blunder / 35, mistake: P.err.perGame.mistake / 35 } : { blunder: 0.02, mistake: 0.04 };
    const hurry = opts.clockLeft != null && opts.clockLeft < 0.1 ? 1.6 : 1;
    const pB = E.blunder * d.err * hurry, pM = E.mistake * d.err * hurry, r = rnd();
    const band = (lo, hi) => R.filter((x) => x.loss > lo && x.loss <= hi);
    // a bad move that looks natural: one that fits the style, not a random piece giveaway
    const natural = (list) => pickW(list, (x) => Math.exp((x.u - x.s + (x.f.forcing ? 15 : 0)) / 25), rnd);
    if (r < pB) { const c = band(0.2, 0.55); if (c.length) return { move: natural(c).m, why: 'blunder' }; }
    else if (r < pB + pM) { const c = band(0.1, 0.2); if (c.length) return { move: natural(c).m, why: 'mistake' }; }
    // 3. otherwise a good move, chosen with their taste and their usual imprecision
    const T = Math.max(6, ((P.err && P.err.temp) || 40) * d.temp);
    const ok = R.filter((x) => x.loss <= 0.1);
    const best = Math.max(...ok.map((x) => x.u));
    return { move: pickW(ok, (x) => Math.exp((x.u - best) / T), rnd).m, why: 'style' };
  }

  // the move the player is most likely to play here, and the next two
  function predict(state, scored, P, ply = 0) {
    if (!scored.length) return null;
    const bk = ply < BOOK_PLY && P.book ? P.book[bookKey(state)] : null;
    const R = rank(state, scored, P).filter((x) => x.loss <= 0.1 || scored.length < 3);
    R.sort((a, b) => b.u - a.u);
    let list = R.map((x) => uci(x.m));
    if (bk) {
      const bm = Object.entries(bk).sort((a, b) => b[1] - a[1]).map(([u]) => u).filter((u) => scored.some((x) => (x.uci || uci(x.m)) === u));
      list = [...bm, ...list.filter((u) => !bm.includes(u))];
    }
    return { move: list[0], top: list.slice(0, 3), book: !!bk };
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

  return { TACTICS, endType, profile, choose, predict, features, sideRecords, sideStats, similarity, bookShare, bookKey, phase, grade, engine, DIFF, BOOK_PLY, uci, sq };
});
