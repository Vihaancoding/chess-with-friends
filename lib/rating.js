// Ratings: Glicko-2 (Glickman, "Example of the Glicko-2 system"), one game per rating period like lichess.
// Every rating has a value (r), a deviation (rd: how unsure we are) and a volatility (vol).
// New players start with a large rd, so their first games move the rating a lot ("provisional");
// as rd shrinks with games played, changes settle to a few points per game.
const SCALE = 173.7178;
const TAU = 0.5;                 // limits how fast volatility can change
const START = { r: 1200, rd: 350, vol: 0.06 };
const MAX_RD = 350, MIN_RD = 45, PROVISIONAL_RD = 110, FLOOR = 100;
const DAY = 86400e3;
const CATS = ['bullet', 'blitz', 'rapid', 'classical'];

// Time-control category, using the usual "estimated game length" rule: base + 40 x increment (seconds).
function category(tc) {
  if (!tc) return 'classical';                      // untimed games count as classical
  const est = tc.base + 40 * tc.inc;
  return est < 180 ? 'bullet' : est < 480 ? 'blitz' : est < 1500 ? 'rapid' : 'classical';
}

const g = (phi) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const E = (mu, muj, phij) => 1 / (1 + Math.exp(-g(phij) * (mu - muj)));

// player: {r, rd, vol}; games: [{r, rd, s}] (s = 1 win, 0.5 draw, 0 loss); idle: rating periods without games.
function update(player, games, idle = 0) {
  const mu = (player.r - 1500) / SCALE, sigma = player.vol;
  let phi = player.rd / SCALE;
  if (idle > 0) phi = Math.min(MAX_RD / SCALE, Math.sqrt(phi * phi + idle * sigma * sigma)); // inactivity widens rd
  if (!games.length) return { r: player.r, rd: phi * SCALE, vol: sigma };

  let vInv = 0, dSum = 0;
  for (const o of games) {
    const muj = (o.r - 1500) / SCALE, phij = o.rd / SCALE, gj = g(phij), e = E(mu, muj, phij);
    vInv += gj * gj * e * (1 - e);
    dSum += gj * (o.s - e);
  }
  const v = 1 / vInv, delta = v * dSum;

  // new volatility (Illinois algorithm, step 5 of the paper)
  const a = Math.log(sigma * sigma);
  const f = (x) => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * Math.pow(phi * phi + v + ex, 2)) - (x - a) / (TAU * TAU);
  };
  let A = a, B;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else { let k = 1; while (f(a - k * TAU) < 0) k++; B = a - k * TAU; }
  let fA = f(A), fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
    const C = A + ((A - B) * fA) / (fB - fA), fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else fA /= 2;
    B = C; fB = fC;
  }
  const vol = Math.exp(A / 2);
  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * dSum;
  return { r: muNew * SCALE + 1500, rd: phiNew * SCALE, vol };
}

// One rated game between a and b (full rating records). s = a's score. Returns both new records.
function rateGame(a, b, s, now = Date.now()) {
  const idle = (p) => (p.last ? Math.min(365, Math.floor((now - p.last) / DAY)) : 0);
  const na = update(a, [{ r: b.r, rd: b.rd, s }], idle(a));
  const nb = update(b, [{ r: a.r, rd: a.rd, s: 1 - s }], idle(b));
  const fix = (old, n, score) => {
    const r = Math.max(FLOOR, n.r), rd = Math.min(MAX_RD, Math.max(MIN_RD, n.rd));
    const games = (old.n || 0) + 1;
    return {
      ...old, r, rd, vol: n.vol, n: games, last: now,
      w: (old.w || 0) + (score === 1 ? 1 : 0), l: (old.l || 0) + (score === 0 ? 1 : 0), d: (old.d || 0) + (score === 0.5 ? 1 : 0),
      peak: Math.max(old.peak || 0, Math.round(r)),
      hist: [...(old.hist || []), [now, Math.round(r)]].slice(-150),
    };
  };
  return [fix(a, na, s), fix(b, nb, 1 - s)];
}

// A user's rating record for a category, creating it (and migrating the old single Elo) on first use.
function ratingOf(user, cat) {
  const rec = user.ratings && user.ratings[cat];
  if (rec) return rec;
  const played = (user.w || 0) + (user.l || 0) + (user.d || 0);
  if (!user.ratings && played && user.elo) return { r: user.elo, rd: 200, vol: START.vol, n: 0 };   // seeded from the old rating, still provisional
  return { ...START, n: 0 };
}
const provisional = (rec) => rec.rd > PROVISIONAL_RD;
const show = (rec) => ({ r: Math.round(rec.r), prov: provisional(rec), n: rec.n || 0 });
const summary = (user) => Object.fromEntries(CATS.map((c) => [c, show(ratingOf(user, c))]));
const expected = (a, b) => E((a.r - 1500) / SCALE, (b.r - 1500) / SCALE, Math.hypot(a.rd, b.rd) / SCALE);

module.exports = { CATS, START, PROVISIONAL_RD, category, update, rateGame, ratingOf, provisional, show, summary, expected };
