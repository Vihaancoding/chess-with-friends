// The fair-play statistical model. Pure functions: rows in (from lib/sfserver.js analyseGame), an assessment out.
//
// Idea: do not ask "did they play the engine's move?" (strong humans do that often). Ask instead "how surprising is this
// game for a player of THIS rating, in positions of THIS difficulty?" For every position the baseline knows how often a
// human of that rating plays the engine's first choice, how many centipawns they lose on average and how often they blunder,
// given how far the best move stands out from the second best (the position's difficulty). A game is then scored by
//   z_match   observed engine-first-choice moves against the expected number (a binomial z-score)
//   z_loss    observed centipawn loss against the expected loss
//   z_blunder how unlikely it is to make as few blunders as they did (Poisson)
// and the three are averaged. Real players are over-dispersed (good days and bad days), so the average is standardised
// against the spread of genuine games and its tail is read from the observed human distribution (an empirical survival
// curve with an exponential tail), giving p = the probability that a legitimate player of that rating does at least this
// well. Everything that depends on data lives in lib/fairbaseline.json, produced by scripts/fair-calibrate.js.
let BASE = null;
const base = () => BASE || (BASE = require('./fairbaseline.json'));          // a static require, so the deployment bundles the file
const setBaseline = (b) => { BASE = b; };

const BANDS = [800, 1200, 1600, 2000, 2400];
const GAP_EDGES = [15, 40, 100, 250];                    // difficulty buckets by how far the best move stands out
const DECIDED = 600, MAX_LOSS = 100, BLUNDER = 150;   // each move's loss counts up to 100 centipawns in the loss statistic; blunders are counted separately
const LEVELS = ['', 'Normal', 'Unusual', 'Suspicious', 'High-confidence suspected engine assistance', 'Confirmed violation following review'];

const gapBucket = (g) => { let b = 0; while (b < GAP_EDGES.length && g >= GAP_EDGES[b]) b++; return b; };
const objRow = (r) => (Array.isArray(r) ? { i: r[0], ev: r[1], rank: r[2], loss: r[3], gap: r[4], nl: r[5], tact: !!r[6], t: r[7] || null } : r);
const usable = (rows) => rows.map(objRow).filter((r) => r.nl > 1 && Math.abs(r.ev) < DECIDED);
const isHit = (r) => r.rank === 1 || r.loss <= 5;         // the engine's first choice, or an equally good move

// ---- normal distribution helpers ----
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }
const cdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function zFromP(p) {                                      // inverse of the upper tail, by bisection (rarely called)
  p = Math.min(1 - 1e-12, Math.max(1e-12, p));
  let lo = -8, hi = 8;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (1 - cdf(m) > p) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
function poissonCdf(k, lam) { let term = Math.exp(-lam), s = term; for (let i = 1; i <= k; i++) { term *= lam / i; s += term; } return Math.min(1, s); }

// ---- the baseline for a rating: interpolate between the two nearest bands ----
function expect(rating, r) {
  const B = base(), g = gapBucket(r.gap);
  const x = Math.min(BANDS[BANDS.length - 1], Math.max(BANDS[0], rating || 1500));
  let k = 0; while (k < BANDS.length - 2 && x > BANDS[k + 1]) k++;
  const w = (x - BANDS[k]) / (BANDS[k + 1] - BANDS[k]);
  const a = B.cells[BANDS[k]][g], b = B.cells[BANDS[k + 1]][g];
  const mix = (f) => a[f] * (1 - w) + b[f] * w;
  return { p: mix('p'), mu: mix('mu'), v: mix('v'), pb: mix('pb') };
}

// Spearman correlation (ranks) for the time-versus-difficulty signal
function rank(v) { const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]), out = new Array(v.length); idx.forEach(([, i], r) => { out[i] = r; }); return out; }
function spearman(a, b) { const ra = rank(a), rb = rank(b), n = a.length, ma = (n - 1) / 2; let sab = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { sab += (ra[i] - ma) * (rb[i] - ma); sa += (ra[i] - ma) ** 2; sb += (rb[i] - ma) ** 2; } return sa && sb ? sab / Math.sqrt(sa * sb) : 0; }
function timeStats(rows) {
  const t = rows.filter((r) => r.t > 0);
  if (t.length < 8) return null;
  const mean = t.reduce((s, r) => s + r.t, 0) / t.length, sd = Math.sqrt(t.reduce((s, r) => s + (r.t - mean) ** 2, 0) / t.length);
  return { cv: sd / mean, r: spearman(t.map((x) => Math.log(x.t)), t.map((x) => -Math.log(x.gap + 10))) };   // humans think longer when nothing stands out
}

