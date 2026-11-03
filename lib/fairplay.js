// Fair play: how engine-like a player's moves are, for admins to review. Nothing here punishes anyone; it only flags.
// Each of the player's moves after the opening is checked with the analysis engine: did they play its first choice
// (match), and how many centipawns did their move lose against its best (average loss)? Engine users match far more
// often and lose far less than people do. Move times help too: an engine user tends to spend the same time on every
// move, easy or hard, so a low spread of move times is noted alongside.
const Chess = require('../public/chess.js');
const Engine = require('../public/engine.js');

const SKIP_PLIES = 16;          // the opening is book knowledge, not evidence
const MS_PER_MOVE = 60;         // engine time per position
const DECIDED = 600;            // once one side is this far ahead (centipawns), every sensible move wins: not counted
const MAX_LOSS = 500;           // one blunder shouldn't swamp the average
const same = (a, b) => a.from === b.from && a.to === b.to && (a.promo || null) === (b.promo || null);

// One game, one side. hist: [{ from, to, promo }], mt: ms spent per ply (optional).
// Returns { n, match, acpl, cv } (cv: spread of move times, null when unknown) or null when too short to judge.
function scanGame(hist, color, mt) {
  let st = Chess.initial();
  const history = [];
  let n = 0, hits = 0, loss = 0;
  const times = [];
  for (let i = 0; i < hist.length; i++) {
    const legal = Chess.legalMoves(st), h = hist[i];
    const m = legal.find((x) => same(x, h));
    if (!m) break;                                             // a bad record: judge what came before
    if (st.turn === color && i >= SKIP_PLIES && legal.length > 1) {
      Engine.clear();
      const a = Engine.analyze(st, MS_PER_MOVE, 12, { exact: false, focus: [m], history });
      const best = a.scores[0], mine = a.scores.find((x) => same(x.m, m));
      if (best && mine && Math.abs(best.s) < DECIDED) {
        n++;
        if (same(best.m, m) || mine.s >= best.s) hits++;
        loss += Math.min(MAX_LOSS, Math.max(0, best.s - mine.s));
        if (mt && mt[i] > 0) times.push(mt[i]);
      }
    }
    history.push(st);
    st = Chess.apply(st, m);
  }
  if (n < 8) return null;
  let cv = null;
  if (times.length >= 8) {
    const avg = times.reduce((s, x) => s + x, 0) / times.length;
    const sd = Math.sqrt(times.reduce((s, x) => s + (x - avg) ** 2, 0) / times.length);
    cv = avg ? Math.round((sd / avg) * 100) / 100 : null;
  }
  return { n, match: Math.round((hits / n) * 100), acpl: Math.round(loss / n), cv };
}

// The verdict over a player's scanned games. A single game can be a fluke; several together rarely are.
// Thresholds sit well past what strong humans manage against this engine (roughly 55-65% match, 25-60 average loss).
function verdict(scans) {
  const games = scans.filter(Boolean);
  const moves = games.reduce((s, g) => s + g.n, 0);
  if (!games.length) return { games: 0, moves: 0, match: null, acpl: null, flag: null };
  const match = Math.round(games.reduce((s, g) => s + g.match * g.n, 0) / moves);
  const acpl = Math.round(games.reduce((s, g) => s + g.acpl * g.n, 0) / moves);
  const steady = games.filter((g) => g.cv !== null && g.cv < 0.35).length;
  const blatant = games.filter((g) => g.n >= 15 && g.match >= 90 && g.acpl <= 8).length;
  let flag = null;
  if (blatant) flag = `${blatant} game${blatant > 1 ? 's' : ''} played almost exactly like the engine`;
  else if (games.length >= 3 && match >= 78 && acpl <= 18) flag = `engine-like over ${games.length} games (${match}% top move, ${acpl} average loss)`;
  if (flag && steady >= Math.ceil(games.length / 2)) flag += ', with unusually steady move times';
  return { games: games.length, moves, match, acpl, flag };
}

module.exports = { scanGame, verdict, SKIP_PLIES };
