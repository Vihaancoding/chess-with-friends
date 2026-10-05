// API handler shared by local server.js and the Vercel function (api/index.js).
// Every call is POST /api?r=<route> with JSON body and x-name / x-token headers.
const crypto = require('crypto');
const Chess = require('../public/chess.js');
const store = require('./store');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const NAME_RE = /^[A-Za-z0-9_-]{2,16}$/;
const K = 32, START_ELO = 1200, ROOM_TTL = 3 * 3600, CHALLENGE_TTL = 10 * 60e3;
const other = (c) => (c === 'w' ? 'b' : 'w');

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };

// ---------- users ----------
const ukey = (n) => 'user:' + n.toLowerCase();
const getUser = (n) => store.get(ukey(n));
const saveUser = (u) => store.set(ukey(u.name), u);
const pub = (u) => ({ name: u.name, elo: u.elo, w: u.w, l: u.l, d: u.d });

async function bumpLeaderboard(u) {
  const lb = (await store.get('lb')) || {};
  lb[u.name] = { elo: u.elo, w: u.w, l: u.l, d: u.d };
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
  const u = { name, email, salt, hash, token: crypto.randomUUID(), elo: START_ELO, w: 0, l: 0, d: 0 };
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

async function auth(req) {
  const name = req.headers['x-name'], token = req.headers['x-token'];
  const u = name && token ? await getUser(String(name)) : null;
  if (!u || u.token !== token) fail(401, 'Please sign in again.');
  return u;
}

// ---------- rooms ----------
const rkey = (c) => 'room:' + c;
const saveRoom = (r) => store.set(rkey(r.code), r, ROOM_TTL);

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
  room.rematch = [];
  room.clock = room.tc ? { w: room.tc.base * 1000, b: room.tc.base * 1000, ts: now } : null;
}

