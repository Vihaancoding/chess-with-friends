// HIGHLIGHT REELS: the moments worth replaying. Found from the same checked evaluations as LIVE TUNE-IN (lib/tunein.js) and
// from the server's own records (result, ratings, streaks). Pure rules: lib/app.js stores what this returns.
// Nothing here trusts a browser's claim: every number is an evaluation that passed the batch checks, or comes from the move list,
// the clock record, the ratings or the streak archive.
// Not yet: brilliant moves and checkmate sequences. Those need deeper verification than the live analysis gives.
const MIN_SCORE = 60;        // a moment below this is not worth a reel
const UPSET_GAP = 300;       // rating points: the lower-rated side must be this much weaker for a win to be an upset
const SWING_MIN = 300;       // centipawns in one move (not a mate flip) to count as a swing
const TRENDING_MS = 48 * 3600e3, TRENDING_MIN = 70, TRENDING_N = 5;
const PIECE = { Q: 'QUEEN', R: 'ROOK', B: 'BISHOP', N: 'KNIGHT' };
// the filters people pick (kind of moment -> the filter that shows it)
const FILTERS = { upsets: 'upset', streaks: 'streak', comebacks: 'comeback', sacrifices: 'sacrifice', time: 'time' };

const pawns = (cp) => (Math.abs(cp) / 100).toFixed(1);

// g: { over, winner ('w'|'b'|'draw'|null), w: {name, elo}, b: {name, elo}, lastEval (White's, newest), streak: {len, victim, breakerSide} | null }
// res: the output of TI.analyse(). Returns [{ id, kind, ply, score, headline, why, side }] for every moment worth a reel.
function candidates(res, g, code) {
  const out = [], pov = (s) => (s === 'w' ? 1 : -1);
  const name = (s) => (s === 'w' ? g.w.name : g.b.name), elo = (s) => (s === 'w' ? g.w.elo : g.b.elo);
  const winningNow = (s) => g.lastEval != null && pov(s) * g.lastEval >= 100;
  const won = (s) => g.over && g.winner === s;
  const add = (kind, ply, score, headline, why, side) => {
    if (score < MIN_SCORE) return;
    const id = `${code}:${kind}:${ply}`;
    out.push({ id, kind, ply, score: Math.min(100, Math.round(score)), headline, why, side: side || null });
  };

  for (const e of res.events) {
    if (e.kind === 'comeback') {
      if (!(winningNow(e.side) || won(e.side))) continue;
      const low = Math.round((e.low || 0) / 100);
      add('comeback', e.ply, 75 + (won(e.side) ? 5 : 0), `FROM ${low} TO VICTORY.`,
        `${name(e.side)} was ${Math.abs(low)} pawns down and came back to level or better.`, e.side);
    } else if (e.kind === 'sacrifice') {
      const held = winningNow(e.side) || won(e.side);
      add('sacrifice', e.ply, 70 + (held ? 10 : 0),
        `THE ${PIECE[e.piece] || 'PIECE'} WAS SACRIFICED. THE POSITION ${held ? 'WAS WON' : 'HELD'}.`,
        `${name(e.side)} gave up material and kept the position.`, e.side);
    } else if (e.kind === 'time') {
      add('time', e.ply, won(e.side) ? 80 : 65,
        won(e.side) ? 'UNDER THE CLOCK. THE WIN STILL CAME.' : 'UNDER THE CLOCK. NOBODY BLINKED.',
        'Both players had under ten seconds for eight moves in a row.', e.side);
    } else if (e.kind === 'swing') {
      add('swing', e.ply, 55 + Math.min(20, Math.floor((e.mag - SWING_MIN) / 50)),
        `A ${pawns(e.mag)}-POINT SWING IN ONE MOVE.`, `The evaluation moved ${pawns(e.mag)} pawns on one move.`, e.side);
    }
  }

  // upsets: the lower-rated side won a game that was over
  if (g.over && (g.winner === 'w' || g.winner === 'b')) {
    const loser = g.winner === 'w' ? 'b' : 'w', gap = elo(loser) - elo(g.winner);
    if (gap >= UPSET_GAP) {
      add('upset', g.lastPly || 0, 70 + Math.min(25, Math.floor(gap / 40)),
        `THE ${elo(loser)} FALLS. An unexpected upset.`,
        `${name(g.winner)} (${elo(g.winner)}) beat ${name(loser)} (${elo(loser)}), a gap of ${gap} rating points.`, g.winner);
    }
  }

  // streak breakers: the winner ended the loser's streak
  if (g.streak && g.over && g.streak.breakerSide && g.winner === g.streak.breakerSide) {
    const s = g.streak;
    add('streak', g.lastPly || 0, 75 + Math.min(20, s.len), `${s.len} WINS. ONE DEFEAT. A streak comes to an end.`,
      `${s.victim}'s ${s.len}-game winning streak ended here.`, g.streak.breakerSide);
  }
  return out;
}

// One reel per game: the strongest moment wins, so one game cannot fill the feed.
function oneEach(list) {
  const best = new Map();
  for (const h of list) {
    const cur = best.get(h.code);
    if (!cur || h.score > cur.score || (h.score === cur.score && h.at > cur.at)) best.set(h.code, h);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || b.at - a.at);
}

// The feed for one filter (or all), newest strongest first, one reel per game.
function feedOf(list, filter, now, limit) {
  const want = filter && filter !== 'all' ? FILTERS[filter] : null;
  const pool = list.filter((h) => (want ? h.kind === want : h.kind !== 'swing' || h.score >= 75));
  return oneEach(pool).slice(0, limit || 40);
}

// Trending: the strongest recent moments (last 48 hours), one per game.
function trending(list, now) {
  const recent = list.filter((h) => now - h.at < TRENDING_MS && h.score >= TRENDING_MIN);
  return oneEach(recent).slice(0, TRENDING_N);
}

module.exports = { candidates, feedOf, trending, oneEach, MIN_SCORE, UPSET_GAP, SWING_MIN, FILTERS, PIECE };
