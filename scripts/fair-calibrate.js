// Calibrate and benchmark the fair-play detector: node scripts/fair-calibrate.js
// Splits the labelled dataset (scripts/fixtures/fair-shards/*.json) by GAME into train (40%), validation (20%) and test (40%).
//   train       -> the human baselines and the standardisation of the game statistic (lib/fairmodel.js fit)
//   validation  -> the level thresholds (the loosest setting that flags no genuine game, plus a safety margin)
//   test        -> every reported number. Nothing here is tuned on it.
// Writes lib/fairbaseline.json, docs/fairplay-benchmark.json and docs/fairplay-benchmark.md.
const fs = require('fs'), path = require('path');
const M = require('../lib/fairmodel'), Trib = require('../lib/tribunal');
const dir = path.join(__dirname, 'fixtures', 'fair-shards');
const all = []; const files = fs.readdirSync(dir).filter((x) => x.endsWith('.json'));
const redone = new Set(); for (const f of files.filter((x) => x.startsWith('c'))) for (const s of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) redone.add(s.idx);   // games regenerated later replace the earlier version of the same game
for (const f of files) for (const s of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) if (f.startsWith('c') || !redone.has(s.idx)) all.push(s);
const split = (s) => { const k = s.idx % 5; return k <= 1 ? 'train' : k === 2 ? 'valid' : 'test'; };
const sets = { train: [], valid: [], test: [] }; for (const s of all) sets[split(s)].push(s);
const count = (a) => ({ games: new Set(a.map((s) => s.idx)).size, samples: a.length, human: a.filter((s) => s.label === 'human').length, cheat: a.filter((s) => s.label === 'cheat').length });
console.log('dataset', JSON.stringify({ train: count(sets.train), valid: count(sets.valid), test: count(sets.test) }));

// ---- fit on the train split (genuine samples only) ----
M.setBaseline(null);
const th0 = { ...M.DEFAULT_TH };
M.fit(sets.train.filter((s) => s.label === 'human'), sets.train.filter((s) => s.label === 'cheat'));
const B = M.base(); B.thresholds = { ...th0 };

const assessAll = (list) => list.map((s) => ({ s, a: M.assess(s.rows, { rating: s.R, tc: s.tc }) }));
const flags = (res, fn) => res.filter((r) => fn(r.a));
const rate = (a, b) => (b ? a / b : 0);

// ---- thresholds from the validation split ----
const val = assessAll(sets.valid);
const humansV = val.filter((r) => r.s.label === 'human'), cheatsV = val.filter((r) => r.s.label === 'cheat');
const minP = (arr) => arr.map((r) => r.a.p).sort((a, b) => a - b);
// level 3 (Suspicious): the loosest p that flags at most 1% of genuine validation games
let pS = 1e-4; for (const c of [2e-2, 1e-2, 5e-3, 2e-3, 1e-3, 5e-4, 2e-4, 1e-4]) { if (rate(humansV.filter((r) => r.a.p < c).length, humansV.length) <= 0.01) { pS = c; break; } }
// level 4 (High confidence): a tenth of that, and below every genuine validation game by two orders of magnitude
const lowestHuman = minP(humansV)[0] || 1;
const pH = Math.min(1e-4, pS / 10, lowestHuman / 100);
B.thresholds = { ...th0, pSuspicious: pS, pHigh: pH, pUnusual: 0.02 };
console.log('thresholds', JSON.stringify(B.thresholds), 'lowest genuine validation p', lowestHuman);

// ---- the old detector (production before this upgrade), on the same rows ----
function oldVerdict(s) {
  const rows = M.usable(s.rows).filter((r) => r.i >= (s.plies - 50));      // the old check looked at the last 50 plies only
  const n = rows.length;
  if (n < 8) return false;
  const hits = rows.filter(M.isHit).length, loss = rows.reduce((a, r) => a + Math.min(500, r.loss), 0);
  const t = rows.filter((r) => r.t > 0).map((r) => r.t); let cv = null;
  if (t.length >= 8) { const m = t.reduce((a, b) => a + b, 0) / t.length, sd = Math.sqrt(t.reduce((a, b) => a + (b - m) ** 2, 0) / t.length); cv = Math.round((sd / m) * 100) / 100; }
  const scan = { n, match: Math.round((hits / n) * 100), acpl: Math.round(loss / n), cv };
  return Trib.judge(scan, { ext: 0, tc: { base: { bullet: 60, blitz: 300, rapid: 600 }[s.tc] } }).strong;
}

