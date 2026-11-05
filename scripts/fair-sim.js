// A seeded simulator of players, for building a LABELLED dataset to calibrate and test the fair-play detector.
// It is a model of people, not people: every number below is an assumption (documented in docs/fairplay-detection.md).
//  - Human at rating R: picks among the engine's top lines with a softmax whose temperature falls with rating, with a
//    rating-dependent chance of a blunder (a random other move) and a per-game "form" factor (good and bad days).
//  - Engine-assisted player: plays the engine's choice all the time ('full'), only in critical positions ('critical'),
//    among near-equal engine moves with human-like move times ('evade'), or on about half the moves ('mix').
// Move times follow the time control, slower in hard positions for humans, flat for engine users (except 'evade').
const Chess = require('../public/chess.js');
const Sf = require('../lib/sfserver');

const TCS = { bullet: { base: 60, mean: 1200 }, blitz: { base: 300, mean: 5000 }, rapid: { base: 600, mean: 12000 } };
const BANDS = [800, 1200, 1600, 2000, 2400];
const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const norm = (r) => { let u = 0, v = 0; while (!u) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
// how a person of rating R chooses (assumptions, tuned so average loss lands near commonly quoted levels per band)
const TEMP = (R) => 10 + (2500 - R) * 0.115;           // centipawns of softmax temperature
const BLUN = (R) => 0.004 + Math.max(0, 2400 - R) * 0.00007;
const TCMUL = { bullet: 1.5, blitz: 1.15, rapid: 1 };  // faster time controls play worse

const uciOf = Sf.uciOf;
async function chooseHuman(lines, R, tc, form, r) {
  const T = TEMP(R) * TCMUL[tc] * form, pb = Math.min(0.3, BLUN(R) * TCMUL[tc] * form);
  if (r() < pb) return lines[Math.floor(r() * lines.length)].move;                 // a slip: any of the shown lines (a mild one)
  const best = lines[0].cp, w = lines.map((l) => Math.exp(-(best - l.cp) / T));
  let x = r() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < w.length; i++) { x -= w[i]; if (x <= 0) return lines[i].move; }
  return lines[0].move;
}
function timeOf(kind, tc, gap, nl, r) {
  const m = TCS[tc].mean;
  const hard = gap < 30 ? 1.7 : gap > 200 ? 0.55 : 1;                                // people think longer when nothing stands out
  const human = m * hard * Math.exp(norm(r) * 0.75) * (nl < 6 ? 0.5 : 1);
  if (kind === 'full' || kind === 'critical' || kind === 'mix') return Math.max(200, m * 0.9 * Math.exp(norm(r) * 0.18));   // steady: read the engine, play it
  return Math.max(150, human);                                                         // humans, and cheaters who randomise their times
}

// one game. subject: { kind: 'human'|'full'|'critical'|'evade'|'mix', R }, opp: { R }. Returns the moves and times.
async function playGame({ seed, subject, opp, tc, maxPlies, subjectColor }) {
  const r = rng(seed);
  const form = { w: Math.exp(norm(r) * 0.22), b: Math.exp(norm(r) * 0.22) };
  const plan = { w: subjectColor === 'w' ? subject : { kind: 'human', R: opp.R }, b: subjectColor === 'b' ? subject : { kind: 'human', R: opp.R } };
  let st = Chess.initial();
  const uci = [], hist = [], mt = [];
  let lastEv = 0, decided = 0;
  for (let i = 0; i < maxPlies; i++) {
    const stt = Chess.status(st);
    if (stt.over) break;
    const legal = Chess.legalMoves(st);
    const lines = await Sf.runAnalysis(uci, { depth: 8, multipv: Math.min(6, legal.length), fresh: i === 0 });
    if (!lines.length) break;
    const who = plan[st.turn], gap = lines[1] ? lines[0].cp - lines[1].cp : 500, ev = lines[0].cp;
    let mv;
    if (i < 6) {                                                                     // varied openings: any of the near-equal top lines
      const ok = lines.filter((l) => lines[0].cp - l.cp <= 60); mv = ok[Math.floor(r() * ok.length)].move;
    } else if (who.kind === 'human') mv = await chooseHuman(lines, who.R, tc, form[st.turn], r);
    else {
      // the engine behind the assistant: a search as deep as the analysis. It agrees with the analysis most of the time (88%) and
      // otherwise picks its second line, as a different depth, hash or version would.
      const deep = async () => Sf.runAnalysis(uci, { depth: Sf.ANALYSIS_DEPTH, multipv: 3 });
      const top = (d) => (r() < 0.88 ? d[0].move : (d[1] || d[0]).move);
      if (who.kind === 'full') mv = top(await deep());
      else if (who.kind === 'critical') mv = (gap >= 100 || Math.abs(ev - lastEv) >= 150) ? top(await deep()) : await chooseHuman(lines, who.R, tc, form[st.turn], r);
      else if (who.kind === 'evade') { const d = await deep(), ok = d.filter((l) => d[0].cp - l.cp <= 25); mv = ok[Math.floor(r() * ok.length)].move; }
      else mv = r() < 0.5 ? top(await deep()) : await chooseHuman(lines, who.R, tc, form[st.turn], r);   // mix
    }
    const m = legal.find((x) => uciOf(x) === mv) || legal[0];
    hist.push({ from: m.from, to: m.to, promo: m.promo }); uci.push(uciOf(m));
    mt.push(Math.round(timeOf(who.kind, tc, gap, legal.length, r)));
    st = Chess.apply(st, m);
    lastEv = ev;
    decided = Math.abs(ev) > 900 ? decided + 1 : 0;
    if (decided >= 8) break;                                                          // a resignation
  }
  return { hist, mt };
}
module.exports = { playGame, rng, TCS, BANDS };
