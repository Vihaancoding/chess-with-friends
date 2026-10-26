// Head-to-head matches: best of n, first to n wins, marathon, the Armageddon decider, challenges and stopping early.
// Drives the real API in-process with in-memory storage. Run: node scripts/test-match.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
const handler = require('../lib/app');
const Match = require('../public/match.js');

let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };

function call(route, body, who) {
  return new Promise((resolve) => {
    const req = { method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body };
    const res = { writeHead(code) { this.code = code; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } };
    handler(req, res);
  });
}
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
const MATE = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];   // white mates
const tc = { base: 300, inc: 0 };

(async () => {
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const ann = await su('ann'), bob = await su('bob'), cat = await su('cat');
  const by = { ann, bob, cat };
  const room = async (code, who = ann) => call('room', { code }, who);
  const seats = async (code) => { const r = await room(code); return { w: by[r.players.w.name], b: by[r.players.b.name] }; };
  const play = async (code, ucis) => {
    const s = await seats(code);
    for (let i = 0; i < ucis.length; i++) {
      const u = ucis[i];
      const r = await call('move', { code, from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)) }, i % 2 ? s.b : s.w);
      if (!r.ok) throw new Error('move failed: ' + r.error);
    }
  };
  const whiteWins = (code) => play(code, MATE);
  const draw = async (code) => { const s = await seats(code); await play(code, ['g1f3', 'g8f6']); await call('draw_offer', { code }, s.w); await call('draw_accept', { code }, s.b); };
  const next = async (code) => { await call('rematch', { code }, ann); await call('rematch', { code }, bob); };
  const pts = (r) => Match.score(r.match).pts;

  console.log('formats');
  ok('bad formats are ignored', Match.clean({ fmt: 'bo', n: 4 }) === null && Match.clean({ fmt: 'x' }) === null && Match.clean(null) === null);
  ok('good formats', JSON.stringify(Match.clean({ fmt: 'ft', n: '5' })) === '{"fmt":"ft","n":5}' && Match.clean({ fmt: 'mar', n: 9 }).n === 0);
  let r = await call('create', { color: 'w', tc, match: { fmt: 'bo', n: 4 } }, ann);
  ok('a bad format makes a single game', r.code && !r.snap.match, r.snap && r.snap.match);
  r = await call('create', { color: 'w', tc }, ann);
  ok('no format: a single game, as before', r.code && r.snap.match === null);

  console.log('best of 3');
  r = await call('create', { color: 'w', tc, match: { fmt: 'bo', n: 3 } }, ann);
  const code = r.code;
  ok('created with a match', r.snap.match && r.snap.match.fmt === 'bo' && r.snap.match.n === 3 && !r.snap.match.games.length, r.snap.match);
  await call('join', { code }, bob);
  await whiteWins(code);                                         // game 1: ann (white) wins
  r = await room(code);
  ok('game 1 is scored', r.match.games.length === 1 && r.match.games[0].win === 'ann' && pts(r).ann === 1 && pts(r).bob === 0, r.match);
  ok('the match goes on', !r.match.done);
  ok('ann is on match point', Match.matchPoint(r.match).join() === 'ann', Match.matchPoint(r.match));
  await call('rematch', { code }, ann);
  r = await room(code);
  ok('next game waits for both players', r.status.over && r.rematch.length === 1);
  await call('rematch', { code }, bob);
  r = await room(code);
  ok('game 2 starts with colours swapped', !r.status.over && r.players.w.name === 'bob' && r.players.b.name === 'ann' && r.moves.length === 0, r.players);
  ok('the score is kept', r.match.games.length === 1);
  await whiteWins(code);                                         // game 2: bob (white) wins
  r = await room(code);
  ok('1–1 after two games', pts(r).ann === 1 && pts(r).bob === 1 && !r.match.done, pts(r));
  await next(code);
  await draw(code);                                              // game 3: draw -> 1.5–1.5
  r = await room(code);
  ok('level after 3 games: Armageddon next', !r.match.done && r.match.arma && pts(r).ann === 1.5, r.match);
  ok('no match point in a decider', Match.matchPoint(r.match).length === 0);
  await next(code);
  r = await room(code);
  ok('the decider is flagged', r.arma === true);
  ok('Black has less time in Armageddon', r.clock.w === 300e3 && r.clock.b === 240e3, r.clock);
  const blackName = r.players.b.name;
  await draw(code);                                              // a draw in Armageddon goes to Black
  r = await room(code);
  ok('a drawn Armageddon is a Black win', r.match.done && r.match.winner === blackName && r.match.why === 'armageddon', r.match);
  ok('the game itself is still a draw', r.status.result === 'draw');
  r = await call('rematch', { code }, cat);
  ok('spectators cannot start the next game', r.status === 403);
  await next(code);
  r = await room(code);
  ok('a new match after a finished one', r.match.no === 2 && r.match.games.length === 0 && !r.match.done && r.match.past.length === 1 && r.match.past[0].winner === blackName, r.match);
  ok('a new match is not an Armageddon game', r.arma === false && r.clock.b === 300e3);

  console.log('stopping before a decider starts');
  r = await call('create', { color: 'w', tc, match: { fmt: 'bo', n: 3 } }, ann);
  const dc = r.code;
  await call('join', { code: dc }, bob);
  await draw(dc); await next(dc); await draw(dc); await next(dc); await draw(dc); await next(dc);
  r = await room(dc);
  ok('the decider is set up', r.arma && r.clock.b === 240e3, r.clock);
  r = await call('match_end', { code: dc }, ann);
  r = await room(dc);
  ok('stopping it before the first move makes it a normal game', r.match.done && !r.match.winner && !r.arma && r.clock.b === 300e3, [r.arma, r.clock, r.match.winner]);

  console.log('archive and ratings');
  const ga = await call('games', { name: 'ann' }, ann);
  ok('every match game is archived', ga.games.filter((x) => x.code === code).length === 4, ga.games.length);
  ok('match games are rated', ga.games.filter((x) => x.code === code).every((x) => x.rated));

  console.log('first to 3 wins');
  r = await call('create', { color: 'w', tc, match: { fmt: 'ft', n: 3 } }, ann);
  const ft = r.code;
  await call('join', { code: ft }, bob);
  await draw(ft); await next(ft); await draw(ft); await next(ft);
  r = await room(ft);
  ok('draws do not count', r.match.games.length === 2 && !r.match.done && Match.score(r.match).wins.ann === 0);
  for (let i = 0; i < 3; i++) { const s = await seats(ft); if (s.w.name === 'ann') await whiteWins(ft); else await play(ft, ['f2f3', 'e7e5', 'g2g4', 'd8h4']); if (i < 2) await next(ft); }
  r = await room(ft);
  ok('ann gets to 3 wins and takes it', r.match.done && r.match.winner === 'ann' && Match.score(r.match).wins.ann === 3, r.match);
  ok('a win streak', Match.streak(r.match).name === 'ann' && Match.streak(r.match).n === 3, Match.streak(r.match));

  console.log('marathon and stopping');
  r = await call('create', { color: 'w', tc, match: { fmt: 'mar' } }, ann);
  const mar = r.code;
  await call('join', { code: mar }, bob);
  await play(mar, ['e2e4', 'e7e5']);
  r = await call('match_end', { code: mar }, ann);
  ok('cannot stop in the middle of a game', r.status === 400, r);
  await call('resign', { code: mar }, bob);
  r = await call('match_end', { code: mar }, cat);
  ok('spectators cannot stop it', r.status === 403);
  for (let i = 0; i < 4; i++) { await next(mar); const s = await seats(mar); await play(mar, ['e2e4', 'e7e5']); await call('resign', { code: mar }, s.b); }
  r = await room(mar);
  ok('a marathon never ends by itself', r.match.games.length === 5 && !r.match.done, r.match);
  r = await call('match_end', { code: mar }, bob);
  r = await room(mar);
  ok('stopped: the leader takes it', r.match.done && r.match.why === 'stopped' && r.match.by === 'bob' && r.match.winner === 'ann', r.match);
  ok('…with the score 3–2', pts(r).ann === 3 && pts(r).bob === 2, pts(r));

  console.log('challenges');
  await call('challenge', { to: 'bob', tc }, cat);
  await call('challenge', { to: 'bob', tc, match: { fmt: 'bo', n: 5 } }, cat);
  const me = await call('me', {}, bob);
  ok('changing the format replaces the challenge', me.inbox.length === 1 && me.inbox[0].match && me.inbox[0].match.n === 5, me.inbox);
  ok('the challenge carries the format', me.inbox[0].match && me.inbox[0].match.n === 5, me.inbox);
  r = await call('accept', { id: me.inbox[0].id }, bob);
  ok('accepting starts the match', r.code && r.snap.match && r.snap.match.fmt === 'bo' && r.snap.match.n === 5, r.snap && r.snap.match);
  await call('challenge', { to: 'bob', tc }, cat);
  const me2 = await call('me', {}, bob);
  r = await call('accept', { id: me2.inbox[0].id }, bob);
  ok('a plain challenge is a single game', r.code && r.snap.match === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