// ---- evaluation on the held-out test split ----
const noTimes = (s) => ({ ...s, rows: s.rows.map((r) => [...r.slice(0, 7), 0]) });
const test = assessAll(sets.test).map((r) => ({ ...r, old: oldVerdict(r.s), a0: M.assess(noTimes(r.s).rows, { rating: r.s.R, tc: r.s.tc }) }));
function wilson(k, n) { if (!n) return [0, 0]; const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), w = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [Math.max(0, (c - w) / d), Math.min(1, (c + w) / d)]; }
function metrics(rs, pred) {
  const tp = rs.filter((r) => r.s.label === 'cheat' && pred(r)).length, fn = rs.filter((r) => r.s.label === 'cheat' && !pred(r)).length;
  const fp = rs.filter((r) => r.s.label === 'human' && pred(r)).length, tn = rs.filter((r) => r.s.label === 'human' && !pred(r)).length;
  return { tp, fn, fp, tn, precision: tp + fp ? tp / (tp + fp) : null, recall: rate(tp, tp + fn), fpr: rate(fp, fp + tn), fnr: rate(fn, tp + fn), fprCI: wilson(fp, fp + tn), recallCI: wilson(tp, tp + fn) };
}
const detectors = {
  'old (before this upgrade): automatic forfeit rule': (r) => r.old,
  'new: Suspicious or higher (goes to investigation)': (r) => r.a.level >= 3,
  'new: High-confidence (automatic forfeit allowed)': (r) => r.a.level >= 4,
  'new, move times withheld: Suspicious or higher': (r) => r.a0.level >= 3,
  'new, move times withheld: High-confidence': (r) => r.a0.level >= 4,
};
const report = { thresholds: B.thresholds, dataset: { train: count(sets.train), valid: count(sets.valid), test: count(sets.test) }, overall: {}, slices: {}, distribution: {}, history: null, depth: require('../lib/sfserver').ANALYSIS_DEPTH, multipv: require('../lib/sfserver').MULTIPV };
for (const [name, fn] of Object.entries(detectors)) report.overall[name] = metrics(test, fn);
const lenOf = (r) => (r.a.n < 20 ? 'under 20 positions' : r.a.n < 35 ? '20-34 positions' : '35+ positions');
const groups = { 'rating (genuine games)': (r) => r.s.R, 'time control': (r) => r.s.tc, 'game length': lenOf, 'cheat style': (r) => (r.s.label === 'cheat' ? r.s.kind : null) };
for (const [g, key] of Object.entries(groups)) {
  report.slices[g] = {};
  const ks = [...new Set(test.map(key).filter((x) => x !== null && x !== undefined))].sort();
  for (const k of ks) {
    const rs = test.filter((r) => key(r) === k && (g === 'rating (genuine games)' ? r.s.label === 'human' : g === 'cheat style' ? r.s.label === 'cheat' : true));
    report.slices[g][k] = Object.fromEntries(Object.entries(detectors).map(([name, fn]) => [name, { n: rs.length, flagged: rs.filter(fn).length, rate: rate(rs.filter(fn).length, rs.length) }]));
  }
}
const lv = (list) => [1, 2, 3, 4].map((l) => list.filter((r) => r.a.level === l).length);
report.distribution = { 'genuine (levels 1-4)': lv(test.filter((r) => r.s.label === 'human')), 'engine-assisted (levels 1-4)': lv(test.filter((r) => r.s.label === 'cheat')) };