// The game statistic: a weighted sum of the three z-scores. The weights are not guessed: scripts/fair-calibrate.js fits them
// (logistic regression, labelled training games only) to separate engine-assisted play from genuine play, and keeps them non-negative.
const clipZ = (z) => Math.max(-3, Math.min(8, z));
function combine(f) { const w = (base().w || [1, 1, 1, 0]); return w[0] * clipZ(f.zMatch) + w[1] * clipZ(f.zLoss) + w[2] * clipZ(f.zBlunder) + (w[3] || 0) * clipZ(f.zTime || 0); }

// ---- one game, one side: the raw statistics ----
function features(rowsIn, rating, tc) {
  const rows = usable(rowsIn), n = rows.length;
  if (!n) return { n: 0 };
  let hits = 0, ep = 0, vp = 0, loss = 0, el = 0, vl = 0, blunders = 0, lam = 0;
  const part = { t: { n: 0, hits: 0, ep: 0, vp: 0 }, p: { n: 0, hits: 0, ep: 0, vp: 0 } };
  const quarters = [0, 0, 0, 0].map(() => ({ n: 0, hits: 0, ep: 0, vp: 0 }));
  rows.forEach((r, i) => {
    const e = expect(rating, r), h = isHit(r) ? 1 : 0, L = Math.min(MAX_LOSS, r.loss);
    hits += h; ep += e.p; vp += e.p * (1 - e.p); loss += L; el += e.mu; vl += e.v; if (r.loss >= BLUNDER) blunders++; lam += e.pb;
    for (const q of [r.tact ? part.t : part.p, quarters[Math.min(3, Math.floor((i * 4) / n))]]) { q.n++; q.hits += h; q.ep += e.p; q.vp += e.p * (1 - e.p); }
  });
  const zm = (o, min = 5) => (o.n >= min && o.vp > 0 ? (o.hits - o.ep) / Math.sqrt(o.vp) : null);
  const f = {
    n, hits, match: hits / n, acpl: loss / n, blunders, expMatch: ep / n, expAcpl: el / n, expBlunders: lam,
    zMatch: vp > 0 ? (hits - ep) / Math.sqrt(vp) : 0,
    zLoss: vl > 0 ? (el - loss) / Math.sqrt(vl) : 0,
    zBlunder: zFromP(poissonCdf(blunders, Math.max(lam, 1e-9))),             // how unlikely it is to make this few blunders or fewer
    zTact: zm(part.t), zPos: zm(part.p), nTact: part.t.n, nPos: part.p.n,
    quarters: n >= 12 ? quarters.map((q) => zm(q, 3)) : null,
    time: timeStats(rows),
  };
  f.zTime = tc ? timeZ(f.time, tc) : null;
  f.T = combine(f);
  return f;
}

// the survival function of the standardised statistic among genuine games: P(a legitimate player does at least this well)
function survival(Z) {
  const S = base().surv;                                  // { knots: [[z, s]...] ascending in z, lambda }
  const k = S.knots;
  if (Z <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) if (Z <= k[i][0]) { const [z0, s0] = k[i - 1], [z1, s1] = k[i], w = (Z - z0) / (z1 - z0); return Math.exp(Math.log(s0) * (1 - w) + Math.log(s1) * w); }
  const [zl, sl] = k[k.length - 1];
  return Math.max(1e-12, sl * Math.exp(-S.lambda * (Z - zl)));
}
const standard = (T) => (T - base().T.mu) / base().T.sd;

