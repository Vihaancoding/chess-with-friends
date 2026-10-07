// API handler shared by local server.js and the Vercel function (api/index.js).
// Every call is POST /api?r=<route> with JSON body and x-name / x-token headers.
const crypto = require('crypto');
const zlib = require('zlib');
const Chess = require('../public/chess.js');
const store = require('./store');
const R = require('./rating');
const RT = require('./realtime');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const NAME_RE = /^[A-Za-z0-9_-]{2,16}$/;
const START_ELO = 1200, ROOM_TTL = 3 * 3600, CHALLENGE_TTL = 10 * 60e3;
const other = (c) => (c === 'w' ? 'b' : 'w');

// ---------- request stage timing (sent as a Server-Timing header; also logged when PERF=1) ----------
const TM = Symbol('timing');
function tmark(req, name) {
  const t = req && req[TM]; if (!t) return;
  const n = performance.now(); t.marks.push([name, n - t.last]); t.last = n;
}
const perfLog = [];
// Run non-critical work after the response is on its way. On Vercel this uses waitUntil so the work is not cut off.
function later(p) {
  p = Promise.resolve(p).catch((e) => console.error('background task failed:', e && e.message));
  const ctx = globalThis[Symbol.for('@vercel/request-context')];
  const c = ctx && ctx.get && ctx.get();
  if (c && c.waitUntil) { c.waitUntil(p); return null; }
  return process.env.VERCEL ? p : null;   // no waitUntil available: caller awaits it before responding
}

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
  const recovery = newRecovery(u);
  await saveUser(u);
  await store.set(ekey(email), { name });
  await bumpLeaderboard(u);
  return { ...pub(u), token: u.token, recovery };
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

// ---------- account recovery ----------
// Two ways back in after a forgotten password, both ending in a new password and a new session token
// (which signs out every other device):
//  1. a recovery code, shown once at sign-up (and whenever it is regenerated); only its hash is stored
//  2. a one-time reset link, emailed when an email service is configured (RESEND_API_KEY + MAIL_FROM),
//     or created by an admin from the admin panel and passed on by hand
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const RESET_TTL = 30 * 60, ADMIN_RESET_TTL = 24 * 3600;
const mailOn = () => !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
const appUrl = () => (process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : 'http://localhost:' + (process.env.PORT || 3000))).replace(/\/$/, '');

// Make a fresh recovery code (XXXX-XXXX-XXXX-XXXX) for u, store its hash and return the plain code once.
function newRecovery(u) {
  const b = crypto.randomBytes(16);
  const code = Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join('').match(/.{4}/g).join('-');
  u.recovery = sha(normCode(code));
  return code;
}

async function setPassword(u, pw) {
  if (pw.length < 8 || pw.length > 128) fail(400, 'Password must be 8-128 characters.');
  u.salt = crypto.randomBytes(16).toString('hex');
  u.hash = (await scrypt(pw, u.salt)).toString('hex');
  u.token = crypto.randomUUID();                       // sign out everywhere else
  authCache.delete(u.name.toLowerCase());
  if (u.email) await store.del('fail:' + u.email);     // lift any login lockout
}

async function newResetToken(u, ttl) {
  const token = crypto.randomBytes(24).toString('base64url');
  await store.set('reset:' + sha(token), { name: u.name, ts: Date.now() }, ttl);
  return token;
}

async function sendMail(to, subject, text) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}

// Recovery code + new password. The used code is replaced by a new one, returned so the player can save it.
async function recover(body) {
  const email = String(body.email || '').trim().toLowerCase(), code = normCode(body.code), pw = String(body.password || '');
  const fk = 'rfail:' + email;
  const fails = (await store.get(fk)) || 0;
  if (fails >= 5) fail(429, 'Too many attempts. Try again in 15 minutes.');
  const m = EMAIL_RE.test(email) ? await store.get(ekey(email)) : null;
  const u = m && (await getUser(m.name));
  const ok = u && u.recovery && code.length === 16 && crypto.timingSafeEqual(Buffer.from(sha(code), 'hex'), Buffer.from(u.recovery, 'hex'));
  if (!ok) {
    await store.set(fk, fails + 1, 900);
    fail(401, 'That email and recovery code do not match.');
  }
  await setPassword(u, pw);
  const recovery = newRecovery(u);
  await saveUser(u);
  await store.del(fk);
  return { ...pub(u), token: u.token, recovery };
}

