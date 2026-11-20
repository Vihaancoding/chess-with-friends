// SHUT UP: a player silences a spectator in one game's chat. The real multiplayer flow through the API: two players, spectators, chat,
// restrictions, double SHUT UP, revoking, cooldown, reconnecting, game end and a rematch. Run: node scripts/test-shutup.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY; process.env.ADMIN_KEY = 'k';
const handler = require('../lib/app'), store = require('../lib/store');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const call = (route, body, who) => new Promise((resolve) => handler({ method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body }, { setHeader() {}, writeHead(c) { this.code = c; }, end(b) { let j = {}; try { j = JSON.parse(b || '{}'); } catch {} resolve({ status: this.code, ...j }); } }));
// the stored room: to make the cooldowns pass without waiting
const age = async (code, ms) => { const r = await store.get('room:' + code); if (r.shut) { r.shut.lastAt -= ms; r.shut.cd.w -= ms; r.shut.cd.b -= ms; r.shut.last && (r.shut.last.at -= ms); r.v++; await store.set('room:' + code, r); } };
(async () => {
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const A = await su('ann'), B = await su('bob'), C = await su('cat'), D = await su('dan'), E = await su('eve');
  const g = await call('create', { color: 'w', tc: { base: 600, inc: 0 } }, A); await call('join', { code: g.code }, B);
  const code = g.code;
  await call('move', { code, from: 52, to: 36 }, A);
  for (const x of [C, D]) await call('sync', { code, v: null }, x);                       // they are watching
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const say = async (who, text) => { await sleep(750); return call('game_chat_send', { code, text }, who); };   // the chat's own 0.7 s throttle
  const view = async (who) => (await call('game_chat', { code }, who)).msgs;
  const texts = (msgs) => msgs.filter((m) => !m.sys).map((m) => m.n + ': ' + m.t);
  await say(C, 'cat early'); await say(D, 'dan early'); await say(A, 'ann hi');

  console.log('a player silences a spectator');
  let r = await call('game_shutup', { code, target: 'cat' }, A);
  ok('the white player tells a spectator to SHUT UP', r.status === 200 && r.ok && r.double === false && r.shut.list.length === 1 && r.shut.list[0].n === 'cat' && r.shut.list[0].by.join() === 'ann', r);
  ok('the spectator can no longer send a message (rejected by the server)', (await say(C, 'cat again')).status === 403, null);
  ok('the other spectator still can', (await say(D, 'dan again')).status === 200, null);
  ok('the silenced spectator can keep watching (the game still answers them)', (await call('sync', { code, v: null }, C)).status === 200, null);
<<<<<<< HEAD
  ok('the players\' chat still shows what the spectator wrote before (and nothing new can come)', texts(await view(A)).includes('cat: cat early') && texts(await view(B)).includes('cat: cat early') && !texts(await view(A)).includes('cat: cat again'), texts(await view(A)));
=======
  ok('both players\' chat views leave out the silenced spectator', !texts(await view(A)).some((t) => t.startsWith('cat')) && !texts(await view(B)).some((t) => t.startsWith('cat')), texts(await view(A)));
>>>>>>> origin/main
  ok('other spectators and the silenced one still see everything', texts(await view(D)).includes('cat: cat early') && texts(await view(C)).includes('cat: cat early'), texts(await view(D)));
  ok('the history itself is untouched in the database', chatTexts(await store.get('gchat:' + code)).includes('cat: cat early'), null);
  function chatTexts(raw) { return ((raw && raw.list) || []).filter((m) => !m.sys).map((m) => m.n + ': ' + m.t); }
  const sysmsgs = (await view(D)).filter((m) => m.sys);
  ok('a public announcement is in the chat for everyone', sysmsgs.length === 1 && sysmsgs[0].t === 'ann told cat to SHUT UP.' && (await view(C)).some((m) => m.sys), sysmsgs);
  const snapD = (await call('sync', { code, v: null }, D)).full, snapA = (await call('sync', { code, v: null }, A)).full;
  ok('everyone\'s game state carries the restriction and who did it; the players also get the list of spectators', snapD.shut.list[0].n === 'cat' && snapD.shut.last.k === 'su' && snapD.shut.last.by === 'ann' && snapA.spec.includes('cat') && snapD.spec.length === 0, [snapD.shut, snapA.spec]);

  console.log('who may do it');
  ok('a spectator cannot', (await call('game_shutup', { code, target: 'dan' }, C)).status === 403, null);
  ok('an outsider who is not in the game cannot', (await call('game_shutup', { code, target: 'dan' }, E)).status === 403, null);
  ok('a player cannot target the opponent', (await call('game_shutup', { code, target: 'bob' }, A)).status === 400, null);
  ok('or themselves', (await call('game_shutup', { code, target: 'ann' }, A)).status === 400, null);
  ok('someone who is not watching this game cannot be targeted', (await call('game_shutup', { code, target: 'eve' }, A)).status === 400, null);
  ok('an unknown name is refused', (await call('game_shutup', { code, target: 'nobody' }, A)).status === 404, null);
  ok('a request without a login is refused', (await call('game_shutup', { code, target: 'dan' })).status === 401, null);
  ok('the same player cannot do it twice to the same spectator', (await call('game_shutup', { code, target: 'cat' }, A)).status === 409, null);
  ok('the cooldown stops a second one straight away', (await call('game_shutup', { code, target: 'dan' }, A)).status === 429, null);
  ok('and one SHUT UP at a time for the whole room', (await call('game_shutup', { code, target: 'dan' }, B)).status === 429, null);
  ok('a revoke for something you never did is refused', (await call('game_shutup_revoke', { code, target: 'dan' }, A)).status === 404 && (await call('game_shutup_revoke', { code, target: 'cat' }, B)).status === 404, null);
  ok('a spectator cannot lift their own restriction', (await call('game_shutup_revoke', { code, target: 'cat' }, C)).status === 403, null);

  console.log('double SHUT UP, and revoking one of two');
  await age(code, 30000);
  r = await call('game_shutup', { code, target: 'cat' }, B);
  ok('the other player doing it too makes it a DOUBLE SHUT UP', r.status === 200 && r.double === true && r.shut.list[0].by.join() === 'ann,bob' && r.shut.last.k === 'double', r);
  ok('the announcements: one per player and a double line', (await view(D)).filter((m) => m.sys).map((m) => m.t).join('|').includes('DOUBLE SHUT UP. cat is in absolute silence.') && (await view(D)).filter((m) => m.sys && /told cat to SHUT UP/.test(m.t)).length === 2, (await view(D)).filter((m) => m.sys).map((m) => m.t));
  await age(code, 30000);
  r = await call('game_shutup_revoke', { code, target: 'cat' }, A);
  ok('one player revokes theirs: the other\'s restriction stays', r.status === 200 && r.shut.list.length === 1 && r.shut.list[0].by.join() === 'bob', r);
<<<<<<< HEAD
  ok('the spectator is still silenced: nothing new appears in anyone\'s chat', (await say(C, 'sneaky')).status === 403 && !texts(await view(A)).includes('cat: sneaky'), null);
=======
  ok('the spectator is still silenced and still hidden from both players', (await say(C, 'sneaky')).status === 403 && !texts(await view(A)).some((t) => t.startsWith('cat')), null);
>>>>>>> origin/main
  ok('and the revoke is announced', (await view(D)).some((m) => m.sys && /ann lifted their SHUT UP on cat\. They are still silenced/.test(m.t)), null);
  await age(code, 30000);
  r = await call('game_shutup_revoke', { code, target: 'cat' }, B);
  ok('when the second one is revoked too, the spectator can talk again', r.status === 200 && r.shut.list.length === 0 && (await say(C, 'back again')).status === 200, r);
<<<<<<< HEAD
  ok('and their new messages show up for the players too, next to the old ones', texts(await view(A)).includes('cat: cat early') && texts(await view(B)).includes('cat: back again'), texts(await view(A)));
=======
  ok('and the players see their messages again, history included', texts(await view(A)).includes('cat: cat early') && texts(await view(B)).includes('cat: back again'), texts(await view(A)));
>>>>>>> origin/main

  console.log('reconnecting');
  await age(code, 30000);
  await call('game_shutup', { code, target: 'dan' }, A);
  const re = (await call('sync', { code, v: null }, D)).full;
  ok('a reconnecting spectator gets the restriction from the server, with how long ago it happened', re.shut.list[0].n === 'dan' && re.shut.last.ago >= 0 && re.shut.last.ago < 5000, re.shut);
  ok('refreshing does not get around it', (await say(D, 'let me in')).status === 403, null);
<<<<<<< HEAD
  ok('after a reload the players\' chat has the old messages and nothing new from the silenced spectator', texts(await view(B)).includes('dan: dan early') && !texts(await view(B)).includes('dan: let me in'), texts(await view(B)));
=======
  ok('the players\' chat after a reload still leaves the silenced spectator out', !texts(await view(B)).some((t) => t.startsWith('dan')), texts(await view(B)));
>>>>>>> origin/main

  console.log('the game ends: nothing carries over');
  await call('resign', { code }, B);
  const over = (await call('sync', { code, v: null }, D)).full;
  ok('when the game ends the restrictions are gone from the game state', over.status.over === true && over.shut === null, over.shut);
  ok('and the silenced spectator can chat again (after the game)', (await say(D, 'gg')).status === 200, null);
  ok('SHUT UP cannot be used once the game is over', (await call('game_shutup', { code, target: 'cat' }, A)).status === 400 && (await call('game_shutup_revoke', { code, target: 'dan' }, A)).status === 404, null);
  ok('the players\' chat shows everyone again', texts(await view(A)).includes('dan: dan early') && texts(await view(A)).includes('dan: gg'), null);
  await call('rematch', { code }, A); await call('rematch', { code }, B);
  const next = (await call('sync', { code, v: null }, D)).full;
  ok('a rematch starts with no restrictions at all', next.status.over === false && next.shut === null && (await store.get('room:' + code)).shut === null, next.shut);
  await call('sync', { code, v: null }, C);
  ok('a new game is a clean slate: a spectator is not silenced there', (await say(C, 'new game')).status === 200, null);

  console.log('private games and bad input');
  ok('a target name that is not text does not break anything', (await call('game_shutup', { code, target: { $ne: 1 } }, A)).status === 400, null);
  ok('a missing game answers 404', (await call('game_shutup', { code: 'NOPE1', target: 'cat' }, A)).status === 404, null);
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
