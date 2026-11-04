// Tournaments: the engine (groups, standings, seeding, brackets, byes) and the API (sign-ups, playing fixtures in
// real rooms, results flowing back, the knockout filling in, permissions).
// Runs in-process with in-memory storage. Run: node scripts/test-tournament.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
process.env.ADMIN_KEY = 'test-admin-key';
const handler = require('../lib/app');
const Tour = require('../public/tournament.js');

let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };
function call(route, body, who) {
  return new Promise((resolve) => {
    const req = { method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body };
    const res = { setHeader() {}, writeHead(code) { this.code = code; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } };
    handler(req, res);
  });
}
const store0 = () => require('../lib/store');
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
const MATE = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];   // white mates
const tc = { base: 300, inc: 0 };

(async () => {
  console.log('engine');
  {
    ok('round robin: everyone meets once', (() => { const p = Tour.roundRobin(['a', 'b', 'c', 'd', 'e']); const k = new Set(p.map((x) => [...x].sort().join())); return p.length === 10 && k.size === 10; })());
    ok('seed order keeps 1 and 2 apart', Tour.seedOrder(8).join() === '1,8,4,5,2,7,3,6');
    for (const N of [4, 6, 9, 13, 16]) {
      const t = Tour.create({ id: 'x', name: 'x', by: 'p0', cfg: { kind: 'gko', size: 4, adv: 2 }, now: 1 });
      for (let i = 0; i < N; i++) Tour.join(t, { name: 'p' + i, elo: 2000 - i });
      Tour.start(t, 1);
      const g = {}; t.groups.forEach((x) => x.players.forEach((n) => { g[n] = x.name; }));
      for (const x of t.groups) for (const f of x.fixtures) Tour.record(t, f.id, +f.a.slice(1) < +f.b.slice(1) ? 'a' : 'b', [1, 0]);
      const r0 = t.ko.rounds[0];
      ok(`${N} players: ${t.groups.length} groups, a full bracket of ${r0.length * 2} (no byes), no group rematch in round 1`, !r0.some((f) => f.a && f.b && g[f.a] === g[f.b]) && t.ko.seeds.length === Tour.qualifySpots(t).P && Tour.pow2(r0.length * 2) === r0.length * 2 && !r0.some((f) => f.by === 'bye'), r0);
      while (t.phase === 'ko') { const f = Tour.allFixtures(t).find(Tour.ready); Tour.record(t, f.id, 'b', [0, 1]); }
      ok(`${N} players: a champion`, t.phase === 'done' && !!t.champion);
    }
    for (const [N, groups, bracket] of [[3, 1, 2], [5, 1, 4], [6, 2, 4], [7, 2, 4], [9, 3, 8], [12, 4, 8], [13, 4, 8]]) {
      const q = Tour.create({ id: 'q', name: 'q', by: 'p0', cfg: { kind: 'ko', max: 64 }, now: 1 });
      for (let i = 0; i < N; i++) Tour.join(q, { name: 'p' + i, elo: 2000 - i });
      Tour.start(q, 1);
      ok(`${N}-player knockout: qualifying groups first (${groups}), nobody sits out`, q.phase === 'groups' && q.groups.length === groups && q.groups.every((g) => g.fixtures.length) && Tour.stageOf(q, q.groups[0].fixtures[0]) === 'Qualifying group A', q.groups.map((g) => g.players));
      for (const g of q.groups) for (const f of g.fixtures) Tour.record(q, f.id, +f.a.slice(1) < +f.b.slice(1) ? 'a' : 'b');
      ok(`…then a full bracket of ${bracket}, no byes`, q.phase === 'ko' && q.ko.rounds[0].length * 2 === bracket && q.ko.rounds[0].every((f) => f.a && f.b && !f.by), q.ko.rounds[0]);
    }
    const k8 = Tour.create({ id: 'k8', name: 'k8', by: 'a', cfg: { kind: 'ko' }, now: 1 });
    for (let i = 0; i < 8; i++) Tour.join(k8, { name: 'p' + i, elo: 100 - i });
    Tour.start(k8, 1);
    ok('8 players: straight into the quarter-finals', k8.phase === 'ko' && !k8.groups && k8.ko.rounds[0].length === 4);
    const k = Tour.create({ id: 'k', name: 'k', by: 'a', cfg: { kind: 'ko' }, now: 1 });
    ['a', 'b'].forEach((n, i) => Tour.join(k, { name: n, elo: 100 - i }));
    Tour.start(k, 1);
    let threw = ''; try { Tour.record(k, Tour.allFixtures(k).find(Tour.ready).id, 'draw'); } catch (e) { threw = e.message; }
    ok('a knockout match cannot be drawn', /winner/.test(threw), threw);
    const r = Tour.create({ id: 'r', name: 'r', by: 'a', cfg: { kind: 'rr' }, now: 1 });
    ['a', 'b', 'c'].forEach((n) => Tour.join(r, { name: n, elo: 1 }));
    Tour.start(r, 1);
    const [f1, f2, f3] = r.groups[0].fixtures;
    Tour.record(r, f1.id, 'draw', [0.5, 0.5]); Tour.record(r, f2.id, 'a', [1, 0]); Tour.record(r, f3.id, 'draw', [0.5, 0.5]);
    const tb = Tour.standings(r, r.groups[0]);
    const cyc = Tour.create({ id: 'c', name: 'c', by: 'a', cfg: { kind: 'rr' }, now: 1 });
    ['a', 'b', 'c'].forEach((n) => Tour.join(cyc, { name: n, elo: 1 }));
    Tour.start(cyc, 1);
    for (const f of cyc.groups[0].fixtures) Tour.record(cyc, f.id, ({ ab: 'a', ba: 'b', bc: 'a', cb: 'b', ca: 'a', ac: 'b' })[f.a + f.b], null);   // a beats b, b beats c, c beats a
    const orders = new Set([0, 1, 2].map((k) => { const g = { ...cyc.groups[0], players: [...cyc.groups[0].players.slice(k), ...cyc.groups[0].players.slice(0, k)] }; return Tour.standings(cyc, g).map((x) => x.name).join(); }));
    ok('a three-way cycle sorts the same whatever the order (no head-to-head)', orders.size === 1 && [...orders][0] === 'a,b,c', [...orders]);
    ok('round robin crowns the top of the table', r.phase === 'done' && r.champion === tb[0].name && tb[0].pts === 1.5, tb);
  }

  console.log('sign-ups');
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = {};
  for (const n of ['ann', 'bob', 'cat', 'dan', 'eve', 'fay', 'gus']) P[n] = await su(n);
  let r = await call('tour_create', { name: 'Not allowed', tc }, P.ann);
  ok('only admins can create tournaments', r.status === 403 && /admin/i.test(r.error), r);
  for (const n of ['ann', 'cat']) await call('admin_claim', { key: 'test-admin-key' }, P[n]);
  r = await call('tour_list', {}, P.ann);
  ok('the list says who is an admin', r.admin === true && (await call('tour_list', {}, P.bob)).admin === false);
  r = await call('tour_create', { name: 'x', tc }, P.ann);
  ok('a name is required', r.status === 400);
  r = await call('tour_create', { name: 'Autumn Cup', tc, cfg: { kind: 'gko', size: 3, adv: 2, gn: 1, kn: 1, max: 8 } }, P.ann);
  const id = r.tour.id;
  ok('created, organizer signed up', r.tour.phase === 'signup' && r.tour.players.length === 1 && r.tour.by === 'ann', r.tour);
  r = await call('tour_start', { id }, P.ann);
  ok('cannot start below the minimum', r.status === 400 && /at least 4/.test(r.error), r);
  let inv = await call('me', {}, P.bob);
  ok('an open tournament shows as an invitation on the main page', inv.tourOpen.length === 1 && inv.tourOpen[0].id === id && inv.tourOpen[0].name === 'Autumn Cup' && inv.tourOpen[0].n === 1, inv.tourOpen);
  ok('…but not to players already in it', (await call('me', {}, P.ann)).tourOpen.length === 0);
  for (const n of ['bob', 'cat', 'dan', 'eve', 'fay']) await call('tour_join', { id }, P[n]);
  ok('joining removes the invitation', (await call('me', {}, P.bob)).tourOpen.length === 0);
  r = await call('tour_join', { id }, P.bob);
  ok('joining twice is harmless', r.tour.players.length === 6);
  await call('tour_leave', { id }, P.fay);
  r = await call('tour_list', {}, P.gus);
  ok('listed with its player count', r.tours.length === 1 && r.tours[0].n === 5 && r.tours[0].name === 'Autumn Cup', r.tours);
  await call('tour_join', { id }, P.fay);
  r = await call('tour_start', { id }, P.bob);
  ok('only the organizer can start', r.status === 403);
  r = await call('tour_start', { id }, P.ann);
  const t0 = r.tour;
  ok('started: two groups of three, three games each', t0.phase === 'groups' && t0.groups.length === 2 && t0.groups.every((g) => g.players.length === 3 && g.fixtures.length === 3), t0.groups);
  r = await call('tour_join', { id }, P.gus);
  ok('sign-ups closed', r.status === 400);

  console.log('playing group games in rooms');
  let me = await call('me', {}, P.ann);
  ok("the lobby lists ann's ready matches", me.tourNext.length >= 1 && me.tourNext.every((x) => x.id === id && x.name === 'Autumn Cup'), me.tourNext);
  const play = async (t, f) => {                             // the fixture's players open the room; white mates
    const a = await call('tour_play', { id, fx: f.id }, P[f.a]);
    const b = await call('tour_play', { id, fx: f.id }, P[f.b]);
    if (a.code !== b.code) throw new Error('players got different rooms');
    const room = await call('room', { code: a.code }, P[f.a]);
    for (const [i, u] of MATE.entries()) await call('move', { code: a.code, from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)) }, P[i % 2 ? room.players.b.name : room.players.w.name]);
    return { code: a.code, white: room.players.w.name, room };
  };
  const fA = t0.groups[0].fixtures[0];
  r = await call('tour_play', { id, fx: fA.id }, P.gus);
  ok('others cannot open a match room', r.status === 403);
  const g1 = await play(t0, fA);
  ok('the room is a tournament room', g1.room.tour && g1.room.tour.fx === fA.id && g1.room.match && g1.room.match.n === 1, g1.room.tour);
  r = await call('tour_get', { id }, P.gus);
  let f = Tour.find(r.tour, fA.id);
  ok('the result flows back to the tournament', f.res === (g1.white === f.a ? 'a' : 'b') && f.by === 'played' && f.score.join() === (g1.white === f.a ? '1,0' : '0,1'), f);
  r = await call('rematch', { code: g1.code }, P[f.a]);
  ok('no rematch once the tournament match is decided', r.status === 400, r);
  r = await call('tour_play', { id, fx: fA.id }, P[f.a]);
  ok('opening a decided match goes back to its room', r.code === g1.code, r);

  console.log('a drawn group game counts as a draw');
  const fB = t0.groups[0].fixtures[1];
  const a = await call('tour_play', { id, fx: fB.id }, P[fB.a]);
  const rb = await call('room', { code: a.code }, P[fB.a]);
  const W = P[rb.players.w.name], B = P[rb.players.b.name];
  await call('move', { code: a.code, from: sq('g1'), to: sq('f3') }, W); await call('move', { code: a.code, from: sq('g8'), to: sq('f6') }, B);
  await call('draw_offer', { code: a.code }, W); await call('draw_accept', { code: a.code }, B);
  r = await call('tour_get', { id }, P.ann);
  ok('drawn', Tour.find(r.tour, fB.id).res === 'draw', Tour.find(r.tour, fB.id));

  console.log('the organizer settles the rest');
  r = await call('tour_award', { id, fx: t0.groups[0].fixtures[2].id, res: 'a' }, P.bob);
  ok('only the organizer can award', r.status === 403);
  for (const x of [t0.groups[0].fixtures[2], ...t0.groups[1].fixtures]) {
    r = await call('tour_award', { id, fx: x.id, res: 'a' }, P.ann);
    if (r.status !== 200) throw new Error(r.error);
  }
  const t1 = r.tour;
  ok('groups done: the knockout is drawn up', t1.phase === 'ko' && t1.ko.rounds.length === 2 && t1.ko.rounds[0].every((x) => x.a && x.b), t1.ko);
  const gOf = {}; t1.groups.forEach((g) => g.players.forEach((n) => { gOf[n] = g.name; }));
  ok('group winners meet the other group\'s runner-up', t1.ko.rounds[0].every((x) => gOf[x.a] !== gOf[x.b]), t1.ko.rounds[0]);
  r = await call('tour_award', { id, fx: t1.ko.rounds[0][0].id, res: 'draw' }, P.ann);
  ok('a knockout match cannot be awarded as a draw', r.status === 400);

  console.log('knockout: a drawn single game goes to Armageddon');
  const s1 = t1.ko.rounds[0][0];
  const k1 = await call('tour_play', { id, fx: s1.id }, P[s1.a]);
  let kr = await call('room', { code: k1.code }, P[s1.a]);
  const kw = () => P[kr.players.w.name], kb = () => P[kr.players.b.name];
  await call('move', { code: k1.code, from: sq('g1'), to: sq('f3') }, kw()); await call('move', { code: k1.code, from: sq('g8'), to: sq('f6') }, kb());
  await call('draw_offer', { code: k1.code }, kw()); await call('draw_accept', { code: k1.code }, kb());
  kr = await call('room', { code: k1.code }, P[s1.a]);
  ok('not decided yet: Armageddon next', kr.match.arma && !kr.match.done, kr.match);
  await call('rematch', { code: k1.code }, P[s1.a]); await call('rematch', { code: k1.code }, P[s1.b]);
  kr = await call('room', { code: k1.code }, P[s1.a]);
  ok('the decider starts with Black on less time', kr.arma && kr.clock.b < kr.clock.w, kr.clock);
  const armaBlack = kr.players.b.name;
  await call('move', { code: k1.code, from: sq('g1'), to: sq('f3') }, kw()); await call('move', { code: k1.code, from: sq('g8'), to: sq('f6') }, kb());
  await call('draw_offer', { code: k1.code }, kw()); await call('draw_accept', { code: k1.code }, kb());
  r = await call('tour_get', { id }, P.ann);
  ok('Black goes through on the drawn Armageddon', Tour.winnerOf(Tour.find(r.tour, s1.id)) === armaBlack && r.tour.ko.rounds[1][0].a === armaBlack, [Tour.find(r.tour, s1.id), r.tour.ko.rounds[1][0]]);
  r = await call('match_end', { code: k1.code }, P[s1.a]);
  ok("tournament matches can't be ended early", r.status === 400, r);

  console.log('to the final');
  r = await call('tour_get', { id }, P.ann);
  const s2 = r.tour.ko.rounds[0][1];
  await call('tour_award', { id, fx: s2.id, res: 'b' }, P.ann);
  r = await call('tour_get', { id }, P.ann);
  const fin = r.tour.ko.rounds[1][0];
  ok('the final is set', fin.a === armaBlack && fin.b === s2.b, fin);
  r = await call('tour_delete', { id }, P.bob);
  ok('players cannot delete a tournament', r.status === 403);
  r = await call('tour_play', { id, fx: fin.id }, P.gus);
  ok('a spectator cannot open a match that has no room yet', r.status === 403, r);
  const live = await call('tour_play', { id, fx: fin.id }, P[fin.a]);
  r = await call('tour_play', { id, fx: fin.id }, P.gus);
  ok('…but can watch it once it is on', r.code === live.code, r);
  r = await call('tour_get', { id }, P.ann);
  const gf = await play(r.tour, fin);
  r = await call('tour_get', { id }, P.gus);
  ok('a champion', r.tour.phase === 'done' && r.tour.champion === gf.white && r.tour.ended > 0, [r.tour.phase, r.tour.champion]);
  r = await call('tour_list', {}, P.gus);
  ok('the list shows the champion', r.tours[0].phase === 'done' && r.tours[0].champion === gf.white);
  me = await call('me', {}, P.ann);
  ok('no matches left to play', me.tourNext.length === 0, me.tourNext);
  const ga = await call('games', { name: gf.white }, P[gf.white]);
  ok('tournament games are archived and rated like any other', ga.games.some((x) => x.code === gf.code && x.rated), ga.games.length);

  console.log('rooms that expired or were settled by hand');
  await require('../lib/store').del('room:' + g1.code);
  r = await call('tour_play', { id, fx: fA.id }, P[fA.a]);
  ok('a decided match whose room expired is not played again', r.status === 404, r);

  r = await call('tour_create', { name: 'Quick Cup', tc, cfg: { kind: 'ko', kn: 3 } }, P.cat);
  const q = r.tour.id;
  await call('tour_join', { id: q }, P.dan);
  r = await call('tour_start', { id: q }, P.cat);
  const qf = r.tour.ko.rounds[0][0];
  const qr = await call('tour_play', { id: q, fx: qf.id }, P.cat);
  await call('tour_award', { id: q, fx: qf.id, res: 'a' }, P.cat);
  const qroom = await call('room', { code: qr.code }, P.cat);
  ok('settling by hand closes the live room\'s match', qroom.match.done && qroom.tourDone !== false, qroom.match);
  r = await call('tour_get', { id: q }, P.cat);
  ok('…and the hand-set result stands', r.tour.phase === 'done' && r.tour.champion === qf.a, [r.tour.phase, r.tour.champion]);

  console.log('waiting for the opponent');
  {
    r = await call('tour_create', { name: 'Wait Cup', tc, cfg: { kind: 'rr' } }, P.ann);
    const wid = r.tour.id;
    for (const n of ['bob', 'cat']) await call('tour_join', { id: wid }, P[n]);
    r = await call('tour_start', { id: wid }, P.ann);
    ok('round robin fixtures know their round', r.tour.groups[0].fixtures.every((f) => f.r >= 1 && f.r <= 3), r.tour.groups[0].fixtures.map((f) => f.r));
    const me0 = await call('me', {}, P.ann);
    ok('the lobby offers only your next game per tournament', me0.tourNext.filter((x) => x.id === wid).length === 1, me0.tourNext);
    const wf = Tour.myFixtures(r.tour, 'ann')[0], opp = wf.a === 'ann' ? wf.b : wf.a;
    const pr = await call('tour_play', { id: wid, fx: wf.id }, P.ann);
    r = await call('tour_get', { id: wid }, P.ann);
    ok('pressing Play records that you are waiting', Tour.find(r.tour, wf.id).wait.n === 'ann', Tour.find(r.tour, wf.id).wait);
    const mo = await call('me', {}, P[opp]);
    ok('the opponent\'s lobby says ann is waiting', mo.tourNext.some((x) => x.fx === wf.id && x.wait > 0), mo.tourNext);
    ok('…but not your own', !(await call('me', {}, P.ann)).tourNext.some((x) => x.wait));
    r = await call('tour_remind', { id: wid, fx: wf.id }, P.ann);
    ok('a reminder right after is rate-limited', r.status === 429, r);
    r = await call('tour_remind', { id: wid, fx: wf.id }, P.gus);
    ok('only the players can remind', r.status === 403);
    const ws = await store0().get('tour:' + wid); Tour.find(ws, wf.id).wait.ts -= 31e3; await store0().set('tour:' + wid, ws);
    r = await call('tour_remind', { id: wid, fx: wf.id }, P.ann);
    ok('after 30 seconds you can remind again', r.ok, r);
    r = await call('tour_play', { id: wid, fx: wf.id }, P[opp]);
    ok('the opponent joins the same room', r.code === pr.code);
    await call('tour_delete', { id: wid }, P.ann);
  }

  console.log('match length: best of 3 for every pairing, changeable later');
  {
    r = await call('tour_create', { name: 'Len Cup', tc, cfg: { kind: 'gko', size: 3, gn: 3, kn: 3 } }, P.ann);
    const lid = r.tour.id;
    ok('best of 3 for groups and knockout', r.tour.cfg.gn === 3 && r.tour.cfg.kn === 3, r.tour.cfg);
    for (const n of ['bob', 'cat', 'dan']) await call('tour_join', { id: lid }, P[n]);
    r = await call('tour_start', { id: lid }, P.ann);
    ok('group games are best of 3 (draws allowed)', r.tour.groups.every((g) => g.fixtures.every((f) => f.fmt.n === 3 && f.fmt.tie)), r.tour.groups[0].fixtures[0].fmt);
    const lf = r.tour.groups[0].fixtures[0];
    const lr = await call('tour_play', { id: lid, fx: lf.id }, P[lf.a]);
    ok('their room plays best of 3', (await call('room', { code: lr.code }, P[lf.a])).match.n === 3);
    r = await call('tour_length', { id: lid, gn: 5, kn: 5 }, P.bob);
    ok('only the organizer changes the match length', r.status === 403);
    r = await call('tour_length', { id: lid, gn: 1, kn: 1 }, P.ann);
    const after = r.tour.groups.flatMap((g) => g.fixtures);
    ok('a change applies to the games that have not started', after.filter((f) => f.id !== lf.id).every((f) => f.fmt.n === 1) && Tour.find(r.tour, lf.id).fmt.n === 3, after.map((f) => f.fmt.n));
    r = await call('tour_get', { id: lid }, P.ann);
    ok('…and the chat says so', /Match length is now 1 game for games that haven't started/.test(r.chat[r.chat.length - 1].t), r.chat.slice(-1));
    for (const f of r.tour.groups.flatMap((g) => g.fixtures)) await call('tour_award', { id: lid, fx: f.id, res: 'a' }, P.ann);
    r = await call('tour_get', { id: lid }, P.ann);
    ok('the knockout uses the new length', r.tour.ko.rounds.flat().every((f) => f.fmt.n === 1), r.tour.ko.rounds.flat().map((f) => f.fmt));
    await call('tour_delete', { id: lid }, P.ann);
  }

  console.log('time control by vote');
  r = await call('tour_create', { name: 'Vote Cup', poll: [{ base: 60, inc: 0 }], cfg: { kind: 'ko' } }, P.ann);
  ok('a vote needs two options', r.status === 400, r);
  r = await call('tour_create', { name: 'Vote Cup', poll: [{ base: 180, inc: 2 }, { base: 600, inc: 0 }, { base: 180, inc: 2 }, null], cfg: { kind: 'ko' } }, P.ann);
  const vid = r.tour.id;
  ok('options are cleaned and de-duplicated; no time control yet', r.tour.poll.options.length === 3 && r.tour.poll.options[2] === null && r.tour.tc === null, r.tour.poll);
  inv = await call('me', {}, P.dan);
  ok('the invitation says it is a vote', inv.tourOpen.some((x) => x.id === vid && x.poll === true), inv.tourOpen);
  r = await call('tour_vote', { id: vid, i: 1 }, P.dan);
  ok('only signed-up players vote', r.status === 400 && /Join/.test(r.error), r);
  for (const n of ['bob', 'dan', 'eve']) await call('tour_join', { id: vid }, P[n]);
  await call('tour_vote', { id: vid, i: 0 }, P.ann);
  await call('tour_vote', { id: vid, i: 1 }, P.bob); await call('tour_vote', { id: vid, i: 0 }, P.bob);   // changed their mind
  await call('tour_vote', { id: vid, i: 1 }, P.dan); await call('tour_vote', { id: vid, i: 1 }, P.eve);
  r = await call('tour_vote', { id: vid, i: 7 }, P.eve);
  ok('a bad option is refused', r.status === 400);
  r = await call('tour_get', { id: vid }, P.ann);
  ok('votes are counted, one per player', require('../public/tournament.js').pollCounts(r.tour).join() === '2,2,0', r.tour.poll.votes);
  await call('tour_leave', { id: vid }, P.eve);
  r = await call('tour_start', { id: vid }, P.ann);
  ok('leaving drops the vote; most votes wins at the start', r.tour.tc && r.tour.tc.base === 180 && r.tour.tc.inc === 2 && r.tour.poll.chosen === 0, r.tour.poll);
  r = await call('tour_vote', { id: vid, i: 1 }, P.dan);
  ok('voting closes once it starts', r.status === 400);
  r = await call('tour_get', { id: vid }, P.ann);
  const vf = Tour.allFixtures(r.tour).find(Tour.ready);
  const vr = await call('tour_play', { id: vid, fx: vf.id }, P[vf.a]);
  const vroom = await call('room', { code: vr.code }, P[vf.a]);
  ok('the games use the voted time control', vroom.tc.base === 180 && vroom.tc.inc === 2 && vroom.cat === 'blitz', vroom.tc);
  await call('tour_delete', { id: vid }, P.ann);

  console.log('tournament chat and news');
  r = await call('tour_get', { id }, P.gus);
  const lines = r.chat.map((m) => m.t);
  ok('the chat has news lines for what happened', lines.some((x) => /bob joined/.test(x)) && lines.some((x) => /has started: 6 players/.test(x)) && lines.some((x) => /beat .* · Group/.test(x)) && lines.some((x) => /drew · Group/.test(x)) && lines.some((x) => /knockout bracket is drawn/.test(x)) && lines.some((x) => /🏆 .* wins Autumn Cup/.test(x)), lines);
  ok('hand-set results say so', lines.some((x) => /set by the organizer/.test(x)));
  ok('news lines are marked as system messages', r.chat.filter((m) => m.sys).length === r.chat.length);
  r = await call('tour_chat_send', { id, text: '  gg everyone  ' }, P.gus);
  ok('anyone signed in can chat', r.ok && r.msg.t === 'gg everyone' && r.msg.n === 'gus' && !r.msg.p, r);
  r = await call('tour_chat_send', { id, text: 'too fast' }, P.gus);
  ok('chat is throttled', r.status === 429);
  r = await call('tour_chat_send', { id, text: 'well played' }, P.bob);
  ok('players are marked', r.msg.p === 1);
  r = await call('tour_chat_send', { id, text: '' }, P.cat);
  ok('empty messages are refused', r.status === 400);
  r = await call('tour_get', { id }, P.ann);
  ok('messages come back with the tournament', r.chat.slice(-2).map((m) => m.t).join('|') === 'gg everyone|well played', r.chat.slice(-2));

  console.log('scheduled start');
  r = await call('tour_create', { name: 'Timed Cup', tc, startAt: Date.now() + 5000, cfg: { kind: 'ko' } }, P.ann);
  ok('a start time must be at least a minute away', r.status === 400, r);
  r = await call('tour_create', { name: 'Timed Cup', tc, startAt: Date.now() + 3600e3, cfg: { kind: 'ko' } }, P.ann);
  const sid = r.tour.id;
  ok('scheduled', r.tour.startAt > Date.now() && r.tour.phase === 'signup');
  ok('the invitation carries the start time', (await call('me', {}, P.dan)).tourOpen.some((x) => x.id === sid && x.startAt === r.tour.startAt));
  const store = require('../lib/store');
  const due = async () => {                                      // move the start time into the past (record and list)
    const t = await store.get('tour:' + sid), at = Date.now() - 1000; t.startAt = at; await store.set('tour:' + sid, t);
    const idx = await store.get('tours'); idx.list = idx.list.map((x) => (x.id === sid ? { ...x, startAt: at } : x)); await store.set('tours', idx);
  };
  await due();
  r = await call('tour_get', { id: sid }, P.dan);
  ok('too few players at the start time: it waits for the organizer', r.tour.phase === 'signup' && !r.tour.startAt && /needs at least 2 players/.test(r.chat[r.chat.length - 1].t), [r.tour.phase, r.chat.slice(-1)]);
  await call('tour_join', { id: sid }, P.dan);
  await due();
  r = await call('tour_list', {}, P.eve);
  ok('due tournaments start by themselves (from the list too)', r.tours.find((x) => x.id === sid).phase === 'ko', r.tours.find((x) => x.id === sid));
  r = await call('tour_get', { id: sid }, P.ann);
  ok('…with the news in the chat', r.chat.some((m) => /has started: 2 players/.test(m.t)) && r.tour.ko.rounds[0][0].a, r.chat.map((m) => m.t));
  await call('tour_delete', { id: sid }, P.ann);
  ok('deleting removes the chat too', !(await store.get('tchat:' + sid)));

  console.log('limits and clean-up');
  r = await call('tour_create', { name: 'Player Cup', tc }, P.bob);
  ok('players still cannot create one', r.status === 403);
  r = await call('tour_get', { id }, P.ann);
  ok('no invitation once it has started', !(await call('me', {}, P.gus)).tourOpen.some((x) => x.id === id));
  r = await call('tour_delete', { id }, P.bob);
  ok('only the organizer deletes', r.status === 403);
  r = await call('tour_delete', { id }, P.ann);
  ok('a finished tournament can be deleted', r.ok && (await call('tour_get', { id }, P.ann)).status === 404);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
