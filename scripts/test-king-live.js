// KING OF THE SERVER through the API with two live SSE clients: crowning, the Kingslayer, a normal fall, the frenzy, duplicate and
// simultaneous results, and a rebuild from history that must not fire a live event. Run: node scripts/test-king-live.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY; delete process.env.VERCEL; process.env.ADMIN_KEY = 'k';
const RT = require('../lib/realtime'), handler = require('../lib/app'), store = require('../lib/store');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const call = (route, body, who) => new Promise((resolve) => handler({ method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body }, { setHeader() {}, writeHead(c) { this.code = c; }, end(b) { let j = {}; try { j = JSON.parse(b || '{}'); } catch {} resolve({ status: this.code, ...j }); } }));
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// a browser on the lobby channel: the SSE stream, parsed
function client(id) {
  const got = [];
  const res = { socket: null, writeHead() {}, end() {}, write(f) { const m = /^event: (\w+)\ndata: (.*)\n/.exec(f); if (m) got.push({ ev: m[1], d: JSON.parse(m[2]) }); } };
  RT.sseHandler({ url: `/api/events?conn=${id}&topics=${store.prefix('1')}lobby`, method: 'GET', on() {} }, res);
  return { falls: () => got.filter((x) => x.ev === 'kingfall'), kings: () => got.filter((x) => x.ev === 'king') };
}