function timeZ(time, tc) {
  const tb = base().time[tc] || base().time.blitz;
  if (!time || !tb) return null;
  const zc = (tb.cv.mu - time.cv) / tb.cv.sd, zr = (tb.r.mu - time.r) / tb.r.sd;       // steadier than people are, and unrelated to difficulty
  return ((zc + zr) / 2 - tb.z.mu) / tb.z.sd;
}

// ---- history: has this player got significantly better than their own past? ----
// entries: [{ Z }] oldest first (the standardised game statistic). Needs 8 earlier and 5 recent games.
const HIST = { earlier: 8, recent: 5 };
function historyShift(entries) {
  const z = entries.map((e) => e.Z).filter((x) => Number.isFinite(x));
  if (z.length < HIST.earlier + HIST.recent) return { enough: false, significant: false, n: z.length };
  const rec = z.slice(-HIST.recent), old = z.slice(0, -HIST.recent);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
  const mr = mean(rec), mo = mean(old), se = Math.sqrt(Math.max(sd(old), 0.5) ** 2 / old.length + Math.max(sd(rec), 0.5) ** 2 / rec.length);
  const t = (mr - mo) / se, p = 1 - cdf(t);
  const above = rec.filter((x) => x > 1).length;
  return { enough: true, n: z.length, recent: Math.round(mr * 100) / 100, earlier: Math.round(mo * 100) / 100, t: Math.round(t * 10) / 10, p, significant: p < 1e-3 && mr >= 1.5 && above >= 4 };
}

// ---- the assessment ----
// opts: { rating, tc: 'bullet'|'blitz'|'rapid', ext: engine-helper traces from their browser in this game, history: [{Z}] }
function assess(rowsIn, opts = {}) {
  const B = base(), th = B.thresholds, f = features(rowsIn, opts.rating, opts.tc);
  const out = { n: f.n, level: 1, label: LEVELS[1], p: 1, Z: null, evidence: [], corroboration: [], auto: false, investigate: false, features: f };
  if (f.n < th.minPositions) { out.evidence.push(`Only ${f.n} analysable positions: not enough to judge.`); return out; }
  const Z = standard(f.T), p = survival(Z), zt = f.zTime;
  out.Z = Math.round(Z * 100) / 100; out.p = p; out.zTime = zt === null ? null : Math.round(zt * 100) / 100;
  const pct = (x) => Math.round(x * 100);
  out.evidence.push(`${pct(f.match)}% engine-first-choice moves over ${f.n} non-trivial positions; a typical ${Math.round(opts.rating || 1500)}-rated player manages about ${pct(f.expMatch)}% in positions like these (z = ${f.zMatch.toFixed(1)}).`);
  out.evidence.push(`Average loss ${Math.round(f.acpl)} centipawns (each move counted up to ${MAX_LOSS}) against about ${Math.round(f.expAcpl)} expected (z = ${f.zLoss.toFixed(1)}).`);
  out.evidence.push(`${f.blunders} blunder${f.blunders === 1 ? '' : 's'} (a loss of ${BLUNDER}+ centipawns) where about ${f.expBlunders.toFixed(1)} would be expected (z = ${f.zBlunder.toFixed(1)}).`);
  out.evidence.push(`Probability that a legitimate player of this rating plays at least this well: ${p < 1e-9 ? '< 1 in a billion' : p < 0.001 ? '1 in ' + Math.round(1 / p).toLocaleString('en') : (p * 100).toFixed(1) + '%'}.`);
  // corroboration: independent ways the game agrees with the performance signal
  const c = out.corroboration;
  if (f.zTact !== null && f.zPos !== null && f.zTact >= 2 && f.zPos >= 2) c.push(`engine-like in both tactical (z = ${f.zTact.toFixed(1)}) and quiet (z = ${f.zPos.toFixed(1)}) positions`);
  if (f.quarters && f.quarters.filter((z) => z !== null && z > 0.5).length >= 3) c.push('sustained through the whole game, not one stretch');
  const timeNote = zt !== null && zt >= th.timeZ ? `move times unusually flat and unrelated to difficulty (z = ${zt.toFixed(1)}); this is already part of the score above, so it does not count as independent support` : null;
  if (opts.ext) c.push('an engine-helper trace was reported from their browser in this game');
  const hs = opts.history ? historyShift(opts.history) : null;
  if (hs && hs.significant) c.push(`performance jumped against their own history (${hs.earlier} to ${hs.recent}, p = ${hs.p.toExponential(1)})`);
  out.history = hs;
  if (timeNote) out.evidence.push(timeNote + '.');
  if (c.length) out.evidence.push('Independent supporting evidence: ' + c.join('; ') + '.');
  else out.evidence.push('Nothing else supports it: this alone is not enough for the highest levels.');
  // levels
  if (p < th.pUnusual) { out.level = 2; }
  if (p < th.pSuspicious) { out.level = f.n >= th.minPositionsSuspicious ? 3 : 2; }
  if (p < th.pHigh && f.n >= th.minPositionsHigh && c.length >= th.minCorroboration) out.level = 4;
  out.label = LEVELS[out.level];
  out.auto = out.level >= 4; out.investigate = out.level === 3;
  out.confidence = Math.round((1 - Math.max(p, 1e-9)) * 1e6) / 1e6;
  return out;
}

