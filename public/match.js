// Head-to-head matches: two players play game after game in the same room until the format decides who is better.
//   bo  best of n (3, 5, 7): a win is 1 point, a draw ½; the first past n/2 wins. Level after n games: an Armageddon decider
//   ft  first to n wins (3, 5, 10): draws don't count
//   mar marathon: no end, keep going and keep score; either player can stop it between games
// Colours alternate every game. In Armageddon Black has less time but a draw counts as a Black win.
// Players are stored by name because colours swap. Shared by the server and the page (window.Match).
(function (root) {
  const SIZES = { bo: [3, 5, 7], ft: [3, 5, 10], mar: [0] };
  const MAX_GAMES = 200;                                     // a marathon stops itself here (keeps the room record small)
  const ARMA_BLACK = 0.8;                                    // Black's share of the clock in Armageddon

  function clean(m) {
    if (!m || !SIZES[m.fmt]) return null;
    const n = m.fmt === 'mar' ? 0 : m.n | 0;
    return SIZES[m.fmt].includes(n) ? { fmt: m.fmt, n } : null;
  }
  const start = (f, past = [], no = 1) => ({ fmt: f.fmt, n: f.n, p: null, games: [], done: false, winner: null, why: null, arma: false, no, past });

  const label = (m) => (m.fmt === 'bo' ? `Best of ${m.n}` : m.fmt === 'ft' ? `First to ${m.n} wins` : 'Marathon');
  const short = (m) => (m.fmt === 'bo' ? `Bo${m.n}` : m.fmt === 'ft' ? `FT${m.n}` : 'Marathon');

  // points and wins per player name
  function score(m) {
    const pts = {}, wins = {}, draws = { n: 0 };
    for (const x of m.p || []) { pts[x] = 0; wins[x] = 0; }
    for (const g of m.games) {
      if (g.win) { pts[g.win] = (pts[g.win] || 0) + 1; wins[g.win] = (wins[g.win] || 0) + 1; }
      else { draws.n++; pts[g.w] = (pts[g.w] || 0) + 0.5; pts[g.b] = (pts[g.b] || 0) + 0.5; }
    }
    return { pts, wins, draws: draws.n };
  }
  const leader = (m, s = score(m)) => { const [a, b] = m.p || []; return !a || s.pts[a] === s.pts[b] ? null : s.pts[a] > s.pts[b] ? a : b; };

  // The game that just ended: { id, w, b (names), result 'w'|'b'|'draw', reason, moves, arma }
  function record(m, g) {
    if (m.done) return m;
    if (!m.p) m.p = [g.w, g.b];
    const winColor = g.result === 'draw' ? (g.arma ? 'b' : null) : g.result;   // Armageddon: a draw goes to Black
    m.games.push({ id: g.id || null, w: g.w, b: g.b, r: g.result, why: g.reason, win: winColor ? g[winColor] : null, arma: !!g.arma, n: g.moves | 0 });
    decide(m);
    return m;
  }

  function decide(m) {
    const s = score(m), [a, b] = m.p, last = m.games[m.games.length - 1];
    const finish = (w, why) => { m.done = true; m.winner = w; m.why = why; m.arma = false; };
    if (m.fmt === 'bo') {
      if (last && last.arma) return finish(last.win, 'armageddon');
      for (const x of [a, b]) if (s.pts[x] > m.n / 2) return finish(x, 'score');
      if (m.games.length >= m.n) m.arma = true;                    // level after n games: one decider
    } else if (m.fmt === 'ft') {
      for (const x of [a, b]) if (s.wins[x] >= m.n) return finish(x, 'score');
    }
    if (m.games.length >= MAX_GAMES) finish(leader(m, s), 'limit');
  }

  // Either player stops the match between games: the leader (if any) takes it.
  function stop(m, by) { if (!m.done) { m.done = true; m.winner = leader(m); m.why = 'stopped'; m.by = by; m.arma = false; } return m; }

  // After a finished match: the same two players start a new one in the same format; earlier results are kept.
  function again(m) {
    const s = score(m);
    const past = [...(m.past || []), { winner: m.winner, why: m.why, pts: s.pts, games: m.games.length }].slice(-20);
    const next = start(m, past, (m.no || 1) + 1);
    next.p = m.p;
    return next;
  }

  // Run of wins at the end of the match so far: { name, n } (draws break it)
  function streak(m) {
    let name = null, n = 0;
    for (let i = m.games.length - 1; i >= 0; i--) {
      const w = m.games[i].win;
      if (!w || (name && w !== name)) break;
      name = w; n++;
    }
    return { name, n };
  }
  // "match point": one more win would decide it
  function matchPoint(m) {
    if (m.done || m.fmt === 'mar' || m.arma) return [];
    const s = score(m);
    return (m.p || []).filter((x) => (m.fmt === 'bo' ? s.pts[x] + 1 > m.n / 2 : s.wins[x] + 1 >= m.n));
  }

  const api = { SIZES, MAX_GAMES, ARMA_BLACK, clean, start, label, short, score, leader, record, stop, again, streak, matchPoint };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Match = api;
})(typeof self !== 'undefined' ? self : this);