// Email a reset link. Always answers the same way so it can't be used to find out who has an account.
async function forgot(body) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) fail(400, 'Enter a valid email address.');
  const dev = !mailOn() && !store.persistent;
  if (!mailOn() && !dev) fail(501, "Email resets aren't set up on this server. Use your recovery code, or ask an admin for a reset link.");
  const sent = { ok: true, msg: 'If that email has an account, a reset link is on its way. It works for 30 minutes.' };
  if (await store.get('fmail:' + email)) return sent;    // one email a minute per address
  await store.set('fmail:' + email, 1, 60);
  const m = await store.get(ekey(email));
  const u = m && (await getUser(m.name));
  if (!u) return sent;
  const link = `${appUrl()}/?reset=${await newResetToken(u, RESET_TTL)}`;
  if (dev) { console.log(`\n  Password reset link for ${u.name} (no email service configured): ${link}\n`); return sent; }
  await sendMail(email, 'Reset your Chess password',
    `Hi ${u.name},\n\nSomeone (hopefully you) asked to reset the password for your Chess account.\n` +
    `Open this link within 30 minutes to choose a new one:\n\n${link}\n\nIf you didn't ask for this, ignore this email; your password stays the same.`);
  return sent;
}

// Use a reset link: one-time token + new password.
async function resetWithToken(body) {
  const token = String(body.token || ''), pw = String(body.password || '');
  if (pw.length < 8 || pw.length > 128) fail(400, 'Password must be 8-128 characters.');
  const k = 'reset:' + sha(token);
  const t = token && (await store.get(k));
  const u = t && (await getUser(t.name));
  if (!u) fail(400, 'This reset link has expired or was already used. Ask for a new one.');
  await store.del(k);
  await setPassword(u, pw);
  await saveUser(u);
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

// Hot game routes only need "is this token valid for this name": cache that per warm instance.
const authCache = new Map();
async function authFast(req) {
  const n = String(req.headers['x-name'] || '').toLowerCase(), tok = req.headers['x-token'];
  const c = authCache.get(n);
  if (c && c.token === tok && c.exp > Date.now()) return c.u;
  const u = await auth(req);
  authCache.set(n, { token: u.token, exp: Date.now() + 60e3, u: { name: u.name, token: u.token } });
  if (authCache.size > 2000) authCache.delete(authCache.keys().next().value);
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
// wrote in between (compare-and-swap on room.v), otherwise we re-read and run fn again.
// Warm instances keep the last room they saw, so a move usually skips the database read entirely; the CAS
// still guarantees correctness, and anything decided on a stale copy is retried on fresh data.
const roomCache = new Map();
const chatRate = new Map();
function chatThrottle(key) {
  const now = Date.now(), last = chatRate.get(key) || 0;
  if (now - last < 700) fail(429, 'Slow down a little.');
  chatRate.delete(key); chatRate.set(key, now);
  if (chatRate.size > 2000) chatRate.delete(chatRate.keys().next().value);
}

// Chat logs are stored as { v, list }. Older data is a bare array; both read the same.
const chatList = (raw) => (Array.isArray(raw) ? raw : raw && Array.isArray(raw.list) ? raw.list : []);
// Change a chat log without losing messages when two people send at the same moment (compare-and-swap on v).
async function editChat(key, fn, ttl) {
  for (let i = 0; i < 6; i++) {
    const raw = await store.get(key);
    const prevV = raw && !Array.isArray(raw) ? raw.v : null;
    const v = (prevV || 0) + 1, next = { v, list: fn(chatList(raw), v) };   // v doubles as the message number
    // an expired row still blocks create(); after one clash, overwrite it
    const ok = raw == null ? (await store.create(key, next, ttl)) || (i > 0 && (await store.set(key, next, ttl), true))
      : await store.cas(key, next, prevV, ttl);
    if (ok) return next.list;
  }
  fail(503, 'Chat is busy, try again.');
}
// ---------- who is online: one shared map { name: { ts, st } }, refreshed by lobby polls and game heartbeats ----------
const ONLINE_MS = 60e3, ONLINE_REFRESH = 25e3, SEEN_MS = 7 * 86400e3, OFFLINE_SHOWN = 50;
const onlineSeen = new Map();                                   // per-instance throttle: name -> { ts, st } last written
// online players (by name), then offline ones: most recently seen first, then everyone else on the leaderboard
// A player in a live game with a move in the last 2 minutes is playing, even if their own presence write was missed.
function onlineList(raw, lb, live, me, now) {
  const map = { ...((raw && raw.list) || {}) };
  for (const g of live || []) {
    if (now - g.ts > 120e3) continue;
    for (const p of [g.w, g.b]) if (p && (!map[p.name] || now - map[p.name].ts >= ONLINE_MS)) map[p.name] = { ts: now, st: 'playing' };
  }
  if (!map[me] || now - map[me].ts >= ONLINE_MS) map[me] = { ts: now, st: 'lobby' };
  const on = [], off = [];
  for (const [name, x] of Object.entries(map)) (now - x.ts < ONLINE_MS ? on : off).push({ name, st: x.st, seen: x.ts });
  for (const name of Object.keys(lb || {})) if (!map[name]) off.push({ name, seen: 0 });
  on.sort((a, b) => a.name.localeCompare(b.name));
  off.sort((a, b) => (b.seen - a.seen) || a.name.localeCompare(b.name));
  return on.map(({ name, st }) => ({ name, st })).concat(off.slice(0, OFFLINE_SHOWN).map(({ name, seen }) => ({ name, st: 'offline', seen })));
}
async function markOnline(name, st, raw0) {
  const now = Date.now(), last = onlineSeen.get(name);
  if (last && last.st === st && now - last.ts < ONLINE_REFRESH) return;
  onlineSeen.set(name, { ts: now, st });
  if (onlineSeen.size > 2000) onlineSeen.delete(onlineSeen.keys().next().value);
  for (let i = 0; i < 4; i++) {
    const raw = i === 0 && raw0 !== undefined ? raw0 : await store.get('online');
    const cur = raw && raw.list && raw.list[name];
    if (cur && cur.st === st && now - cur.ts < ONLINE_REFRESH) return;
    const list = {};
    const kept = Object.entries((raw && raw.list) || {}).filter(([, x]) => now - x.ts < SEEN_MS).sort((a, b) => b[1].ts - a[1].ts).slice(0, 500);
    for (const [n, x] of kept) list[n] = x;                      // keep a week of "last seen" times
    list[name] = { ts: now, st };
    const next = { v: ((raw && raw.v) || 0) + 1, list };
    const ok = raw == null ? (await store.create('online', next)) || (i > 0 && (await store.set('online', next), true))
      : await store.cas('online', next, raw.v);
    if (ok) return;
  }
}
// a room for read-only checks (who is seated): the warm cache is fine, otherwise read it
async function roomFor(code) { const c = roomCache.get(code); return c ? JSON.parse(c) : loadRoom(code); }
function cachePut(room) {
  roomCache.delete(room.code); roomCache.set(room.code, JSON.stringify(room));
  if (roomCache.size > 500) roomCache.delete(roomCache.keys().next().value);
}
async function mutateRoom(code, fn, { live = true, req = null } = {}) {
  code = String(code || '').toUpperCase();
  let useCache = roomCache.has(code);
  for (let attempt = 0; attempt < 6; attempt++) {
    const room = useCache ? JSON.parse(roomCache.get(code)) : await loadRoom(code);
    tmark(req, useCache ? 'cache' : 'read');
    const prevV = room.v;
    let result;
    try { result = await fn(room); }
    catch (e) { if (useCache && e instanceof HttpError) { useCache = false; continue; } throw e; }
    tmark(req, 'validate');
    if (result && result.noWrite) {
      if (useCache) { useCache = false; continue; }   // only trust "nothing to do" on fresh data
      return { room, result };
    }
    room.v = (prevV || 0) + 1;
    const pend = room._settle; delete room._settle;
    const ok = await store.cas(rkey(room.code), room, prevV, ROOM_TTL);
    tmark(req, 'write');
    if (ok) {
      cachePut(room);
      const doLive = typeof live === 'function' ? live(room) : live;
      if (pend) await applySettle(room, pend);
      if (doLive) { const bg = later(touchLive(room, Date.now())); if (bg) await bg; }
      return { room, result };
    }
    useCache = false; roomCache.delete(code);
    // If nobody else changed the room, the conditional write itself is not working on this database:
    // never let that break a game; write normally and stop using the conditional write in this instance.
    const fresh = await store.get(rkey(code));
    if (fresh && fresh.v === prevV) {
      console.error('conditional write did not match an unchanged row; falling back to plain writes');
      store.casBroken = true;
      await store.set(rkey(room.code), room, ROOM_TTL);
      cachePut(room);
      if (pend) await applySettle(room, pend);
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
  cachePut(room);
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
  room.paused = false; room.pauseReq = null; room.resumeReady = []; room.pauseCount = { w: 0, b: 0 };
  room.clock = room.tc ? { w: room.tc.base * 1000, b: room.tc.base * 1000, ts: now } : null;
}

async function makeRoom(players, tc, now) {
  const ctc = cleanTc(tc);
  for (let i = 0; i < 8; i++) {
    const code = Array.from({ length: 5 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
    const room = { code, tc: ctc, cat: R.category(ctc), players, seen: {}, v: 1 };
    freshGame(room, now);
    if (await store.create(rkey(code), room, ROOM_TTL)) {          // one insert, no read-before-write
      cachePut(room);
      const bg = later(touchLive(room, now)); if (bg) await bg;
      return room;
    }
  }
  fail(503, 'Could not create a game. Try again.');
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
  if (!room.tc || room.paused || room.resigned || room.timeout || room.drawn || room.rep || room.aborted) return false;
  if (!room.players.w || !room.players.b || room.moves.length < 2) return false;
  if (Chess.status(room.state).over) return false;
  const t = room.state.turn;
  if (room.clock[t] - (now - room.clock.ts) <= 0) { room.clock[t] = 0; room.timeout = t; return true; }
  return false;
}

// When a game ends inside a move/resign/etc, we only *mark* it (no database reads, no rating math).
// Ratings are computed afterwards by settleGame(), off the critical path, exactly once (CAS-protected).
function markEnded(room) {
  if (!outcome(room).over || room.settled || room.endedAt) return false;
  room.endedAt = Date.now();
  const both = !!(room.players.w && room.players.b);
  if (room.aborted || !both || room.moves.length < 2) {         // like chess.com: no rating change before both sides moved
    room.settled = true;
    room.unrated = both && !room.aborted && room.moves.length < 2;
    return true;
  }
  room.settlePending = true;
  return true;
}
async function settleGame(code) {
  const { room, result } = await mutateRoom(code, async (r) => {
    if (r.settled || !outcome(r).over) return { noWrite: true };
    r.settled = true; r.settlePending = false;
    if (!r.endedAt) r.endedAt = Date.now();
    const [uw, ub] = await Promise.all([getUser(r.players.w.name), getUser(r.players.b.name)]);
    if (!uw || !ub) return;
    const cat = r.cat || R.category(r.tc), o = outcome(r);
    const sw = o.result === 'w' ? 1 : o.result === 'b' ? 0 : 0.5;
    const ow = R.ratingOf(uw, cat), ob = R.ratingOf(ub, cat);
    const [nw, nb] = R.rateGame(ow, ob, sw, r.endedAt);
    const line = (o1, n1) => ({ before: Math.round(o1.r), after: Math.round(n1.r), delta: Math.round(n1.r) - Math.round(o1.r), prov: R.provisional(n1) });
    r.ratings = { w: line(ow, nw), b: line(ob, nb) };
    r.delta = { w: r.ratings.w.delta, b: r.ratings.b.delta };
    r._settle = { cat, sw, nw, nb };
  }, { live: false });
  if (!(result && result.noWrite)) await RT.publish('room:' + room.code, 's', { v: room.v });
}
// call after a mutation that may have ended the game
async function afterEnd(room) { if (room.settlePending && !room.settled) { const bg = later(settleGame(room.code)); if (bg) await bg; } }

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
  const live = room.tc && room.players.w && room.players.b && room.moves.length >= 2 && !o.over && !room.paused;
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
    paused: !!room.paused && !o.over, pauseReq: room.pauseReq || null, resumeReady: room.resumeReady || [],
  };
}

async function roomState(req, code0, v) {
  const now = Date.now(), code = String(code0 || '').toUpperCase(), pk = 'pres:' + code;
  const [u, [room, pres0, chatN]] = await Promise.all([authFast(req), store.getMany([rkey(code), pk, 'gchatn:' + code])]);   // one database read
  if (!room) fail(404, 'No game with that code.');
  cachePut(room);
  const c = chatN ? chatN.k : 0;                                                    // number of the newest chat message
  tmark(req, 'read');
  let cur = room;
  if (tick({ ...room, clock: room.clock && { ...room.clock } }, now)) {             // someone's flag fell
    const res = await mutateRoom(code, (r) => { if (!tick(r, now)) return { noWrite: true }; markEnded(r); });
    cur = res.room;
    RT.publish('room:' + code, 's', { v: cur.v });
    await afterEnd(cur);
  } else if (cur.settlePending && !cur.settled && now - (cur.endedAt || 0) > 3000) {
    const bg = later(settleGame(code)); if (bg) await bg;                           // recovery if a background settle was lost
  }
  const pres = pres0 || { w: 0, b: 0, spec: {} };
  pres.spec = pres.spec || {};
  const seat = seatOf(cur, u.name);
  let pdirty = false;
  if (seat !== 's') { if (now - (pres[seat] || 0) > 3000) { pres[seat] = now; pdirty = true; } }
  else if (now - (pres.spec[u.name] || 0) > 3000) {
    pres.spec[u.name] = now; pdirty = true;
    for (const k of Object.keys(pres.spec)) if (now - pres.spec[k] > 30000) delete pres.spec[k];
  }
  if (pdirty) { const bg = later(store.set(pk, pres, ROOM_TTL)); if (bg) await bg; }   // presence is not critical: write in the background
  const ost = seat === 's' ? 'watching' : outcome(cur).over ? 'lobby' : 'playing';
  { const bg = later(markOnline(u.name, ost)); if (bg) await bg; }                 // throttled: writes at most every 25s per player
  if (v != null && v === (cur.v || 0)) {
    return { v, c, p: [now - (pres.w || 0) < 7000 ? 1 : 0, now - (pres.b || 0) < 7000 ? 1 : 0], n: Object.values(pres.spec).filter((t) => now - t < 7000).length };
  }
  return { c, full: snapshot(cur, u.name, now, pres) };
}

// Freeze the game: charge the running clock up to now, then stop it.
function pauseNow(room) {
  const now = Date.now();
  if (room.clock && room.moves.length >= 2) { room.clock[room.state.turn] -= now - room.clock.ts; }
  if (room.clock) room.clock.ts = now;
  room.paused = true; room.pausedAt = now; room.pauseReq = null; room.resumeReady = [];
}

// ---------- routes ----------
const routes = {
  async signup(req, body) { return signup(body); },
  async login(req, body) { return login(body); },
  async resume(req, body) { return resume(body); },
  async recover(req, body) { return recover(body); },
  async forgot(req, body) { return forgot(body); },
  async reset_password(req, body) { return resetWithToken(body); },
  async recovery_new(req) {
    const u = await auth(req);
    const recovery = newRecovery(u);
    await saveUser(u);
    return { recovery };
  },

  async me(req) {
    const now = Date.now(), lname = hname(req);
    const [u, inboxRaw, outboxRaw, lb, chat, live, ann, onlineRaw] = await Promise.all([
      auth(req), store.get('inbox:' + lname), store.get('outbox:' + lname), store.get('lb'),
      store.get('chat:lobby'), store.get('live'), store.get('announce'), store.get('online'),
    ]);
    const bgo = later(markOnline(u.name, 'lobby', onlineRaw)); if (bgo) await bgo;
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
      chat: chatList(chat).slice(-50),
      live: (live || []).filter((g) => now - g.ts < LIVE_TTL),
      announce: ann && ann.text ? ann.text : '',
      online: onlineList(onlineRaw, lb, live, u.name, now),
    };
  },

  config() {
    // ICE servers for voice calls: a public STUN server, plus an optional TURN relay if configured
    const ice = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    if (process.env.TURN_URL) ice.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
    else ice.push({ urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' });  // public best-effort relay
    return { ...RT.config(), ice, mail: mailOn() || !store.persistent };
  },

  // ---------- in-game chat (players write, spectators read) ----------
  async game_chat(req, body) {
    const code = String(body.code || '').toUpperCase();
    const [, raw] = await Promise.all([authFast(req), store.get('gchat:' + code)]);
    return { msgs: chatList(raw).slice(-100) };
  },
  async game_chat_send(req, body) {
    const code = String(body.code || '').toUpperCase();
    const [u, room] = await Promise.all([auth(req), roomFor(code)]);
    const seat = seatOf(room, u.name);                        // 'w' / 'b' / 's' (spectator: shown as such)
    if (u.muted) fail(403, 'You are muted.');
    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) fail(400, 'Type a message first.');
    chatThrottle('g:' + u.name.toLowerCase());
    const now = Date.now();
    const msg = { id: crypto.randomUUID().slice(0, 8), n: u.name, s: seat, t: text, ts: now };
    await editChat('gchat:' + room.code, (list, k) => { msg.k = k; return [...list, msg].slice(-100); }, ROOM_TTL);
    // the push is best-effort; the game heartbeat also reports the newest message number so nobody misses one
    await Promise.all([store.set('gchatn:' + room.code, { k: msg.k }, ROOM_TTL), RT.publish('room:' + room.code, 'c', msg)]);
    return { ok: true, msg };
  },

  // ---------- voice call signalling: relays the WebRTC handshake between the two players ----------
  async rtc_signal(req, body) {
    const code = String(body.code || '').toUpperCase();
    const [u, room] = await Promise.all([authFast(req), roomFor(code)]);
    if (!['who', 'here', 'join', 'leave', 'offer', 'answer', 'ice'].includes(body.t)) fail(400, 'Bad signal.');
    const d = body.d == null ? null : body.d;
    if (d && JSON.stringify(d).length > 20000) fail(413, 'Signal too large.');
    const to = body.to ? String(body.to).slice(0, 16) : null;
    await RT.publish('room:' + room.code, 'r', { f: u.name, s: seatOf(room, u.name), to, t: body.t, d });
    return { ok: true };
  },

  // Production self-test. Touches only a temporary "diag:" key, which it deletes.
  async health() {
    const ms = (t) => Math.round((performance.now() - t) * 10) / 10;
    const ctx = globalThis[Symbol.for('@vercel/request-context')], c = ctx && ctx.get && ctx.get();
    const out = { storage: store.persistent ? 'supabase' : 'memory', push: RT.mode, region: process.env.VERCEL_REGION || null, waitUntil: !!(c && c.waitUntil), casBroken: !!store.casBroken };
    const k = 'diag:' + crypto.randomUUID().slice(0, 8);
    try {
      let t = performance.now(); out.insert = await store.create(k, { v: 1 }, 120); out.insertMs = ms(t);
      t = performance.now(); out.casWithRightVersion = await store.cas(k, { v: 2 }, 1, 120); out.casMs = ms(t);
      out.casWithWrongVersion = await store.cas(k, { v: 3 }, 1, 120);
      t = performance.now(); const back = await store.get(k); out.readMs = ms(t); out.readBack = back && back.v;
      out.casWorks = out.casWithRightVersion === true && out.casWithWrongVersion === false && out.readBack === 2;
      await store.del(k);
      const live = await store.get('live'); out.liveGamesListed = Array.isArray(live) ? live.length : 0;
      t = performance.now(); out.pushStatus = await RT.publish('diag', 'm', {}); out.pushMs = ms(t);
    } catch (e) { out.error = e.message; }
    return out;
  },
  perf() { if (!process.env.PERF) fail(404, 'Unknown route.'); return { log: perfLog.splice(0), rt: RT.stats() }; },

  async profile(req, body) {
    const name = String(body.name || '').trim();
    const [me, t] = await Promise.all([auth(req), getUser(name)]);
    if (!t) fail(404, 'No player with that name.');
    const games = (await store.get('games:' + t.name.toLowerCase())) || [];
    const ratings = {};
    for (const c of R.CATS) {
      const rec = R.ratingOf(t, c);
      ratings[c] = { ...R.show(rec), rd: Math.round(rec.rd), peak: rec.peak || Math.round(rec.r), w: rec.w || 0, l: rec.l || 0, d: rec.d || 0, hist: rec.hist || [] };
    }
    return { name: t.name, joined: t.created || null, w: t.w || 0, l: t.l || 0, d: t.d || 0, ratings, games: games.slice(0, 20),
      ...(me.name === t.name ? { recovery: !!t.recovery } : {}) };
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
    return { code: room.code, snap: snapshot(room, u.name, now, { w: now, b: 0, spec: {} }) };
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
    if (result && result.joined) await RT.publish('room:' + room.code, 's', { v: room.v });
    return { code: room.code, snap: snapshot(room, u.name, now, { w: now, b: now, spec: {} }) };
  },

  // Full game state (first load / resync).
  async room(req, body) { const r = await roomState(req, body.code, null); return r.full; },

  // Heartbeat: tiny reply when nothing changed since version v, the full state otherwise.
  async sync(req, body) { return roomState(req, body.code, body.v == null ? null : +body.v); },

  async move(req, body) {
    const u = await authFast(req);
    tmark(req, 'auth');
    let timedOut = false;
    const { room, result } = await mutateRoom(body.code, (room) => {
      const now = Date.now();
      const seat = seatOf(room, u.name);
      if (seat === 's') fail(403, 'Spectators cannot play.');
      if (!room.players.w || !room.players.b) fail(400, 'Waiting for an opponent.');
      if (tick(room, now)) { markEnded(room); timedOut = true; return { timedOut: true }; }
      if (outcome(room).over) fail(400, 'Game is over.');
      if (room.paused) fail(400, 'The game is paused.');
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
      room.moves.push(Chess.notate(room.state, m));
      room.hist.push(m.promo ? { from: m.from, to: m.to, promo: m.promo } : { from: m.from, to: m.to });
      room.state = Chess.apply(room.state, m);
      room.last = { from: m.from, to: m.to };
      const pk = Chess.key(room.state);
      room.positions[pk] = (room.positions[pk] || 0) + 1;
      if (room.positions[pk] >= 3) room.rep = true;
      if (room.drawOffer && room.drawOffer !== seat) room.drawOffer = null;   // moving on = declining
      markEnded(room);
      return { m };
    }, { live: (r) => r.moves.length % 8 === 1 || outcome(r).over, req });
    const topic = 'room:' + room.code;
    if (timedOut) { RT.publish(topic, 's', { v: room.v }); await afterEnd(room); fail(400, 'Time ran out.'); }
    // the whole event: "e2e4" (+promotion letter), the new version, and both clocks
    const m = result.m, sq = (i) => 'abcdefgh'[i & 7] + (8 - (i >> 3));
    const ev = { m: sq(m.from) + sq(m.to) + (m.promo ? m.promo.toLowerCase() : ''), v: room.v };
    if (room.clock) {
      const over = outcome(room).over, run = room.moves.length >= 2 && !over ? room.state.turn : null, now = Date.now();
      ev.k = ['w', 'b'].map((c) => Math.max(0, Math.round(room.clock[c] - (run === c ? now - room.clock.ts : 0))));
    }
    if (room.endedAt) ev.e = 1;
    const pub = RT.publish(topic, 'm', ev);
    tmark(req, 'push');
    if (process.env.PERF) perfLog.push({ v: room.v, code: room.code, recvAt: req[TM].wall, marks: req[TM].marks.slice(), pubAt: performance.timeOrigin + performance.now() });
    await pub;
    await afterEnd(room);                                                      // rating update runs after the push
    return { ok: true, v: room.v };
  },

  async resign(req, body) {
    const u = await authFast(req);
    const { room } = await mutateRoom(body.code, async (room) => {
      const seat = seatOf(room, u.name);
      if (seat === 's') fail(403, 'Spectators cannot resign.');
      if (outcome(room).over) fail(400, 'Game is over.');
      room.resigned = seat;
      markEnded(room);
    }, { req });
    await RT.publish('room:' + room.code, 's', { v: room.v });
    await afterEnd(room);
    return { ok: true, v: room.v };
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
      if (room.drawOffer && room.drawOffer !== seat) { room.drawn = true; markEnded(room); }   // both want a draw
      else {
        if (room.offerLog[seat] === room.moves.length) fail(400, 'You already offered a draw this move.');
        room.drawOffer = seat;
        room.offerLog[seat] = room.moves.length;
      }
    }, { live: (r) => outcome(r).over, req });
    await RT.publish('room:' + room.code, 's', { v: room.v });
    await afterEnd(room);
    return { ok: true, v: room.v };
  },

  async draw_accept(req, body) {
    const u = await auth(req);
    const { room } = await mutateRoom(body.code, async (room) => {
      const seat = seatOf(room, u.name);
      if (seat === 's') fail(403, 'Spectators cannot accept draws.');
      if (outcome(room).over) fail(400, 'Game is over.');
      if (!room.drawOffer || room.drawOffer === seat) fail(400, 'There is no draw offer to accept.');
      room.drawn = true;
      markEnded(room);
    }, { req });
    await RT.publish('room:' + room.code, 's', { v: room.v });
    await afterEnd(room);
    return { ok: true, v: room.v };
  },

  async draw_decline(req, body) {
    const u = await auth(req);
    const { room, result } = await mutateRoom(body.code, (room) => {
      const seat = seatOf(room, u.name);
      if (seat === 's' || !room.drawOffer || room.drawOffer === seat) return { noWrite: true };
      room.drawOffer = null;
      return { changed: true };
    }, { live: false });
    if (result && result.changed) await RT.publish('room:' + room.code, 's', { v: room.v });
    return { ok: true };
  },

  // ---------- mutual pause: both players must agree to pause, and both press Resume to continue ----------
  async pause_request(req, body) {
    const u = await authFast(req);
    const { room } = await mutateRoom(body.code, (room) => {
      const seat = seatOf(room, u.name);
      if (seat === 's') fail(403, 'Only the players can pause.');
      if (outcome(room).over) fail(400, 'Game is over.');
      if (!room.players.w || !room.players.b) fail(400, 'Waiting for an opponent.');
      if (room.paused) fail(400, 'The game is already paused.');
      room.pauseCount = room.pauseCount || { w: 0, b: 0 };
      if (room.pauseReq === other(seat)) { pauseNow(room); return; }      // both asked: pause straight away
      if (room.pauseReq === seat) return { noWrite: true };
      if (room.pauseCount[seat] >= 3) fail(400, 'You can ask to pause 3 times per game.');
      room.pauseCount[seat]++;
      room.pauseReq = seat;
    }, { live: false, req });
    await RT.publish('room:' + room.code, 's', { v: room.v });
    return { ok: true, v: room.v };
  },
  async pause_respond(req, body) {
    const u = await authFast(req);
    const { room } = await mutateRoom(body.code, (room) => {
      const seat = seatOf(room, u.name);
      if (seat === 's') fail(403, 'Only the players can pause.');
      if (!room.pauseReq || room.pauseReq === seat || room.paused || outcome(room).over) fail(400, 'There is no pause request.');
      if (body.accept) pauseNow(room); else room.pauseReq = null;
    }, { live: false, req });
    await RT.publish('room:' + room.code, 's', { v: room.v });
    return { ok: true, v: room.v };
  },
  async unpause(req, body) {
    const u = await authFast(req);
    const { room } = await mutateRoom(body.code, (room) => {
      const seat = seatOf(room, u.name);
      if (seat === 's') fail(403, 'Only the players can resume.');
      if (!room.paused) return { noWrite: true };
      room.resumeReady = [...new Set([...(room.resumeReady || []), seat])];
      if (room.resumeReady.length === 2) {                                   // both ready: clocks start again now
        room.paused = false; room.resumeReady = [];
        if (room.clock) room.clock.ts = Date.now();
      }
    }, { live: false, req });
    await RT.publish('room:' + room.code, 's', { v: room.v });
    return { ok: true, v: room.v };
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
    }, { req });
    await RT.publish('room:' + room.code, 's', { v: room.v });
    return { ok: true };
  },

  async chat_send(req, body) {
    const u = await auth(req), now = Date.now();
    if (u.muted) fail(403, 'You are muted.');
    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) fail(400, 'Type a message first.');
    chatThrottle('l:' + u.name.toLowerCase());
    const msg = { id: crypto.randomUUID().slice(0, 8), name: u.name, text, ts: now, admin: !!u.admin };
    await editChat('chat:lobby', (list) => [...list, msg].slice(-60));
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
    return { users, live: games, announce: ann ? ann.text : '', stats: { users: users.length, live: games.length, chat: chatList(chat).length } };
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

  // A one-time password reset link for a player who has lost access (emails are not verified, so the admin
  // should check who they are talking to before passing it on).
  async admin_reset_link(req, body) {
    await needAdmin(req);
    const t = await getUser(String(body.name || ''));
    if (!t) fail(404, 'No such player.');
    return { path: '/?reset=' + (await newResetToken(t, ADMIN_RESET_TTL)) };
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
        await RT.publish('room:' + g.code, 's', {});
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
    await RT.publish('room:' + room.code, 's', { v: room.v });
    return { ok: true };
  },

  async admin_clear_chat(req) { await needAdmin(req); await editChat('chat:lobby', () => []); await RT.publish('lobby', 'chatdel', { all: true }); return { ok: true }; },

  async admin_delete_msg(req, body) {
    await needAdmin(req);
    await editChat('chat:lobby', (list) => list.filter((m) => m.id !== body.id));
    await RT.publish('lobby', 'chatdel', { id: String(body.id || '') });
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
    const ch = { id: crypto.randomUUID().slice(0, 8), from: u.name, fromElo: mine.r, fromProv: mine.prov, fromTopic: RT.userTopic(u), cat, to: target.name, tc: ctc, ts: now };
    inbox.push(ch);
    await Promise.all([store.set(ik, inbox, 3600), store.set(ok, { ...ch, status: 'pending' }, 3600)]);
    await Promise.all([RT.publish(RT.userTopic(target), 'ping', { why: 'challenge', ch }), live ? notifyName(prev.to, 'ping') : null]);
    return { ok: true, id: ch.id };
  },

  async accept(req, body) {
    const now = Date.now(), ik = 'inbox:' + hname(req);
    const [u, inboxRaw] = await Promise.all([auth(req), store.get(ik)]);
    const inbox = inboxRaw || [];
    const ch = inbox.find((c) => c.id === body.id && now - c.ts < CHALLENGE_TTL);
    if (!ch) fail(404, 'That challenge expired.');
    const cat = R.category(ch.tc), meFirst = Math.random() < 0.5;
    const me = seatInfo(u, cat), them = { name: ch.from, elo: ch.fromElo, prov: !!ch.fromProv };   // the challenge already carries their rating
    const room = await makeRoom({ w: meFirst ? me : them, b: meFirst ? them : me }, ch.tc, now);
    const ok = 'outbox:' + ch.from.toLowerCase();
    const theirTopic = ch.fromTopic || (await getUser(ch.from).then((x) => x && RT.userTopic(x)));
    await Promise.all([
      // tell the challenger first, with everything needed to draw the game without another request
      theirTopic ? RT.publish(theirTopic, 'ping', { why: 'accepted', code: room.code, g: { players: room.players, tc: room.tc, cat: room.cat, v: room.v } }) : null,
      store.set(ik, inbox.filter((c) => c.id !== ch.id), 3600),
      store.get(ok).then((out) => (out && out.id === ch.id ? store.set(ok, { ...out, status: 'accepted', code: room.code }, 600) : null)),
    ]);
    return { code: room.code, snap: snapshot(room, u.name, now, { w: now, b: now, spec: {} }) };
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
  req[TM] = { marks: [], last: performance.now(), start: performance.now(), wall: performance.timeOrigin + performance.now() };
  const send = (code, obj) => {
    let body = JSON.stringify(obj);
    const t = req[TM];
    const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'Server-Timing': [...t.marks.map(([n, d]) => `${n};dur=${d.toFixed(1)}`), `total;dur=${(performance.now() - t.start).toFixed(1)}`].join(', ') };
    if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { body = zlib.gzipSync(body); h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; }
    res.writeHead(code, h);
    res.end(body);
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
