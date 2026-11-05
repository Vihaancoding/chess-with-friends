// The detector's plumbing: analyse a game with Stockfish (cached, resumable), assess each side with the statistical model
// (lib/fairmodel.js), keep each player's history, and decide what a result means. The decisions are policy, written here:
//   level 1-2  nothing happens (the assessment is kept for the admin dashboard)
//   level 3    Suspicious: an investigation is opened for admins; nobody else is told and nothing is enforced
//   level 4    High-confidence: the only level allowed to forfeit a live game automatically
//   level 5    Confirmed: set only by a finished tribunal (a ban that was applied and not overturned)
const store = require('./store');
const Sf = require('./sfserver');
const Model = require('./fairmodel');

const DAY = 86400;
const HIST_MAX = 60;
const tcClass = (tc) => { const est = ((tc && tc.base) || 0) + 40 * ((tc && tc.inc) || 0); return est < 180 ? 'bullet' : est < 480 ? 'blitz' : 'rapid'; };

// Analyse (or finish analysing) a game. Evaluations are cached per game, so a repeat call, a later check of the same
// game, or the post-game analysis never searches a position twice. budgetMs stops early; the next call carries on.
async function analyse(gid, hist, mt, { budgetMs = 25000, deps = {} } = {}) {
  if (deps.analyse) return deps.analyse(hist, mt);
  const rec = (await store.get('fan:' + gid)) || { d: Sf.ANALYSIS_DEPTH, rows: {} };
  const r = await Sf.analyseGame(hist, { mt, cache: rec.rows, budgetMs, depth: rec.d });
  await store.set('fan:' + gid, rec, 30 * DAY);
  return r;
}

const histKey = (name) => 'fhist:' + name.toLowerCase();
async function history(name) { const v = await store.get(histKey(name)); return Array.isArray(v) ? v : []; }
async function addHistory(name, entry) {
  const list = (await history(name)).filter((e) => e.id !== entry.id);
  list.push(entry); list.sort((a, b) => a.at - b.at);
  await store.set(histKey(name), list.slice(-HIST_MAX), 400 * DAY);
}

// One side of a game. Two steps so that the history test sees this game's own result: score it, then ask whether that
// score is a significant jump against the player's earlier games.
function assessSide(rows, color, { rating, tc, ext = 0, prior = [] }) {
  const mine = rows.filter((r) => r.c === color);
  const first = Model.assess(mine, { rating, tc: tcClass(tc), ext });
  if (first.Z === null) return first;
  const seq = [...prior.map((e) => ({ Z: e.Z })), { Z: first.Z }], shift = Model.historyShift(seq);
  return shift.significant ? Model.assess(mine, { rating, tc: tcClass(tc), ext, history: seq }) : { ...first, history: shift };
}
// the small, storable summary of an assessment (the full evidence stays with whoever opened a case)
const summary = (a) => ({ level: a.level, label: a.label, p: a.p, Z: a.Z, n: a.n, evidence: a.evidence, corroboration: a.corroboration });

module.exports = { analyse, history, addHistory, assessSide, summary, tcClass, histKey };