// ---- fitting the baseline from labelled human samples [{ R, tc, rows }] (used by scripts/fair-calibrate.js and re-calibration) ----
function fit(humans, cheats = []) {
  const nearest = (R) => BANDS.reduce((a, b) => (Math.abs(b - R) < Math.abs(a - R) ? b : a));
  const acc = {}; for (const b of BANDS) acc[b] = { all: { n: 0, h: 0, l: 0, l2: 0, bl: 0 }, g: [0, 1, 2, 3, 4, 5].map(() => ({ n: 0, h: 0, l: 0, l2: 0, bl: 0 })) };
  for (const s of humans) for (const r of usable(s.rows)) {
    const a = acc[nearest(s.R)], L = Math.min(MAX_LOSS, r.loss);
    for (const o of [a.all, a.g[gapBucket(r.gap)]]) { o.n++; o.h += isHit(r) ? 1 : 0; o.l += L; o.l2 += L * L; o.bl += r.loss >= BLUNDER ? 1 : 0; }
  }
  const cells = {}, PRIOR = 25;
  for (const b of BANDS) {
    const al = acc[b].all, pm = al.h / al.n, mu0 = al.l / al.n, v0 = Math.max(1, al.l2 / al.n - mu0 * mu0), pb0 = al.bl / al.n;
    cells[b] = acc[b].g.slice(0, GAP_EDGES.length + 1).map((c) => ({ p: (c.h + PRIOR * pm) / (c.n + PRIOR), mu: (c.l + PRIOR * mu0) / (c.n + PRIOR), v: Math.max(1, (c.l2 + PRIOR * (v0 + mu0 * mu0)) / (c.n + PRIOR) - ((c.l + PRIOR * mu0) / (c.n + PRIOR)) ** 2), pb: (c.bl + PRIOR * pb0) / (c.n + PRIOR), n: c.n }));
  }
  const prev = BASE; BASE = { cells, thresholds: prev ? prev.thresholds : DEFAULT_TH, surv: { knots: [[0, 1], [1, 0.5]], lambda: 1 }, T: { mu: 0, sd: 1 }, time: {}, w: [0.25, 0.25, 0.25, 0.25] };
  timeBaselines(humans);
  if (cheats.length) BASE.w = fitWeights(humans, cheats);
  // game statistic among genuine games -> mean, spread, survival curve
  const Ts = humans.map((s) => features(s.rows, s.R, s.tc)).filter((f) => f.n >= BASE.thresholds.minPositions).map((f) => f.T);
  const mu = Ts.reduce((a, b) => a + b, 0) / Ts.length, sd = Math.sqrt(Ts.reduce((a, b) => a + (b - mu) ** 2, 0) / Ts.length) || 1;
  const Zs = Ts.map((t) => (t - mu) / sd).sort((a, b) => a - b), q = (p) => Zs[Math.min(Zs.length - 1, Math.floor(p * Zs.length))];
  const levels = [0.5, 0.75, 0.9, 0.95, 0.98], knots = [[Zs[0] - 1, 1]];
  for (const l of levels) knots.push([q(l), 1 - l]);
  for (let i = 1; i < knots.length; i++) if (knots[i][0] <= knots[i - 1][0]) knots[i][0] = knots[i - 1][0] + 1e-6;
  const q90 = q(0.9), ex = Zs.filter((z) => z > q90).map((z) => z - q90);
  const lambda = ex.length ? 1 / Math.max(0.2, ex.reduce((a, b) => a + b, 0) / ex.length) : 1.5;
  BASE.T = { mu, sd }; BASE.surv = { knots, lambda };
  BASE.meta = { fittedOn: humans.length + ' genuine samples', at: new Date().toISOString().slice(0, 10) };
  return BASE;
}
// move-time baselines per time control (genuine games only)
function timeBaselines(humans) {
  for (const tc of ['bullet', 'blitz', 'rapid']) {
    const ts = humans.filter((s) => s.tc === tc).map((s) => timeStats(usable(s.rows))).filter(Boolean);
    if (ts.length < 5) continue;
    const m = (a) => a.reduce((x, y) => x + y, 0) / a.length, s = (a) => Math.sqrt(a.reduce((x, y) => x + (y - m(a)) ** 2, 0) / a.length) || 1;
    const cv = { mu: m(ts.map((t) => t.cv)), sd: s(ts.map((t) => t.cv)) }, r = { mu: m(ts.map((t) => t.r)), sd: s(ts.map((t) => t.r)) };
    const raw = ts.map((t) => ((cv.mu - t.cv) / cv.sd + (r.mu - t.r) / r.sd) / 2);
    BASE.time[tc] = { cv, r, z: { mu: m(raw), sd: s(raw) } };
  }
}
// logistic regression of 'engine-assisted' on the four z-scores (match, loss, blunders, move times) (gradient descent, a little L2); negative weights are dropped, the rest sum to 1
function fitWeights(humans, cheats) {
  const X = [], y = [];
  for (const [list, lab] of [[humans, 0], [cheats, 1]]) for (const s of list) { const f = features(s.rows, s.R, s.tc); if (f.n >= BASE.thresholds.minPositions) { X.push([clipZ(f.zMatch), clipZ(f.zLoss), clipZ(f.zBlunder), clipZ(f.zTime || 0)]); y.push(lab); } }
  let w = [0, 0, 0, 0], b = -1;
  for (let it = 0; it < 4000; it++) {
    const g = [0, 0, 0, 0]; let gb = 0;
    for (let i = 0; i < X.length; i++) { const p = 1 / (1 + Math.exp(-(b + w[0] * X[i][0] + w[1] * X[i][1] + w[2] * X[i][2] + w[3] * X[i][3]))), e = p - y[i]; for (let k = 0; k < 4; k++) g[k] += e * X[i][k]; gb += e; }
    for (let k = 0; k < 4; k++) w[k] -= 0.02 * (g[k] / X.length + 0.01 * w[k]); b -= 0.02 * gb / X.length;
  }
  w = w.map((x) => Math.max(0, x)); const sum = w.reduce((a, c) => a + c, 0) || 1;
  return w.map((x) => x / sum);
}
const DEFAULT_TH = { minPositions: 8, minPositionsSuspicious: 10, minPositionsHigh: 14, pUnusual: 0.02, pSuspicious: 1e-3, pHigh: 1e-5, timeZ: 2, minCorroboration: 2 };

module.exports = { assess, features, historyShift, fit, survival, standard, timeZ, setBaseline, base, usable, objRow, LEVELS, DEFAULT_TH, BANDS, HIST, isHit };
