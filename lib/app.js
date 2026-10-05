// API handler shared by local server.js and the Vercel function (api/index.js).
// Every call is POST /api?r=<route> with JSON body and x-name / x-token headers.
const crypto = require('crypto');
const Chess = require('../public/chess.js');
const store = require('./store');
const R = require('./rating');
const RT = require('./realtime');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const NAME_RE = /^[A-Za-z0-9_-]{2,16}$/;
const START_ELO = 1200, ROOM_TTL = 3 * 3600, CHALLENGE_TTL = 10 * 60e3;
const other = (c) => (c === 'w' ? 'b' : 'w');

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };

// ---------- users ----------
const ukey = (n) => 'user:' + n.toLowerCase();
const getUser = (n) => store.get(ukey(n));
const saveUser = (u) => store.set(ukey(u.name), u);
const pub = (u) => {
  const ratings = R.summary(u);
  return { name: u.name, elo: ratings.blitz.r, ratings, w: u.w || 0, l: u.l || 0, d: u.d || 0, topic: RT.userTopic(u) };
};
const lbEntry = (u) => ({ ratings: R.summary(u), w: u.w || 0, l: u.l || 0, d: u.d || 0 });
const seatInfo = (u, cat) => { const x = R.show(R.ratingOf(u, cat)); return { name: u.name, elo: x.r, prov: x.prov }; };

async function bumpLeaderboard(...users) {
  const lb = (await store.get('lb')) || {};
  for (const u of users) lb[u.name] = lbEntry(u);
  await store.set('lb', lb);
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const ekey = (e) => 'email:' + e;
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 32, (e, k) => (e ? rej(e) : res(k))));

async function signup(body) {
  const email = String(body.email || '').trim().toLowerCase(), pw = String(body.password || ''), name = String(body.username || '').trim();
  if (!EMAIL_RE.test(email) || email.length > 254) fail(400, 'Enter a valid email address.');
  if (pw.length < 8 || pw.length > 128) fail(400, 'Password must be 8-128 characters.');
  if (!NAME_RE.test(name)) fail(400, 'Username must be 2-16 letters, numbers, _ or -.');
  if (await store.get(ekey(email))) fail(409, 'That email already has an account. Log in instead.');
  if (await getUser(name)) fail(409, 'That username is taken. Pick another one.');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(pw, salt)).toString('hex');
  const u = { name, email, salt, hash, token: crypto.randomUUID(), elo: START_ELO, w: 0, l: 0, d: 0, created: Date.now() };
  await saveUser(u);
  await store.set(ekey(email), { name });
  await bumpLeaderboard(u);
  return { ...pub(u), token: u.token };
}

async function login(body) {
  const email = String(body.email || '').trim().toLowerCase(), pw = String(body.password || '');
  const fk = 'fail:' + email;
  const fails = (await store.get(fk)) || 0;
  if (fails >= 8) fail(429, 'Too many attempts. Try again in 15 minutes.');
  const m = await store.get(ekey(email));
  const u = m && (await getUser(m.name));
  const got = await scrypt(pw, u ? u.salt : 'x'.repeat(32)); // same work whether or not the account exists
  if (!u || !u.hash || !crypto.timingSafeEqual(got, Buffer.from(u.hash, 'hex'))) {
    await store.set(fk, fails + 1, 900);
    fail(401, 'Wrong email or password.');
  }
  if (fails) await store.del(fk);
  return { ...pub(u), token: u.token };
}

// Resume a saved session on this device (name + token kept in localStorage).
async function resume(body) {
  const u = await getUser(String(body.name || ''));
  if (u && body.token && body.token === u.token) return { ...pub(u), token: u.token };
  fail(401, 'Please sign in again.');
}

async function needAdmin(req) {
  const u = await auth(req);
  if (!u.admin) fail(403, 'Admins only.');
  return u;
}

async function auth(req) {
  const name = req.headers['x-name'], token = req.headers['x-token'];
  const u = name && token ? await getUser(String(name)) : null;
  if (!u || u.token !== token) fail(401, 'Please sign in again.');
  return u;
}

// ---------- rooms ----------
const rkey = (c) => 'room:' + c;
const LIVE_TTL = 30 * 60e3;
const saveRoom = async (r, live = true) => {
  await Promise.all([store.set(rkey(r.code), r, ROOM_TTL), live ? touchLive(r, Date.now()) : null]);
};

