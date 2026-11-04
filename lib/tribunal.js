// Fair-play tribunal: pure rules. When the engine check is sure enough a game is forfeited, a case opens, the community
// votes on a punishment, and the player can appeal to a second vote. Nothing here touches storage.
const OPTIONS = [
  { key: 'warn', label: 'Warning only', ms: 0 },
  { key: 'ban24h', label: '24-hour ban', ms: 24 * 3600e3 },
  { key: 'ban7d', label: '7-day ban', ms: 7 * 86400e3 },
  { key: 'ban30d', label: '30-day ban', ms: 30 * 86400e3 },
  { key: 'perm', label: 'Permanent ban', ms: Infinity },
];
const POLL_MS = 48 * 3600e3, APPEAL_MS = 48 * 3600e3;
const QUORUM = 3, QUORUM_HEAVY = 5;           // votes needed to apply any ban, and a ban of 7 days or more
const AUTO_CONF = 0.95;                       // the engine check must be this sure before a game is forfeited
const PERM_UNTIL = 8.64e15;

// How sure are we? Uncertainty counts: a single signal is never enough, and a window that is too short or too fast is ignored.
function judge(scan, { ext = 0, tc = null } = {}) {
  const out = { confidence: 0, strong: false, reasons: [] };
  if (!scan || scan.n < 18) { out.reasons.push('not enough moves to judge'); return out; }
  if (tc && tc.base < 120) { out.reasons.push('too fast to judge'); return out; }
  let c = 0;
  if (scan.match >= 94 && scan.acpl <= 5) { c = 0.9; out.reasons.push(`${scan.match}% top-engine moves, ${scan.acpl} average loss over ${scan.n} moves`); }
  else if (scan.match >= 90 && scan.acpl <= 8 && ext) { c = 0.88; out.reasons.push(`${scan.match}% top-engine moves, ${scan.acpl} average loss over ${scan.n} moves`); }
  if (!c) return out;
  if (scan.cv !== null && scan.cv < 0.35) { c += 0.05; out.reasons.push('unusually steady move times'); }
  if (ext) { c += 0.07; out.reasons.push('an engine-helper trace was reported from their browser in this game'); }
  out.confidence = Math.min(0.99, Math.round(c * 100) / 100);
  out.strong = out.confidence >= AUTO_CONF;
  return out;
}

// the announcement: configurable phrases, with a few guards (no threats, slurs or harassment of a person)
const DEFAULT_PHRASES = [
  '🚨 FAIR PLAY VIOLATION 🚨\n{name} has been caught using unfair engine assistance. No skill detected, they are a dog. The chess community is NOT impressed.',
  '🚨 FAIR PLAY VIOLATION 🚨\n{name} brought a robot to a human fight. The board has seen things. The community would like a word.',
  '🚨 FAIR PLAY VIOLATION 🚨\n{name} played like a computer because it was one. Forfeit served, popcorn out, vote below.',
];
const BAD = /\b(kill|die|dead|murder|rape|suicide|hang yourself|kys|hurt you|find you|your (family|mum|mom|dad|address)|n[i1]gg|f[a4]gg?|retard|tr[a4]nny|slut|whore)\w*/i;
function phraseProblem(p) {
  if (typeof p !== 'string') return 'Not text.';
  const t = p.trim();
  if (t.length < 10 || t.length > 300) return 'Phrases are 10 to 300 characters.';
  if (!t.includes('{name}')) return 'A phrase must contain {name}.';
  if (BAD.test(t)) return 'No threats, slurs or harassment.';
  return null;
}
const announceText = (phrases, name, seed) => {
  const list = (phrases && phrases.length ? phrases : DEFAULT_PHRASES);
  return list[Math.abs(seed | 0) % list.length].replace(/\{name\}/g, name);
};

// votes: { name: { o, ts } } -> counts and the winner (ties go to the lighter punishment)
function tally(votes, keys = OPTIONS.map((x) => x.key)) {
  const counts = Object.fromEntries(keys.map((k) => [k, 0]));
  let total = 0;
  for (const v of Object.values(votes || {})) if (v && k_in(counts, v.o)) { counts[v.o]++; total++; }
  let best = keys[0];
  for (const k of keys) if (counts[k] > counts[best]) best = k;
  return { counts, total, winner: total ? best : null };
}
const k_in = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// what the vote actually decides: too few voters means a warning only; fewer than the heavy quorum caps the ban at 24 hours
function decide(votes) {
  const t = tally(votes);
  let key = t.winner || 'warn';
  if (t.total < QUORUM) key = 'warn';
  else if (t.total < QUORUM_HEAVY && OPTIONS.findIndex((x) => x.key === key) > 1) key = 'ban24h';
  return { key, ...t };
}
const untilOf = (key, now) => { const o = OPTIONS.find((x) => x.key === key); return !o || !o.ms ? 0 : o.ms === Infinity ? PERM_UNTIL : now + o.ms; };

module.exports = { OPTIONS, POLL_MS, APPEAL_MS, QUORUM, QUORUM_HEAVY, AUTO_CONF, PERM_UNTIL, judge, DEFAULT_PHRASES, phraseProblem, announceText, tally, decide, untilOf };