// ---- history: does a change against a player's own past show up, and do steady players stay clear? ----
const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const r = rng(7), pick = (a) => a[Math.floor(r() * a.length)];
const hz = test.filter((x) => x.s.label === 'human' && x.a.Z !== null), cz = test.filter((x) => x.s.label === 'cheat' && x.a.Z !== null);
let honestFlagged = 0, honestSeries = 400, switched = 0, switchSeries = 200, delaySum = 0;
for (let i = 0; i < honestSeries; i++) { const ser = []; let hit = false; for (let g = 0; g < 40; g++) { ser.push({ Z: pick(hz).a.Z }); if (g >= 12 && M.historyShift(ser).significant) { hit = true; break; } } if (hit) honestFlagged++; }
for (let i = 0; i < switchSeries; i++) { const ser = []; let found = -1; for (let g = 0; g < 30; g++) { ser.push({ Z: (g < 15 ? pick(hz) : pick(cz)).a.Z }); if (g >= 15 && found < 0 && M.historyShift(ser).significant) found = g - 14; } if (found > 0) { switched++; delaySum += found; } }
report.history = { honestSeries, honestFlaggedEver: honestFlagged, honestFalseFlagRate: honestFlagged / honestSeries, switchSeries, switchDetected: switched, switchDetectionRate: switched / switchSeries, meanGamesAfterSwitch: switched ? delaySum / switched : null };

fs.writeFileSync(path.join(__dirname, '..', 'lib', 'fairbaseline.json'), JSON.stringify(B));
fs.mkdirSync(path.join(__dirname, '..', 'docs'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'docs', 'fairplay-benchmark.json'), JSON.stringify(report, null, 1));

const pc = (x) => (x === null ? 'n/a' : (x * 100).toFixed(1) + '%'), ci = (c) => `${(c[0] * 100).toFixed(1)}-${(c[1] * 100).toFixed(1)}%`;
let md = `# Fair-play detector benchmark (generated by scripts/fair-calibrate.js)\n\nSimulated players, held-out test split, analysis depth ${report.depth}, MultiPV ${report.multipv}. See docs/fairplay-detection.md for what this does and does not show.\n\n`;
md += `Dataset (samples = one side of one game): train ${JSON.stringify(report.dataset.train)}, validation ${JSON.stringify(report.dataset.valid)}, **test ${JSON.stringify(report.dataset.test)}**.\n\nThresholds (tuned on validation only): ${JSON.stringify(report.thresholds)}\n\n`;
md += `## Overall (test split)\n\n| Detector | Precision | Recall | False-positive rate (95% CI) | False-negative rate | TP | FP | FN | TN |\n|---|---|---|---|---|---|---|---|---|\n`;
for (const [n, m] of Object.entries(report.overall)) md += `| ${n} | ${pc(m.precision)} | ${pc(m.recall)} | ${pc(m.fpr)} (${ci(m.fprCI)}) | ${pc(m.fnr)} | ${m.tp} | ${m.fp} | ${m.fn} | ${m.tn} |\n`;
md += `\n## Slices (share flagged)\n`;
for (const [g, ks] of Object.entries(report.slices)) { md += `\n**${g}**\n\n| group | n | ${Object.keys(detectors).map((d) => d.split(':')[0] + ':' + d.split(':')[1].slice(0, 28)).join(' | ')} |\n|---|---|${Object.keys(detectors).map(() => '---').join('|')}|\n`; for (const [k, v] of Object.entries(ks)) md += `| ${k} | ${Object.values(v)[0].n} | ${Object.values(v).map((x) => `${x.flagged} (${pc(x.rate)})`).join(' | ')} |\n`; }
md += `\n## Level distribution (test)\n\n${JSON.stringify(report.distribution)}  (counts for Normal, Unusual, Suspicious, High-confidence)\n\n## History (change against a player's own past)\n\n${JSON.stringify(report.history)}\n`;
fs.writeFileSync(path.join(__dirname, '..', 'docs', 'fairplay-benchmark.md'), md);
console.log(md);
if (process.env.ROC) {
  for (const [nm, set] of [['valid', val], ['test', test]]) {
    const hs = set.filter((r) => r.s.label === 'human'), cs = set.filter((r) => r.s.label === 'cheat');
    console.log(nm, [0.05, 0.02, 0.01, 0.005, 0.002, 0.001, 1e-4].map((p) => `p<${p}: FPR ${(100 * hs.filter((r) => r.a.p < p).length / hs.length).toFixed(1)}% recall ${(100 * cs.filter((r) => r.a.p < p).length / cs.length).toFixed(0)}%`).join(' | '));
  }
}