// Read-modify-write a room safely. fn(room) changes it (or throws); the write only lands if nobody else
// wrote in between, otherwise we re-read and run fn again. Rating updates are applied after a successful
// write so they can never be applied twice.
async function mutateRoom(code, fn, { live = true } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const room = await loadRoom(code);
    const prevV = room.v;
    const result = await fn(room);
    if (result && result.noWrite) return { room, result };
    room.v = (prevV || 0) + 1;
    const pend = room._settle; delete room._settle;
    if (await store.cas(rkey(room.code), room, prevV, ROOM_TTL)) {
      const doLive = typeof live === 'function' ? live(room) : live;
      await Promise.all([pend ? applySettle(room, pend) : null, doLive ? touchLive(room, Date.now()) : null]);
      return { room, result };
    }
  }
  fail(409, 'The game is busy. Please try again.');
}
const hname = (req) => String(req.headers['x-name'] || '').toLowerCase();

// Public list of games in progress (for the lobby "Live games" / spectating).
async function touchLive(room, now) {
  const list = ((await store.get('live')) || []).filter((g) => g.code !== room.code && now - g.ts < LIVE_TTL);
  if (room.players.w && room.players.b && !outcome(room).over)
    list.push({
      code: room.code, tc: room.tc, moves: room.moves.length, ts: now,
      w: { name: room.players.w.name, elo: room.players.w.elo }, b: { name: room.players.b.name, elo: room.players.b.elo },
    });
  await store.set('live', list, 3600);
}

async function loadRoom(code) {
  const room = await store.get(rkey(String(code || '').toUpperCase()));
  if (!room) fail(404, 'No game with that code.');
  return room;
}

function cleanTc(tc) {
  if (!tc || !(tc.base >= 30)) return null;
  return { base: Math.min(tc.base | 0, 10800), inc: Math.max(0, Math.min(tc.inc | 0, 180)) };
}

function freshGame(room, now) {
  room.state = Chess.initial();
  room.moves = [];
  room.last = null;
  room.resigned = null;
  room.timeout = null;
  room.settled = false;
  room.delta = null;
  room.ratings = null;
  room.unrated = false;
  room.startedAt = null;
  room.endedAt = null;
  room.aborted = false;
  room.rematch = [];
  room.hist = [];
  room.positions = { [Chess.key(room.state)]: 1 };
  room.rep = false;
  room.drawn = false;
  room.drawOffer = null;
  room.offerLog = { w: -1, b: -1 };
  room.clock = room.tc ? { w: room.tc.base * 1000, b: room.tc.base * 1000, ts: now } : null;
}