async function makeRoom(players, tc, now) {
  let code;
  do code = Array.from({ length: 5 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  while (await store.get(rkey(code)));
  const room = { code, tc: cleanTc(tc), players, seen: {} };
  freshGame(room, now);
  await saveRoom(room);
  return room;
}

const seatOf = (room, name) =>
  room.players.w && room.players.w.name === name ? 'w' : room.players.b && room.players.b.name === name ? 'b' : 's';

function outcome(room) {
  if (room.resigned) return { over: true, result: other(room.resigned), reason: 'resignation', check: false };
  if (room.timeout) return { over: true, result: other(room.timeout), reason: 'timeout', check: false };
  return Chess.status(room.state);
}

// Flag the side to move if their clock has run out. Returns true if state changed.
function tick(room, now) {
  if (!room.tc || room.resigned || room.timeout) return false;
  if (!room.players.w || !room.players.b || room.moves.length < 2) return false;
  if (Chess.status(room.state).over) return false;
  const t = room.state.turn;
  if (room.clock[t] - (now - room.clock.ts) <= 0) { room.clock[t] = 0; room.timeout = t; return true; }
  return false;
}

// Apply Elo once when a game ends.
async function settle(room) {
  const o = outcome(room);
  if (!o.over || room.settled) return false;
  room.settled = true;
  if (room.players.w && room.players.b) {
    const uw = await getUser(room.players.w.name), ub = await getUser(room.players.b.name);
    if (uw && ub) {
      const sw = o.result === 'w' ? 1 : o.result === 'b' ? 0 : 0.5;
      const ew = 1 / (1 + Math.pow(10, (ub.elo - uw.elo) / 400));
      const dw = Math.round(K * (sw - ew));
      uw.elo += dw; ub.elo -= dw;
      for (const [u, s] of [[uw, sw], [ub, 1 - sw]]) { if (s === 1) u.w++; else if (s === 0) u.l++; else u.d++; }
      await Promise.all([saveUser(uw), saveUser(ub)]);
      const lb = (await store.get('lb')) || {};
      for (const u of [uw, ub]) lb[u.name] = { elo: u.elo, w: u.w, l: u.l, d: u.d };
      await store.set('lb', lb);
      room.delta = { w: dw, b: -dw };
    }
  }
  return true;
}

function snapshot(room, name, now) {
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
    present: { w: now - (room.seen.w || 0) < 7000, b: now - (room.seen.b || 0) < 7000 },
    tc: room.tc,
    clock: room.clock ? { w: left('w'), b: left('b'), running: run } : null,
    delta: room.delta,
    rematch: room.rematch,
  };
}

// ---------- routes ----------
const routes = {
  async signup(req, body) { return signup(body); },
  async login(req, body) { return login(body); },
  async resume(req, body) { return resume(body); },

  async me(req) {
    const u = await auth(req), now = Date.now();
    const inbox = ((await store.get('inbox:' + u.name.toLowerCase())) || []).filter((c) => now - c.ts < CHALLENGE_TTL);
    let outbox = await store.get('outbox:' + u.name.toLowerCase());
    if (outbox && outbox.status === 'pending' && now - outbox.ts > CHALLENGE_TTL) outbox = null;
    const lb = (await store.get('lb')) || {};
    const board = Object.entries(lb).map(([name, s]) => ({ name, ...s })).sort((a, b) => b.elo - a.elo).slice(0, 25);
    return { user: pub(u), inbox, outbox, leaderboard: board };
  },

  async create(req, body) {
    const u = await auth(req), now = Date.now();
    const color = body.color === 'w' || body.color === 'b' ? body.color : Math.random() < 0.5 ? 'w' : 'b';
    const players = { w: null, b: null };
    players[color] = { name: u.name, elo: u.elo };
    const room = await makeRoom(players, body.tc, now);
    return { code: room.code };
  },

  async join(req, body) {
    const u = await auth(req), now = Date.now();
    const room = await loadRoom(body.code);
    if (seatOf(room, u.name) === 's') {
      const c = !room.players.w ? 'w' : !room.players.b ? 'b' : null;
      if (c) {
        room.players[c] = { name: u.name, elo: u.elo };
        if (room.clock) room.clock.ts = now;
        await saveRoom(room);
      }
    }
    return { code: room.code };
  },

  async room(req, body) {
    const u = await auth(req), now = Date.now();
    const room = await loadRoom(body.code);
    let dirty = tick(room, now);
    if (dirty) await settle(room);
    const seat = seatOf(room, u.name);
    if (seat !== 's' && now - (room.seen[seat] || 0) > 3000) { room.seen[seat] = now; dirty = true; }
    if (dirty) await saveRoom(room);
    return snapshot(room, u.name, now);
  },

  async move(req, body) {
    const u = await auth(req), now = Date.now();
    const room = await loadRoom(body.code);
    const seat = seatOf(room, u.name);
    if (seat === 's') fail(403, 'Spectators cannot play.');
    if (!room.players.w || !room.players.b) fail(400, 'Waiting for an opponent.');
    if (tick(room, now)) { await settle(room); await saveRoom(room); fail(400, 'Time ran out.'); }
    if (outcome(room).over) fail(400, 'Game is over.');
    if (room.state.turn !== seat) fail(400, 'Not your turn.');
    const m = Chess.legalMoves(room.state).find(
      (x) => x.from === body.from && x.to === body.to && (x.promo || null) === (body.promo || null));
    if (!m) fail(400, 'Illegal move.');
    if (room.tc) {
      if (room.moves.length >= 2) room.clock[seat] += room.tc.inc * 1000 - (now - room.clock.ts);
      room.clock.ts = now;
    }
    room.moves.push(Chess.notate(room.state, m));
    room.state = Chess.apply(room.state, m);
    room.last = { from: m.from, to: m.to };
    await settle(room);
    await saveRoom(room);
    return { ok: true };
  },

  async resign(req, body) {
    const u = await auth(req);
    const room = await loadRoom(body.code);
    const seat = seatOf(room, u.name);
    if (seat === 's') fail(403, 'Spectators cannot resign.');
    if (outcome(room).over) fail(400, 'Game is over.');
    room.resigned = seat;
    await settle(room);
    await saveRoom(room);
    return { ok: true };
  },

  async rematch(req, body) {
    const u = await auth(req), now = Date.now();
    const room = await loadRoom(body.code);
    const seat = seatOf(room, u.name);
    if (seat === 's') fail(403, 'Spectators cannot rematch.');
    if (!outcome(room).over) fail(400, 'Game still in progress.');
    if (!room.rematch.includes(seat)) room.rematch.push(seat);
    if (room.rematch.length === 2) {
      const [a, b] = [room.players.w, room.players.b];
      const [ua, ub] = await Promise.all([getUser(a.name), getUser(b.name)]);
      room.players = { w: { name: b.name, elo: ub.elo }, b: { name: a.name, elo: ua.elo } };
      freshGame(room, now);
    }
    await saveRoom(room);
    return { ok: true };
  },

  async challenge(req, body) {
    const u = await auth(req), now = Date.now();
    const target = await getUser(String(body.to || '').trim());
    if (!target) fail(404, 'No player with that name.');
    if (target.name === u.name) fail(400, "You can't challenge yourself.");
    const ik = 'inbox:' + target.name.toLowerCase();
    const inbox = ((await store.get(ik)) || []).filter((c) => now - c.ts < CHALLENGE_TTL && c.from !== u.name);
    const ch = { id: crypto.randomUUID().slice(0, 8), from: u.name, fromElo: u.elo, to: target.name, tc: cleanTc(body.tc), ts: now };
    inbox.push(ch);
    await store.set(ik, inbox, 3600);
    await store.set('outbox:' + u.name.toLowerCase(), { ...ch, status: 'pending' }, 3600);
    return { ok: true };
  },

  async accept(req, body) {
    const u = await auth(req), now = Date.now();
    const ik = 'inbox:' + u.name.toLowerCase();
    const inbox = (await store.get(ik)) || [];
    const ch = inbox.find((c) => c.id === body.id && now - c.ts < CHALLENGE_TTL);
    if (!ch) fail(404, 'That challenge expired.');
    const from = await getUser(ch.from);
    const meFirst = Math.random() < 0.5;
    const players = {
      w: meFirst ? { name: u.name, elo: u.elo } : { name: from.name, elo: from.elo },
      b: meFirst ? { name: from.name, elo: from.elo } : { name: u.name, elo: u.elo },
    };
    const room = await makeRoom(players, ch.tc, now);
    await store.set(ik, inbox.filter((c) => c.id !== ch.id), 3600);
    const ok = 'outbox:' + from.name.toLowerCase();
    const out = await store.get(ok);
    if (out && out.id === ch.id) await store.set(ok, { ...out, status: 'accepted', code: room.code }, 600);
    return { code: room.code };
  },

  async decline(req, body) {
    const u = await auth(req);
    const ik = 'inbox:' + u.name.toLowerCase();
    const inbox = (await store.get(ik)) || [];
    const ch = inbox.find((c) => c.id === body.id);
    await store.set(ik, inbox.filter((c) => c.id !== body.id), 3600);
    if (ch) {
      const ok = 'outbox:' + ch.from.toLowerCase();
      const out = await store.get(ok);
      if (out && out.id === ch.id) await store.set(ok, { ...out, status: 'declined' }, 600);
    }
    return { ok: true };
  },

  async cancel(req) {
    const u = await auth(req);
    const ok = 'outbox:' + u.name.toLowerCase();
    const out = await store.get(ok);
    if (out) {
      const ik = 'inbox:' + out.to.toLowerCase();
      const inbox = (await store.get(ik)) || [];
      await store.set(ik, inbox.filter((c) => c.id !== out.id), 3600);
      await store.del(ok);
    }
    return { ok: true };
  },
};

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
