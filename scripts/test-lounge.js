// Lounges: private rooms with several people, chat, open tables and a table of results. Run: node scripts/test-lounge.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
const handler = require('../lib/app');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const call = (route, body, who) => new Promise((resolve) => handler({ method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body }, { setHeader() {}, writeHead(c) { this.code = c; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } }));
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
const MATE = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];   // white mates
const tc = { base: 300, inc: 0 };
(async () => {
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = {}; for (const n of ['ann', 'bob', 'cat', 'dan', 'eve']) P[n] = await su(n);

  console.log('rooms and invites');
  ok('a room needs a name', (await call('lounge_create', { name: '' }, P.ann)).status === 400, null);
  const c = await call('lounge_create', { name: 'Friday club' }, P.ann); const id = c.id;
  ok('the owner creates a room and is in it', c.ok && (await call('lounge_mine', {}, P.ann)).rooms.some((r) => r.id === id && r.st === 'in'), c);
  ok('strangers cannot open it', (await call('lounge_get', { id }, P.bob)).status === 403 && (await call('lounge_chat', { id, text: 'hi' }, P.bob)).status === 403, null);
  ok('invite: unknown name refused', (await call('lounge_invite', { id, name: 'nobody' }, P.ann)).status === 404, null);
  ok('invite: a member invites', (await call('lounge_invite', { id, name: 'bob' }, P.ann)).ok && (await call('lounge_invite', { id, name: 'cat' }, P.ann)).ok, null);
  ok('the invited person sees the invite, and only a preview', (await call('lounge_mine', {}, P.bob)).rooms.some((r) => r.id === id && r.st === 'invited') && (await call('lounge_get', { id }, P.bob)).invite.name === 'Friday club' && !(await call('lounge_get', { id }, P.bob)).chat, null);
  ok('they cannot chat before accepting', (await call('lounge_chat', { id, text: 'hi' }, P.bob)).status === 403, null);
  await call('lounge_reply', { id, accept: true }, P.bob); await call('lounge_reply', { id, accept: true }, P.cat);
  ok('accepting puts them in the room (3 people now)', (await call('lounge_get', { id }, P.bob)).room.members.length === 3, null);
  await call('lounge_invite', { id, name: 'dan' }, P.bob);   // any member can invite
  await call('lounge_reply', { id, accept: false }, P.dan);
  ok('declining leaves them out', !(await call('lounge_get', { id }, P.ann)).room.members.includes('dan') && (await call('lounge_mine', {}, P.dan)).rooms.length === 0, null);

  console.log('chat');
  await call('lounge_chat', { id, text: 'welcome all' }, P.ann); await call('lounge_chat', { id, text: 'hello!' }, P.cat);
  const g = await call('lounge_get', { id }, P.bob);
  ok('members share one chat', g.chat.map((m) => m.t).join('|') === 'welcome all|hello!' && (await call('lounge_msgs', { id }, P.cat)).chat.length === 2, g.chat);

  console.log('playing');
  const t = await call('lounge_table', { id, tc }, P.ann);
  ok('a member opens a table', t.code && (await call('lounge_get', { id }, P.bob)).tables.some((x) => x.code === t.code && x.by === 'ann'), t);
  ok('only members can sit', (await call('lounge_sit', { id, code: t.code }, P.eve)).status === 403, null);
  const s = await call('lounge_sit', { id, code: t.code }, P.bob);
  ok('another member sits down; the table closes', s.code === t.code && !(await call('lounge_get', { id }, P.cat)).tables.length, s);
  const players = { ann: s.snap.players.w.name === 'ann' ? 'w' : 'b' };
  const order = players.ann === 'w' ? [P.ann, P.bob] : [P.bob, P.ann], whiteName = order[0].name;
  // play fool's-mate-ish: white mates; whoever is white wins
  for (let i = 0; i < MATE.length; i++) { const m = MATE[i], who = i % 2 ? order[1] : order[0]; const r = await call('move', { code: t.code, from: sq(m.slice(0, 2)), to: sq(m.slice(2, 4)) }, who); if (!r.ok) { console.log('move failed', m, r.error); break; } }
  const g2 = await call('lounge_get', { id }, P.cat);
  const row = (n) => g2.table.find((x) => x.name === n);
  ok('the game counts on the room table', row(whiteName).w === 1 && row(whiteName === 'ann' ? 'bob' : 'ann').l === 1 && g2.recent.length === 1, g2.table);
  ok('members who did not play are listed with zero', g2.table.length === 3 && row('cat').pts === 0, g2.table);
  console.log('private games');
  let gid0; for (let i = 0; i < 20 && !gid0; i++) { gid0 = (await call('games', { name: 'ann' }, P.ann)).games.find((x) => x.moves === 7); if (!gid0) await new Promise((r) => setTimeout(r, 150)); }
  ok('the game is on the players\' own list', gid0 && gid0.priv === 1, gid0);
  ok('members can watch and read it', (await call('room', { code: t.code }, P.cat)).status !== 404 && (await call('game_get', { id: gid0.id }, P.cat)).game, null);
  ok('a stranger cannot open the live game page', (await call('room', { code: t.code }, P.eve)).status === 404 && (await call('sync', { code: t.code, v: null }, P.eve)).status === 404, null);
  ok('a stranger cannot join as a spectator or read its chat', (await call('join', { code: t.code }, P.eve)).status === 404 && (await call('game_chat', { code: t.code }, P.eve)).status === 404, null);
  ok('a stranger cannot open the finished game', (await call('game_get', { id: gid0.id }, P.eve)).status === 404, null);
  ok('it does not show on the players\' public game list', !(await call('games', { name: 'ann' }, P.eve)).games.some((x) => x.id === gid0.id) && (await call('games', { name: 'ann' }, P.cat)).games.every((x) => !x.priv), null);
  const ch = await call('challenge', { to: 'cat', tc, lounge: id }, P.ann); const inb = (await call('ping', {}, P.cat));
  ok('a challenge between two members is tagged with the room', ch.ok, ch);

  console.log('study room');
  const sr = await call('lounge_create', { name: 'Study group', kind: 'study' }, P.ann); const sid = sr.id;
  ok('a study room is marked as one, in my list and in the room', (await call('lounge_mine', {}, P.ann)).rooms.find((r) => r.id === sid).kind === 'study' && (await call('lounge_get', { id: sid }, P.ann)).room.kind === 'study', null);
  await call('lounge_invite', { id: sid, name: 'bob' }, P.ann); await call('lounge_reply', { id: sid, accept: true }, P.bob);
  ok('no tables in a study room', (await call('lounge_table', { id: sid, tc }, P.ann)).status === 400, null);
  ok('notes need a game first', (await call('lounge_study_note', { id: sid, ply: 1, mark: '?' }, P.ann)).status === 404, null);
  const gid = (await call('games', { name: 'ann' }, P.ann)).games[0];
  ok('there is a finished game to study', gid && gid.id, gid);
  ok('only members pick a game, and it has to exist', (await call('lounge_study_pick', { id: sid, game: gid.id }, P.eve)).status === 403 && (await call('lounge_study_pick', { id: sid, game: 'ZZZZZ-nope' }, P.ann)).status === 404, null);
  ok('a member picks the game', (await call('lounge_study_pick', { id: sid, game: gid.id }, P.ann)).ok, null);
  let st = (await call('lounge_get', { id: sid }, P.bob)).study;
  ok('everyone sees the game and its moves', st && st.game.hist.length === 7 && st.notes.length === 0, st && st.game.hist.length);
  ok('a bad move number or an empty note is refused', (await call('lounge_study_note', { id: sid, ply: 99, mark: '?' }, P.ann)).status === 400 && (await call('lounge_study_note', { id: sid, ply: 1 }, P.ann)).status === 400, null);
  await call('lounge_study_note', { id: sid, ply: 6, mark: '??', text: 'loses to mate' }, P.ann); await call('lounge_study_note', { id: sid, ply: 6, mark: '?', text: 'a mistake' }, P.bob); await call('lounge_study_note', { id: sid, ply: 6, mark: '?!' }, P.ann);
  st = (await call('lounge_get', { id: sid }, P.ann)).study;
  ok('one note per person per move (a second replaces the first)', st.notes.length === 2 && st.notes.find((n) => n.by === 'ann').mark === '?!', st.notes);
  ok('you can only remove your own notes (the owner can remove any)', (await call('lounge_study_del', { id: sid, note: st.notes.find((n) => n.by === 'ann').id }, P.bob)).status === 403 && (await call('lounge_study_del', { id: sid, note: st.notes.find((n) => n.by === 'bob').id }, P.ann)).ok && (await call('lounge_get', { id: sid }, P.ann)).study.notes.length === 1, null);

  console.log('leaving');
  ok('only the owner removes people', (await call('lounge_kick', { id, name: 'cat' }, P.bob)).status === 403 && (await call('lounge_kick', { id, name: 'cat' }, P.ann)).ok && !(await call('lounge_mine', {}, P.cat)).rooms.length, null);
  ok('a member can leave', (await call('lounge_leave', { id }, P.bob)).ok && (await call('lounge_get', { id }, P.bob)).status === 403, null);
  ok('only the owner deletes', (await call('lounge_delete', { id }, P.bob)).status === 403 && (await call('lounge_delete', { id }, P.ann)).ok && (await call('lounge_get', { id }, P.ann)).status === 404, null);
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