async function makeRoom(players, tc, now) {
  let code;
  do code = Array.from({ length: 5 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  while (await store.get(rkey(code)));
  const ctc = cleanTc(tc);
  const room = { code, tc: ctc, cat: R.category(ctc), players, seen: {}, v: 1 };
  freshGame(room, now);
  await saveRoom(room);
  return room;
}

const seatOf = (room, name) =>
  room.players.w && room.players.w.name === name ? 'w' : room.players.b && room.players.b.name === name ? 'b' : 's';

function outcome(room) {
  if (room.aborted) return { over: true, result: 'draw', reason: 'ended by an admin', check: false };
  if (room.resigned) return { over: true, result: other(room.resigned), reason: 'resignation', check: false };
  if (room.timeout) return { over: true, result: other(room.timeout), reason: 'timeout', check: false };
  if (room.drawn) return { over: true, result: 'draw', reason: 'agreement', check: false };
  const st = Chess.status(room.state);
  if (!st.over && room.rep) return { over: true, result: 'draw', reason: 'threefold repetition', check: false };
  return st;
}

// Flag the side to move if their clock has run out. Returns true if state changed.
function tick(room, now) {
  if (!room.tc || room.resigned || room.timeout || room.drawn || room.rep || room.aborted) return false;
  if (!room.players.w || !room.players.b || room.moves.length < 2) return false;
  if (Chess.status(room.state).over) return false;
  const t = room.state.turn;
  if (room.clock[t] - (now - room.clock.ts) <= 0) { room.clock[t] = 0; room.timeout = t; return true; }
  return false;
}

// Phase 1 (inside mutateRoom): when the game has just ended, compute the new ratings and record them on
// the room. Phase 2 (applySettle, after the write succeeded) saves the players, leaderboard and history.
async function settle(room) {
  const o = outcome(room);
  if (!o.over || room.settled) return false;
  room.settled = true;
  room.endedAt = Date.now();
  if (room.aborted || !room.players.w || !room.players.b) return true;
  if (room.moves.length < 2) { room.unrated = true; return true; }     // like chess.com: no rating change before both sides moved
  const [uw, ub] = await Promise.all([getUser(room.players.w.name), getUser(room.players.b.name)]);
  if (!uw || !ub) return true;
  const cat = room.cat || R.category(room.tc);
  const sw = o.result === 'w' ? 1 : o.result === 'b' ? 0 : 0.5;
  const ow = R.ratingOf(uw, cat), ob = R.ratingOf(ub, cat);
  const [nw, nb] = R.rateGame(ow, ob, sw, room.endedAt);
  const line = (o1, n1) => ({ before: Math.round(o1.r), after: Math.round(n1.r), delta: Math.round(n1.r) - Math.round(o1.r), prov: R.provisional(n1) });
  room.ratings = { w: line(ow, nw), b: line(ob, nb) };
  room.delta = { w: room.ratings.w.delta, b: room.ratings.b.delta };
  room._settle = { cat, sw, nw, nb };
  return true;
}
async function applySettle(room, p) {
  const [uw, ub] = await Promise.all([getUser(room.players.w.name), getUser(room.players.b.name)]);
  if (!uw || !ub) return;
  const at = room.endedAt, dur = room.startedAt ? at - room.startedAt : 0, reason = outcome(room).reason;
  for (const [u, rec, s, col, opp] of [[uw, p.nw, p.sw, 'w', 'b'], [ub, p.nb, 1 - p.sw, 'b', 'w']]) {
    u.ratings = { ...(u.ratings || {}), [p.cat]: rec };
    if (s === 1) u.w = (u.w || 0) + 1; else if (s === 0) u.l = (u.l || 0) + 1; else u.d = (u.d || 0) + 1;
    u.elo = R.show(R.ratingOf(u, 'blitz')).r;
    u._game = {
      code: room.code, at, cat: p.cat, tc: room.tc, color: col, opp: room.players[opp].name, oppRating: room.ratings[opp].before,
      result: s === 1 ? 'win' : s === 0 ? 'loss' : 'draw', reason, ...room.ratings[col], moves: room.moves.length, dur,
    };
  }
  await Promise.all([uw, ub].map(async (u) => {
    const g = u._game; delete u._game;
    const gk = 'games:' + u.name.toLowerCase();
    const list = (await store.get(gk)) || [];
    await Promise.all([saveUser(u), store.set(gk, [g, ...list].slice(0, 50))]);
  }));
  await bumpLeaderboard(uw, ub);
}

function snapshot(room, name, now, pres) {
  const o = outcome(room);
  const live = room.tc && room.players.w && room.players.b && room.moves.length >= 2 && !o.over;
  const run = live ? room.state.turn : null;
  const left = (c) => (room.clock ? Math.max(0, room.clock[c] - (run === c ? now - room.clock.ts : 0)) : null);
  return {
    code: room.code,
    you: seatOf(room, name),
    state: room.state,
    moves: room.moves,
    last: room.last,
    status: o,
    players: room.players,
    present: { w: now - (pres.w || 0) < 7000, b: now - (pres.b || 0) < 7000 },
    tc: room.tc,
    clock: room.clock ? { w: left('w'), b: left('b'), running: run } : null,
    delta: room.delta,
    rematch: room.rematch,
    hist: room.hist || [],
    drawOffer: room.drawOffer || null,
    watching: Object.values(pres.spec || {}).filter((t) => now - t < 7000).length,
    cat: room.cat || R.category(room.tc), ratings: room.ratings || null, unrated: !!room.unrated,
    startedAt: room.startedAt || null, endedAt: room.endedAt || null, v: room.v || 0,
  };
}

// ---------- routes ----------
const routes = {
  async signup(req, body) { return signup(body); },
  async login(req, body) { return login(body); },
  async resume(req, body) { return resume(body); },

  async me(req) {
    const now = Date.now(), lname = hname(req);
    const [u, inboxRaw, outboxRaw, lb, chat, live, ann] = await Promise.all([
      auth(req), store.get('inbox:' + lname), store.get('outbox:' + lname), store.get('lb'),
      store.get('chat:lobby'), store.get('live'), store.get('announce'),
    ]);
    const inbox = (inboxRaw || []).filter((c) => now - c.ts < CHALLENGE_TTL);
    let outbox = outboxRaw;
    if (outbox && outbox.status === 'pending' && now - outbox.ts > CHALLENGE_TTL) outbox = null;
    const rows = Object.entries(lb || {}).map(([name, st]) => ({ name, ratings: st.ratings || R.summary(st), w: st.w || 0, l: st.l || 0, d: st.d || 0 }));
    const leaderboards = {};
    for (const c of R.CATS)
      leaderboards[c] = rows.filter((x) => x.ratings[c].n > 0)          // only players with rated games in this time control
        .map((x) => ({ name: x.name, r: x.ratings[c].r, prov: x.ratings[c].prov, n: x.ratings[c].n, w: x.w, l: x.l, d: x.d }))
        .sort((x, y) => (x.prov - y.prov) || (y.r - x.r)).slice(0, 25);
    return {
      user: { ...pub(u), admin: !!u.admin, muted: !!u.muted },
      inbox, outbox, leaderboards, leaderboard: leaderboards.blitz,
      chat: (chat || []).slice(-50),
      live: (live || []).filter((g) => now - g.ts < LIVE_TTL),
      announce: ann && ann.text ? ann.text : '',
    };
  },

  config() { return RT.config(); },

  async profile(req, body) {
    const name = String(body.name || '').trim();
    const [, t] = await Promise.all([auth(req), getUser(name)]);
    if (!t) fail(404, 'No player with that name.');
    const games = (await store.get('games:' + t.name.toLowerCase())) || [];
    const ratings = {};
    for (const c of R.CATS) {
      const rec = R.ratingOf(t, c);
      ratings[c] = { ...R.show(rec), rd: Math.round(rec.rd), peak: rec.peak || Math.round(rec.r), w: rec.w || 0, l: rec.l || 0, d: rec.d || 0, hist: rec.hist || [] };
    }
    return { name: t.name, joined: t.created || null, w: t.w || 0, l: t.l || 0, d: t.d || 0, ratings, games: games.slice(0, 20) };
  },

  // Cheap poll (3 parallel reads) for challenge state; the lobby calls it about once a second.
  async ping(req) {
    const now = Date.now(), lname = hname(req);
    const [u, inboxRaw, outboxRaw] = await Promise.all([auth(req), store.get('inbox:' + lname), store.get('outbox:' + lname)]);
    const inbox = (inboxRaw || []).filter((c) => now - c.ts < CHALLENGE_TTL);
    let outbox = outboxRaw;
    if (outbox && outbox.status === 'pending' && now - outbox.ts > CHALLENGE_TTL) outbox = null;
    return { inbox, outbox, muted: !!u.muted };
  },

  async create(req, body) {
    const u = await auth(req), now = Date.now();
    const color = body.color === 'w' || body.color === 'b' ? body.color : Math.random() < 0.5 ? 'w' : 'b';
    const players = { w: null, b: null };
    players[color] = seatInfo(u, R.category(cleanTc(body.tc)));
    const room = await makeRoom(players, body.tc, now);
    return { code: room.code };
  },

  async join(req, body) {
    const now = Date.now();
    const u = await auth(req);
    const { room, result } = await mutateRoom(body.code, (room) => {
      if (seatOf(room, u.name) !== 's') return { noWrite: true };
      const c = !room.players.w ? 'w' : !room.players.b ? 'b' : null;
      if (!c) return { noWrite: true };                                   // full: you'll spectate
      room.players[c] = seatInfo(u, room.cat || R.category(room.tc));
      if (room.clock) room.clock.ts = now;
      return { joined: true };
    });
    if (result && result.joined) RT.publish('room:' + room.code, 'sync', { v: room.v });
    return { code: room.code };
  },

  async room(req, body) {
    const now = Date.now(), code = String(body.code || '').toUpperCase(), pk = 'pres:' + code;
    const [u, room, pres0] = await Promise.all([auth(req), loadRoom(code), store.get(pk)]);
    let cur = room;
    if (tick({ ...room, clock: room.clock && { ...room.clock } }, now)) {
      const res = await mutateRoom(code, async (r) => { if (!tick(r, now)) return { noWrite: true }; await settle(r); });
      cur = res.room;
      RT.publish('room:' + code, 'sync', { v: cur.v });
    }
    const pres = pres0 || { w: 0, b: 0, spec: {} };
    pres.spec = pres.spec || {};
    const seat = seatOf(room, u.name);
    let pdirty = false;
    if (seat !== 's') {
      if (now - (pres[seat] || 0) > 3000) { pres[seat] = now; pdirty = true; }
    } else if (now - (pres.spec[u.name] || 0) > 3000) {
      pres.spec[u.name] = now; pdirty = true;
      for (const k of Object.keys(pres.spec)) if (now - pres.spec[k] > 30000) delete pres.spec[k];
    }
    if (pdirty) await store.set(pk, pres, ROOM_TTL);
    return snapshot(cur, u.name, now, pres);
  },

  async move(req, body) {
    const u = await auth(req);
    let ended = false, timedOut = false;
    const { room, result } = await mutateRoom(body.code, async (room) => {
      const now = Date.now();
      const seat = seatOf(room, u.name);
      if (seat === 's') fail(403, 'Spectators cannot play.');
      if (!room.players.w || !room.players.b) fail(400, 'Waiting for an opponent.');
      if (tick(room, now)) { await settle(room); timedOut = true; return { timedOut: true }; }
      if (outcome(room).over) fail(400, 'Game is over.');
      if (room.state.turn !== seat) fail(400, 'Not your turn.');
      if (body.ply != null && body.ply !== room.moves.length) fail(409, 'The board changed. Try again.');
      const m = Chess.legalMoves(room.state).find((x) => x.from === body.from && x.to === body.to && (x.promo || null) === (body.promo || null));
      if (!m) fail(400, 'Illegal move.');
      if (room.tc) {
        if (room.moves.length >= 2) room.clock[seat] += room.tc.inc * 1000 - (now - room.clock.ts);
        room.clock.ts = now;
      }
      if (!room.startedAt) room.startedAt = now;
      room.hist = room.hist || [];
      room.positions = room.positions || {};
      const san = Chess.notate(room.state, m);
      room.moves.push(san);
      room.hist.push(m.promo ? { from: m.from, to: m.to, promo: m.promo } : { from: m.from, to: m.to });
      room.state = Chess.apply(room.state, m);
      room.last = { from: m.from, to: m.to };
      const pk = Chess.key(room.state);
      room.positions[pk] = (room.positions[pk] || 0) + 1;
      if (room.positions[pk] >= 3) room.rep = true;
      if (room.drawOffer && room.drawOffer !== seat) room.drawOffer = null;   // moving on = declining
      ended = await settle(room);
      return { san, m };
    }, { live: (r) => r.moves.length % 8 === 1 || outcome(r).over });
    const topic = 'room:' + room.code;
    if (timedOut) { RT.publish(topic, 'sync', { v: room.v }); fail(400, 'Time ran out.'); }
    // lightweight event: just the move plus clocks, so the opponent can apply it without a refetch
    const now = Date.now(), o = outcome(room);
    const run = room.tc && room.moves.length >= 2 && !o.over ? room.state.turn : null;
    const left = (c) => (room.clock ? Math.max(0, room.clock[c] - (run === c ? now - room.clock.ts : 0)) : null);
    await RT.publish(topic, 'move', {
      v: room.v, ply: room.moves.length - 1, from: result.m.from, to: result.m.to, promo: result.m.promo || null, san: result.san,
      clock: room.clock ? { w: left('w'), b: left('b'), running: run } : null, over: o.over, drawOffer: room.drawOffer || null,
    });
    return { ok: true, v: room.v, over: ended };
  },

  async resign(req, body) {
    const u = await auth(req);
    const { room } = await mutateRoom(body.code, async (room) => {
      const seat = seatOf(room, u.name);
      if (seat === 's') fail(403, 'Spectators cannot resign.');
      if (outcome(room).over) fail(400, 'Game is over.');
      room.resigned = seat;
      await settle(room);
    });
    await RT.publish('room:' + room.code, 'sync', { v: room.v });
    return { ok: true };
  },

  async draw_offer(req, body) {
    const u = await auth(req);
    const { room } = await mutateRoom(body.code, async (room) => {
      const seat = seatOf(room, u.name);
      if (seat === 's') fail(403, 'Spectators cannot offer draws.');
      if (outcome(room).over) fail(400, 'Game is over.');
      if (!room.players.w || !room.players.b) fail(400, 'Waiting for an opponent.');
      if (room.moves.length < 2) fail(400, 'Play a couple of moves first.');
      room.offerLog = room.offerLog || { w: -1, b: -1 };
      if (room.drawOffer && room.drawOffer !== seat) { room.drawn = true; await settle(room); }   // both want a draw
      else {
        if (room.offerLog[seat] === room.moves.length) fail(400, 'You already offered a draw this move.');
        room.drawOffer = seat;
        room.offerLog[seat] = room.moves.length;
      }
    }, { live: (r) => outcome(r).over });
    await RT.publish('room:' + room.code, 'sync', { v: room.v });
    return { ok: true };
  },

  async draw_accept(req, body) {
    const u = await auth(req);
    const { room } = await mutateRoom(body.code, async (room) => {
      const seat = seatOf(room, u.name);
      if (seat === 's') fail(403, 'Spectators cannot accept draws.');
      if (outcome(room).over) fail(400, 'Game is over.');
      if (!room.drawOffer || room.drawOffer === seat) fail(400, 'There is no draw offer to accept.');
      room.drawn = true;
      await settle(room);
    });
    await RT.publish('room:' + room.code, 'sync', { v: room.v });
    return { ok: true };
  },

  async draw_decline(req, body) {
    const u = await auth(req);
    const { room, result } = await mutateRoom(body.code, (room) => {
      const seat = seatOf(room, u.name);
      if (seat === 's' || !room.drawOffer || room.drawOffer === seat) return { noWrite: true };
      room.drawOffer = null;
      return { changed: true };
    }, { live: false });
    if (result && result.changed) await RT.publish('room:' + room.code, 'sync', { v: room.v });
    return { ok: true };
  },

  async rematch(req, body) {
    const u = await auth(req);
    const { room } = await mutateRoom(body.code, async (room) => {
      const seat = seatOf(room, u.name);
      if (seat === 's') fail(403, 'Spectators cannot rematch.');
      if (!outcome(room).over) fail(400, 'Game still in progress.');
      if (!room.rematch.includes(seat)) room.rematch.push(seat);
      if (room.rematch.length === 2) {
        const [a, b] = [room.players.w, room.players.b];
        const [ua, ub] = await Promise.all([getUser(a.name), getUser(b.name)]);
        const cat = room.cat || R.category(room.tc);
        room.players = { w: seatInfo(ub || { name: b.name }, cat), b: seatInfo(ua || { name: a.name }, cat) };
        freshGame(room, Date.now());
      }
    });
    await RT.publish('room:' + room.code, 'sync', { v: room.v });
    return { ok: true };
  },

  async chat_send(req, body) {
    const u = await auth(req), now = Date.now();
    if (u.muted) fail(403, 'You are muted.');
    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) fail(400, 'Type a message first.');
    const rk = 'rate:' + u.name.toLowerCase();
    if (await store.get(rk)) fail(429, 'Slow down a little.');
    await store.set(rk, 1, 2);
    const chat = (await store.get('chat:lobby')) || [];
    const msg = { id: crypto.randomUUID().slice(0, 8), name: u.name, text, ts: now, admin: !!u.admin };
    chat.push(msg);
    await store.set('chat:lobby', chat.slice(-60));
    await RT.publish('lobby', 'chat', msg);
    return { ok: true, msg };
  },

  // Unlock admin on this account with the ADMIN_KEY set in the server environment.
  async admin_claim(req, body) {
    const u = await auth(req);
    const key = process.env.ADMIN_KEY;
    if (!key) fail(403, 'Admin access is not set up on this server.');
    const fk = 'afail:' + u.name.toLowerCase();
    const fails = (await store.get(fk)) || 0;
    if (fails >= 5) fail(429, 'Too many attempts. Try again later.');
    const h = (x) => crypto.createHash('sha256').update(String(x)).digest();
    if (!crypto.timingSafeEqual(h(body.key || ''), h(key))) {
      await store.set(fk, fails + 1, 900);
      fail(403, 'Wrong admin key.');
    }
    u.admin = true;
    await saveUser(u);
    return { ok: true };
  },

  async admin_overview(req) {
    await needAdmin(req);
    const now = Date.now();
    const [lb, live, chat, ann] = await Promise.all([store.get('lb'), store.get('live'), store.get('chat:lobby'), store.get('announce')]);
    const users = (await Promise.all(Object.keys(lb || {}).map((n) => getUser(n)))).filter(Boolean).map((x) => ({
      name: x.name, email: x.email || '', elo: R.show(R.ratingOf(x, 'blitz')).r, ratings: R.summary(x), w: x.w || 0, l: x.l || 0, d: x.d || 0, muted: !!x.muted, admin: !!x.admin, created: x.created || 0,
    })).sort((a2, b2) => b2.created - a2.created);
    const games = (live || []).filter((g) => now - g.ts < LIVE_TTL);
    return { users, live: games, announce: ann ? ann.text : '', stats: { users: users.length, live: games.length, chat: (chat || []).length } };
  },

  async admin_mute(req, body) {
    await needAdmin(req);
    const t = await getUser(String(body.name || ''));
    if (!t) fail(404, 'No such player.');
    if (t.admin) fail(400, "Can't mute an admin.");
    t.muted = !!body.muted;
    await saveUser(t);
    return { ok: true };
  },

  async admin_reset(req, body) {
    await needAdmin(req);
    const t = await getUser(String(body.name || ''));
    if (!t) fail(404, 'No such player.');
    Object.assign(t, { elo: START_ELO, ratings: {}, w: 0, l: 0, d: 0 });
    await saveUser(t);
    await bumpLeaderboard(t);
    return { ok: true };
  },

  async admin_delete(req, body) {
    await needAdmin(req);
    const t = await getUser(String(body.name || ''));
    if (!t) fail(404, 'No such player.');
    if (t.admin) fail(400, "Can't delete an admin account.");
    const live = (await store.get('live')) || [];
    for (const g of live) {
      if (g.w.name !== t.name && g.b.name !== t.name) continue;
      try {
        await mutateRoom(g.code, (r) => { if (outcome(r).over) return { noWrite: true }; r.aborted = true; r.settled = true; r.endedAt = Date.now(); });
        await RT.publish('room:' + g.code, 'sync', {});
      } catch (e) { /* room already gone */ }
    }
    await store.set('live', live.filter((g) => g.w.name !== t.name && g.b.name !== t.name), 3600);
    await store.del(ukey(t.name));
    if (t.email) await store.del(ekey(t.email));
    const lb = (await store.get('lb')) || {};
    delete lb[t.name];
    await store.set('lb', lb);
    return { ok: true };
  },

  async admin_abort(req, body) {
    await needAdmin(req);
    const { room } = await mutateRoom(body.code, (room) => {
      if (outcome(room).over) fail(400, 'That game is already over.');
      room.aborted = true;
      room.settled = true;                 // no rating change
      room.endedAt = Date.now();
    });
    await RT.publish('room:' + room.code, 'sync', { v: room.v });
    return { ok: true };
  },

  async admin_clear_chat(req) { await needAdmin(req); await store.set('chat:lobby', []); return { ok: true }; },

  async admin_delete_msg(req, body) {
    await needAdmin(req);
    const chat = (await store.get('chat:lobby')) || [];
    await store.set('chat:lobby', chat.filter((m) => m.id !== body.id));
    return { ok: true };
  },

  async admin_announce(req, body) {
    await needAdmin(req);
    await store.set('announce', { text: String(body.text || '').trim().slice(0, 200), ts: Date.now() });
    return { ok: true };
  },

  async challenge(req, body) {
    const now = Date.now(), ok = 'outbox:' + hname(req);
    const [u, target, prev] = await Promise.all([auth(req), getUser(String(body.to || '').trim()), store.get(ok)]);
    if (!target) fail(404, 'No player with that name.');
    if (target.name === u.name) fail(400, "You can't challenge yourself.");
    const live = prev && prev.status === 'pending' && now - prev.ts < CHALLENGE_TTL;
    if (live && prev.to === target.name) return { ok: true, id: prev.id }; // double-click / retry: already sent
    if (live) { // switching opponent: withdraw the old challenge first
      const pk = 'inbox:' + prev.to.toLowerCase();
      const pin = (await store.get(pk)) || [];
      await store.set(pk, pin.filter((c) => c.id !== prev.id), 3600);
    }
    const ik = 'inbox:' + target.name.toLowerCase();
    const inbox = ((await store.get(ik)) || []).filter((c) => now - c.ts < CHALLENGE_TTL && c.from !== u.name);
    const ctc = cleanTc(body.tc), cat = R.category(ctc), mine = R.show(R.ratingOf(u, cat));
    const ch = { id: crypto.randomUUID().slice(0, 8), from: u.name, fromElo: mine.r, fromProv: mine.prov, cat, to: target.name, tc: ctc, ts: now };
    inbox.push(ch);
    await Promise.all([store.set(ik, inbox, 3600), store.set(ok, { ...ch, status: 'pending' }, 3600)]);
    await Promise.all([RT.publish(RT.userTopic(target), 'ping', { why: 'challenge' }), live ? notifyName(prev.to, 'ping') : null]);
    return { ok: true, id: ch.id };
  },

  async accept(req, body) {
    const now = Date.now(), ik = 'inbox:' + hname(req);
    const [u, inboxRaw] = await Promise.all([auth(req), store.get(ik)]);
    const inbox = inboxRaw || [];
    const ch = inbox.find((c) => c.id === body.id && now - c.ts < CHALLENGE_TTL);
    if (!ch) fail(404, 'That challenge expired.');
    const meFirst = Math.random() < 0.5;
    const cat = R.category(ch.tc), fromU = await getUser(ch.from);
    const me = seatInfo(u, cat), them = fromU ? seatInfo(fromU, cat) : { name: ch.from, elo: ch.fromElo };
    const room = await makeRoom({ w: meFirst ? me : them, b: meFirst ? them : me }, ch.tc, now);
    const ok = 'outbox:' + ch.from.toLowerCase();
    await Promise.all([
      store.set(ik, inbox.filter((c) => c.id !== ch.id), 3600),
      (async () => {
        const out = await store.get(ok);
        if (out && out.id === ch.id) await store.set(ok, { ...out, status: 'accepted', code: room.code }, 600);
      })(),
    ]);
    if (fromU) await RT.publish(RT.userTopic(fromU), 'ping', { why: 'accepted', code: room.code });
    return { code: room.code };
  },

  async decline(req, body) {
    const ik = 'inbox:' + hname(req);
    const [, inbox] = await Promise.all([auth(req), store.get(ik).then((x) => x || [])]);
    const ch = inbox.find((c) => c.id === body.id);
    await Promise.all([
      store.set(ik, inbox.filter((c) => c.id !== body.id), 3600),
      ch ? (async () => {
        const ok = 'outbox:' + ch.from.toLowerCase();
        const out = await store.get(ok);
        if (out && out.id === ch.id) await store.set(ok, { ...out, status: 'declined' }, 600);
      })() : null,
    ]);
    if (ch) await notifyName(ch.from, 'ping');
    return { ok: true };
  },

  async cancel(req) {
    const ok = 'outbox:' + hname(req);
    const [, out] = await Promise.all([auth(req), store.get(ok)]);
    if (out) {
      const ik = 'inbox:' + out.to.toLowerCase();
      const inbox = (await store.get(ik)) || [];
      await Promise.all([store.set(ik, inbox.filter((c) => c.id !== out.id), 3600), store.del(ok)]);
      if (out.status === 'pending') await notifyName(out.to, 'ping');
    }
    return { ok: true };
  },
};

async function notifyName(name, event) {
  const t = await getUser(name);
  if (t) await RT.publish(RT.userTopic(t), event, {});
}

async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 1e4) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });
}

module.exports = async function handler(req, res) {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (req.method !== 'POST') return send(405, { error: 'POST only.' });
    const route = new URL(req.url, 'http://x').searchParams.get('r');
    if (!Object.prototype.hasOwnProperty.call(routes, route)) return send(404, { error: 'Unknown route.' });
    send(200, await routes[route](req, await readBody(req)));
  } catch (e) {
    if (e instanceof HttpError) return send(e.code, { error: e.message });
    console.error(e);
    send(500, { error: 'Server error.' });
  }
};