(async () => {
  ok('local mode pushes over SSE', RT.mode === 'sse', RT.mode);
  const A = client('c1'), B = client('c2');
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = {}; for (const n of ['ann', 'bob', 'cat', 'dan', 'eve', 'fay', 'gus']) P[n] = await su(n);
  const MV = ['e2e4', 'a7a6', 'f1c4', 'a6a5', 'd1h5', 'a5a4', 'a2a3', 'b7b6', 'h2h3', 'b6b5', 'h5f7'];   // white mates
  const win = async (w, b) => { const g = await call('create', { color: 'w', tc: { base: 600, inc: 0 } }, P[w]); await call('join', { code: g.code }, P[b]); for (let i = 0; i < MV.length; i++) { const r = await call('move', { code: g.code, from: sq(MV[i].slice(0, 2)), to: sq(MV[i].slice(2, 4)) }, i % 2 ? P[b] : P[w]); if (!r.ok) throw new Error('move ' + MV[i] + ': ' + r.error); } await wait(60); return g.code; };

  console.log('crowning');
  for (const o of ['bob', 'cat', 'dan', 'eve']) await win('ann', o);
  let s = await call('king_state', {}, P.gus);
  ok('four wins: below the minimum, no king', s.status === 200 && s.king === null && s.min === 5, s);
  await win('ann', 'fay');
  s = await call('king_state', {}, P.gus);
  ok('five in a row: ann is King of the Server', s.king && s.king.name === 'ann' && s.king.streak === 5, s);
  ok('a crowning is a quiet update on both clients, not the cinematic', A.kings().length === 1 && B.kings().length === 1 && !A.falls().length, A.kings());

  console.log('history does not fire live events');
  await handler.kingReset();
  s = await call('king_state', {}, P.gus);
  ok('rebuilt from the stored streaks: ann is still king', s.king && s.king.name === 'ann', s);
  ok('...and nothing was pushed', A.kings().length === 1 && !A.falls().length);

  console.log('THE KINGSLAYER');
  const code = await win('bob', 'ann');            // bob lost his last game: no active streak
  ok('both clients got the fall exactly once', A.falls().length === 1 && B.falls().length === 1, A.falls());
  const ev = A.falls()[0].d.ev;
  ok('it is a Kingslayer upset, naming the king, streak and slayer', ev.type === 'kingslayer' && ev.fallen === 'ann' && ev.streak === 5 && ev.by === 'bob' && ev.code === code, ev);
  ok('the king is dethroned; one win does not make bob king', A.falls()[0].d.king === null);
  s = await call('king_state', {}, P.gus); const s2 = await call('king_state', {}, P.cat);
  ok('the frenzy runs for two minutes on the server clock, the same for every client', s.frenzy && s.frenzy.until === s2.frenzy.until && Math.abs(s.frenzy.until - s.now - 120e3) < 5e3, [s.frenzy, s.now]);
  ok('bob is a Kingslayer for good', s.slayers.includes('bob'), s.slayers);
  ok('the reign is in the history: ann, 5, ended by bob', s.hist[0] && s.hist[0].name === 'ann' && s.hist[0].best === 5 && s.hist[0].by === 'bob' && s.hist[0].type === 'kingslayer', s.hist);
  const pf = await call('profile', { name: 'bob' }, P.gus);
  ok('the profile shows the Kingslayer badge', pf.king && pf.king.slayer && pf.king.slayer.n === 1 && pf.king.slayer.last.victim === 'ann', pf.king);

  console.log('duplicates');
  const doc = await handler.kingDoc(), gid = doc.seen[0], arch = await call('archive_get', { id: gid }, P.bob);
  const g = arch.game || { id: gid, result: 'w', players: { w: { name: 'bob' }, b: { name: 'ann' } } };
  const again = await handler.kingAfterGame(g, { w: { cur: 1, last: gid }, b: { cur: 0, last: gid } });
  ok('the same result applied again changes nothing and announces nothing', again === null && A.falls().length === 1 && (await handler.kingDoc()).v === doc.v, again);

  console.log('a normal fall, with an heir');
  for (const o of ['dan', 'eve', 'fay', 'gus', 'bob']) await win('cat', o);           // cat: 5, king
  for (const o of ['eve', 'fay', 'gus', 'bob']) await win('dan', o);                  // dan: 4 (lost to cat before)
  s = await call('king_state', {}, P.gus);
  ok('cat holds the crown', s.king && s.king.name === 'cat', s.king);
  await win('dan', 'cat');                                                            // dan, on a streak, beats the king, reaching 5
  const f2 = A.falls()[1] && A.falls()[1].d.ev;
  ok('a normal fall: the king lost to a player with a streak', f2 && f2.type === 'fall' && f2.fallen === 'cat' && f2.by === 'dan' && f2.streak === 5, f2);
  ok('A NEW KING HAS RISEN: dan, with 5', f2 && f2.heir === 'dan' && f2.heirStreak === 5, f2);
  ok('the second client saw the same event', B.falls().length === 2 && B.falls()[1].d.ev.id === f2.id);

  console.log('simultaneous results');
  const v0 = (await handler.kingDoc()).v;
  await Promise.all([win('eve', 'gus'), win('fay', 'bob')]);
  const d2 = await handler.kingDoc();
  ok('two games ending together are both applied (compare-and-swap)', d2.v === v0 + 2 && d2.seen.length >= 2, [v0, d2.v]);
  ok('the crown is unchanged by unrelated games', d2.king.name === 'dan');

  console.log('banned players: no crown, last place everywhere');
  const kings0 = A.kings().length, falls0 = A.falls().length;
  const du = await store.get('user:dan'); await store.set('user:dan', { ...du, banUntil: Date.now() + 86400e3 });
  await handler.banChanged({ ...du, banUntil: Date.now() + 86400e3 });
  s = await call('king_state', {}, P.gus);
  ok('a banned King loses the crown', !s.king || s.king.name !== 'dan', s.king);
  ok('...quietly: an update, not the cinematic', A.kings().length === kings0 + 1 && A.falls().length === falls0);
  ok('the reign is recorded as disqualified', s.hist[0].name === 'dan' && s.hist[0].type === 'disqualified' && s.hist[0].by === null, s.hist[0]);
  const me = await call('me', {}, P.gus), rapid = me.leaderboards && me.leaderboards.rapid;
  ok('the rating leaderboard puts dan last, marked banned, whatever his rating', rapid && rapid[rapid.length - 1].name === 'dan' && rapid[rapid.length - 1].banned && rapid.slice(0, -1).every((r) => !r.banned), rapid && rapid.map((r) => [r.name, r.r, !!r.banned]));
  const sb = await call('streak_board', {}, P.gus), sh = await call('streak_hunt', {}, P.gus), st = await call('stats_board', {}, P.gus);
  ok('the Win streaks rows mark dan as banned (the page sorts him last)', sb.rows.find((r) => r.name === 'dan').banned && sb.rows.filter((r) => r.banned).length === 1, sb.rows.filter((r) => r.banned));
  ok('the Streak Hunt lists dan last', sh.hunted.length && sh.hunted[sh.hunted.length - 1].name === 'dan' && sh.hunted[sh.hunted.length - 1].banned, sh.hunted.map((r) => r.name));
  ok('the stats rows mark dan as banned', st.rows.every((r) => !!r.banned === (r.name === 'dan')), st.rows.map((r) => [r.name, !!r.banned]));
  await handler.kingRecheck('dan');
  ok('checking again changes nothing', A.kings().length === kings0 + 1);
  await handler.kingReset(); s = await call('king_state', {}, P.gus);
  ok('a rebuild from history leaves the banned player out', !s.king || s.king.name !== 'dan', s.king);
  await store.set('user:dan', { ...du }); await handler.banChanged({ ...du });
  s = await call('king_state', {}, P.gus);
  ok('unbanned: the streak counts again and dan is King', s.king && s.king.name === 'dan', s.king);
  const me2 = await call('me', {}, P.gus);
  ok('...and he is back in his real place on the leaderboard', !me2.leaderboards.rapid.some((r) => r.banned) && me2.leaderboards.rapid[me2.leaderboards.rapid.length - 1].name !== 'dan', me2.leaderboards.rapid.map((r) => [r.name, r.r]));

  console.log('a ban made the old way (no recheck) still loses the crown');
  const k0 = A.kings().length;
  await store.set('user:dan', { ...du, banUntil: Date.now() + 86400e3 });            // banned without banChanged, as before this check existed
  s = await call('king_state', {}, P.gus);
  ok('reading the crown drops the banned King', !s.king || s.king.name !== 'dan', s.king);
  ok('...recorded as disqualified, announced quietly once', s.hist[0].name === 'dan' && s.hist[0].type === 'disqualified' && A.kings().length === k0 + 1 && A.falls().length === falls0, s.hist[0]);
  await call('king_state', {}, P.gus);
  ok('reading it again changes nothing', A.kings().length === k0 + 1);
  await store.set('user:dan', { ...du });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
