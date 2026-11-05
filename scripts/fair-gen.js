// Builds the labelled dataset: node scripts/fair-gen.js <shard> <shards> [perBand] [perCombo]  ->  scripts/fixtures/fair-shards/<shard>.json
process.env.FAIR_SF_TIMEOUT_MS = process.env.FAIR_SF_TIMEOUT_MS || '120000';
// Every game is played by the simulator (scripts/fair-sim.js) and analysed with Stockfish exactly as the live detector does.
const fs = require('fs'), path = require('path');
const Sim = require('./fair-sim'), Sf = require('../lib/sfserver');
const [shard, shards, perBand, perCombo] = [+process.argv[2] || 0, +process.argv[3] || 1, +process.argv[4] || 40, +process.argv[5] || 12];
const cheatOnly = process.argv[6] === 'cheat-only';                       // regenerate only the engine-assisted games (written to c<shard>.json)
const specs = [];
const r0 = Sim.rng(20260101);
const tcs = ['bullet', 'blitz', 'rapid'];
for (const R of Sim.BANDS) for (let i = 0; i < perBand; i++) specs.push({ kind: 'human', R });
for (const kind of ['full', 'critical', 'evade', 'mix']) for (const R of [1200, 1600, 2000]) for (let i = 0; i < perCombo; i++) specs.push({ kind, R });
for (let i = specs.length - 1; i > 0; i--) { const j = Math.floor(r0() * (i + 1)); [specs[i], specs[j]] = [specs[j], specs[i]]; }
specs.forEach((s, i) => { s.idx = i; s.tc = tcs[Math.floor(r0() * 3)]; s.maxPlies = 50 + Math.floor(r0() * 60); s.color = r0() < 0.5 ? 'w' : 'b'; s.oppR = Math.max(800, Math.min(2400, s.R + Math.round((r0() - 0.5) * 8) * 50)); });
(async () => {
  const out = [], t0 = Date.now();
  const save = () => { fs.mkdirSync(path.join(__dirname, 'fixtures', 'fair-shards'), { recursive: true }); fs.writeFileSync(path.join(__dirname, 'fixtures', 'fair-shards', `${cheatOnly ? 'c' : ''}${shard}.json`), JSON.stringify(out)); };
  for (const s of specs.filter((x) => x.idx % shards === shard && (!cheatOnly || x.kind !== 'human'))) {
   try {
    const g = await Sim.playGame({ seed: (cheatOnly ? 9000 : 1000) + s.idx, subject: { kind: s.kind, R: s.R }, opp: { R: s.oppR }, tc: s.tc, maxPlies: s.maxPlies, subjectColor: s.color });
    const an = await Sf.analyseGame(g.hist, { mt: g.mt });
    for (const c of ['w', 'b']) {
      const subj = c === s.color;
      out.push({ idx: s.idx, color: c, label: subj && s.kind !== 'human' ? 'cheat' : 'human', kind: subj ? s.kind : 'human', R: subj ? s.R : s.oppR, tc: s.tc, plies: g.hist.length,
        rows: an.rows.filter((x) => x.c === c).map((x) => [x.i, x.ev, x.rank, x.loss, x.gap, x.nl, x.tact ? 1 : 0, x.t || 0]) });
    }
    save();
    if (out.length % 20 === 0) console.error(`shard ${shard}: ${out.length / 2} games, ${Math.round((Date.now() - t0) / 1000)}s`);
   } catch (e) { console.error('game', s.idx, 'skipped:', e.message); }
  }
  fs.mkdirSync(path.join(__dirname, 'fixtures', 'fair-shards'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'fixtures', 'fair-shards', `${cheatOnly ? 'c' : ''}${shard}.json`), JSON.stringify(out));
  console.error(`shard ${shard} done: ${out.length / 2} games in ${Math.round((Date.now() - t0) / 1000)}s`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
