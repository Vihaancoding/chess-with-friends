// Server-wide tournaments: sign-ups, then group stages and/or a knockout bracket.
//   gko  groups, then the top players of each group go into a knockout bracket
//   ko   a straight knockout, seeded by rating (top seeds get byes when the field isn't a power of two)
//   rr   one round robin: everyone plays everyone, the table decides
// Every pairing ("fixture") is a head-to-head match (match.js) played in a normal room. Group fixtures can be
// drawn; knockout fixtures always produce a winner (a level best-of goes to Armageddon).
// Pure functions on a plain object, shared by the server (which stores it) and the page (window.Tour).
(function (root) {
  const KINDS = { gko: 'Groups + knockout', ko: 'Knockout', rr: 'Round robin' };
  const MIN = { gko: 4, ko: 2, rr: 3 }, MAX_PLAYERS = 64, MAX_RR = 12;
  const ROUND_NAMES = { 1: 'Final', 2: 'Semi-finals', 4: 'Quarter-finals', 8: 'Round of 16', 16: 'Round of 32', 32: 'Round of 64' };

  function clean(c) {
    c = c || {};
    const kind = KINDS[c.kind] ? c.kind : 'gko';
    const pick = (v, ok, d) => (ok.includes(+v) ? +v : d);
    return {
      kind,
      size: pick(c.size, [3, 4, 5, 6], 4),                     // players per group
      adv: pick(c.adv, [1, 2], 2),                             // who goes through from each group
      gn: pick(c.gn, [1, 3], 1),                               // group fixture: best of n, draws allowed
      kn: pick(c.kn, [1, 3, 5], 1),                            // knockout fixture: best of n, always a winner
      max: Math.min(kind === 'rr' ? MAX_RR : MAX_PLAYERS, pick(c.max, [4, 8, 12, 16, 32, 64], 16)),
    };
  }
  const groupFmt = (t) => ({ fmt: 'bo', n: t.cfg.gn, tie: true });
  const koFmt = (t) => ({ fmt: 'bo', n: t.cfg.kn });

  function create({ id, name, by, tc, cfg, now }) {
    return { id, name, by, tc: tc || null, cfg: clean(cfg), phase: 'signup', players: [], groups: null, ko: null, champion: null, created: now, started: null, ended: null };
  }

  function join(t, p) {
    if (t.phase !== 'signup') throw new Error('Sign-ups are closed.');
    if (t.players.some((x) => x.name === p.name)) return t;
    if (t.players.length >= t.cfg.max) throw new Error('The tournament is full.');
    t.players.push({ name: p.name, elo: p.elo | 0 });
    return t;
  }
  function leave(t, name) {
    if (t.phase !== 'signup') throw new Error('The tournament has started.');
    t.players = t.players.filter((x) => x.name !== name);
    return t;
  }

  const fx = (id, a, b, fmt) => ({ id, a, b, fmt, room: null, res: null, score: null, by: null });
  // everyone plays everyone once, in rounds (circle method), so nobody waits for one player's games to start theirs
  function roundRobin(names) {
    const p = names.length % 2 ? [...names, null] : [...names], n = p.length, out = [];
    for (let r = 0; r < n - 1; r++) {
      for (let i = 0; i < n / 2; i++) {
        const a = p[i], b = p[n - 1 - i];
        if (a && b) out.push(r % 2 ? [b, a] : [a, b]);
      }
      p.splice(1, 0, p.pop());
    }
    return out;
  }
  // bracket positions for seeds 1..n (n a power of two): 1 v n, and the top two seeds can only meet in the final
  function seedOrder(n) {
    let o = [1];
    while (o.length < n) { const m = o.length * 2 + 1; o = o.flatMap((s) => [s, m - s]); }
    return o;
  }

  function start(t, now) {
    const min = MIN[t.cfg.kind];
    if (t.phase !== 'signup') throw new Error('Already started.');
    if (t.players.length < min) throw new Error(`Needs at least ${min} players.`);
    const seeds = [...t.players].sort((a, b) => b.elo - a.elo || a.name.localeCompare(b.name)).map((x) => x.name);
    t.started = now;
    if (t.cfg.kind === 'ko') { buildKo(t, seeds); return t; }
    const ng = t.cfg.kind === 'rr' ? 1 : Math.max(2, Math.round(seeds.length / t.cfg.size));
    const groups = Array.from({ length: ng }, (_, i) => ({ name: String.fromCharCode(65 + i), players: [], fixtures: [] }));
    seeds.forEach((s, i) => { const r = Math.floor(i / ng), k = r % 2 ? ng - 1 - (i % ng) : i % ng; groups[k].players.push(s); });   // snake: groups of even strength
    for (const g of groups) g.fixtures = roundRobin(g.players).map(([a, b], i) => fx(`g${g.name}${i + 1}`, a, b, groupFmt(t)));
    t.groups = groups;
    t.phase = 'groups';
    return t;
  }

  // a group table: fixture points (win 1, draw ½), then game points, then head-to-head, then rating
  function standings(t, g) {
    const row = {};
    for (const n of g.players) row[n] = { name: n, pl: 0, w: 0, d: 0, l: 0, pts: 0, gp: 0 };
    for (const f of g.fixtures) {
      if (!f.res) continue;
      const A = row[f.a], B = row[f.b];
      A.pl++; B.pl++;
      if (f.res === 'draw') { A.d++; B.d++; A.pts += 0.5; B.pts += 0.5; }
      else { const [W, L] = f.res === 'a' ? [A, B] : [B, A]; W.w++; L.l++; W.pts += 1; }
      if (f.score) { A.gp += f.score[0]; B.gp += f.score[1]; }
    }
    const elo = Object.fromEntries(t.players.map((p) => [p.name, p.elo]));
    const h2h = (x, y) => { const f = g.fixtures.find((q) => q.res && ((q.a === x && q.b === y) || (q.a === y && q.b === x))); return !f || f.res === 'draw' ? 0 : (f.res === 'a') === (f.a === x) ? -1 : 1; };
    return Object.values(row).sort((x, y) => y.pts - x.pts || y.gp - x.gp || h2h(x.name, y.name) || (elo[y.name] || 0) - (elo[x.name] || 0) || x.name.localeCompare(y.name));
  }

  function buildKo(t, seeds, groupOf = {}) {
    let size = 2; while (size < seeds.length) size *= 2;
    const order = seedOrder(size), slot = order.map((s) => seeds[s - 1] || null);
    // keep players from the same group apart in the first round: swap the lower seed with another pair's lower seed
    const g = (x) => (x ? groupOf[x] || null : null), clash = (i) => !!g(slot[i]) && g(slot[i]) === g(slot[i + 1]);
    for (let i = 0; i < slot.length; i += 2) {
      if (!clash(i)) continue;
      for (let j = 0; j < slot.length; j += 2) {
        if (j === i || !slot[j + 1]) continue;
        [slot[i + 1], slot[j + 1]] = [slot[j + 1], slot[i + 1]];
        if (!clash(i) && !clash(j)) break;
        [slot[i + 1], slot[j + 1]] = [slot[j + 1], slot[i + 1]];
      }
    }
    const rounds = [];
    for (let n = size / 2, r = 0; n >= 1; n /= 2, r++) rounds.push(Array.from({ length: n }, (_, i) => fx(`k${r + 1}-${i + 1}`, r ? null : slot[2 * i], r ? null : slot[2 * i + 1], koFmt(t))));
    for (const f of rounds[0]) if (!f.a || !f.b) { f.res = f.a ? 'a' : 'b'; f.by = 'bye'; }
    t.ko = { rounds, seeds };
    t.phase = 'ko';
    advance(t);
  }

  const winnerOf = (f) => (f.res === 'a' ? f.a : f.res === 'b' ? f.b : null);
  // move winners into the next round; crown the champion after the final
  function advance(t) {
    const R = t.ko.rounds;
    for (let r = 0; r + 1 < R.length; r++) {
      R[r].forEach((f, i) => {
        const w = winnerOf(f), nx = R[r + 1][i >> 1];
        if (w && !nx[i % 2 ? 'b' : 'a']) nx[i % 2 ? 'b' : 'a'] = w;
      });
    }
    const fin = R[R.length - 1][0];
    if (winnerOf(fin)) { t.champion = winnerOf(fin); t.phase = 'done'; }
  }

  const allFixtures = (t) => [...(t.groups || []).flatMap((g) => g.fixtures), ...(t.ko ? t.ko.rounds.flat() : [])];
  const find = (t, id) => allFixtures(t).find((f) => f.id === id) || null;
  const ready = (f) => !!(f && f.a && f.b && !f.res);
  const stageOf = (t, f) => {
    if (f.id[0] === 'g') return t.cfg.kind === 'rr' ? 'Round robin' : `Group ${f.id[1]}`;
    const r = +f.id.slice(1).split('-')[0], n = t.ko.rounds[r - 1].length;
    return ROUND_NAMES[n] || `Round ${r}`;
  };

  // a fixture's result: res 'a' | 'b' | 'draw', score [a's game points, b's], by 'played' | 'awarded'
  function record(t, id, res, score, by, now) {
    const f = find(t, id);
    if (!f) throw new Error('No such match.');
    if (f.res) return false;
    if (!ready(f)) throw new Error('That match is not ready yet.');
    if (f.id[0] === 'k' && res === 'draw') throw new Error('A knockout match needs a winner.');
    f.res = res; f.by = by || 'played';
    f.score = score || (res === 'draw' ? [0.5, 0.5] : res === 'a' ? [1, 0] : [0, 1]);   // an awarded result counts like one game
    if (t.phase === 'groups' && t.groups.every((g) => g.fixtures.every((x) => x.res))) {
      if (t.cfg.kind === 'rr') { t.champion = standings(t, t.groups[0])[0].name; t.phase = 'done'; }
      else {
        // the top `adv` of each group: all group winners first (best first), then the runners-up
        const tables = t.groups.map((g) => standings(t, g)), groupOf = {}, q = [];
        t.groups.forEach((g) => g.players.forEach((n) => { groupOf[n] = g.name; }));
        const elo = (x) => (t.players.find((p) => p.name === x.name) || {}).elo || 0;
        const per = (x) => (x.pl ? x.pts / x.pl : 0), gper = (x) => (x.pl ? x.gp / x.pl : 0);   // groups can differ in size
        for (let k = 0; k < t.cfg.adv; k++) q.push(...tables.map((tb) => tb[k]).filter(Boolean).sort((x, y) => per(y) - per(x) || gper(y) - gper(x) || elo(y) - elo(x)).map((x) => x.name));
        buildKo(t, q, groupOf);
      }
    } else if (t.phase === 'ko') advance(t);
    if (t.phase === 'done') t.ended = now;
    return true;
  }

  // fixtures a player can play now
  const myFixtures = (t, name) => allFixtures(t).filter((f) => ready(f) && (f.a === name || f.b === name));

  const api = { KINDS, MIN, MAX_PLAYERS, ROUND_NAMES, clean, create, join, leave, start, standings, record, allFixtures, find, ready, stageOf, myFixtures, winnerOf, groupFmt, koFmt, seedOrder, roundRobin };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Tour = api;
})(typeof self !== 'undefined' ? self : this);
