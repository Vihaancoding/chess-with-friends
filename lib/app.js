// API handler shared by local server.js and the Vercel function (api/index.js).
// Every call is POST /api?r=<route> with JSON body and x-name / x-token headers.
const crypto = require('crypto');
const zlib = require('zlib');
const Chess = require('../public/chess.js');
const store = require('./store');
const R = require('./rating');
const RT = require('./realtime');
const Opening = require('../public/opening.js');
const Match = require('../public/match.js');
const Tour = require('../public/tournament.js');
const Riv = require('./rivalry');
const Dmg = require('./damage'), DmgEng = require('./damageeng'), DmgText = require('./damagetext'), DmgCard = require('./damagecard');
const Fair = require('./fairplay');
const Trib = require('./tribunal');
const Sf = require('./sfserver');
const FairAn = require('./fairan'), FairModel = require('./fairmodel'), M_LEVELS = FairModel.LEVELS;
const openingsTsv = () => require('../public/openings.js').OPENINGS_TSV;   // ~400 KB: loaded the first time a game is archived

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
  let cap;
  p = Promise.race([Promise.resolve(p), new Promise((_, rej) => { cap = setTimeout(() => rej(new Error('took over 25s, dropped')), 25000); })])
    .catch((e) => console.error('background task failed:', e && e.message)).finally(() => clearTimeout(cap));
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
  return { name: u.name, elo: ratings.blitz.r, ratings, w: u.w || 0, l: u.l || 0, d: u.d || 0, topic: RT.userTopic(u), srv: srvOf(u), ns: store.prefix(srvOf(u)) };
};
const lbEntry = (u) => ({ ratings: R.summary(u), w: u.w || 0, l: u.l || 0, d: u.d || 0 });
const seatInfo = (u, cat) => { const x = R.show(R.ratingOf(u, cat)); return { name: u.name, elo: x.r, prov: x.prov }; };

async function bumpLeaderboard(...users) {
  const lb = (await store.get('lb')) || {};
  for (const u of users) lb[u.name] = lbEntry(u);
  await store.set('lb', lb);
}

// ---------- servers ----------
// Every player belongs to one server (u.srv; accounts from before servers existed are on Server 1). New players
// join with the server's code; Server 1 never has one, so nobody new gets in there. Admins create servers,
// change codes, move players and switch themselves between servers.
const srvOf = (u) => (u && u.srv) || '1';
const SERVER1 = { id: '1', name: 'Server 1', code: null };
async function getServers() {
  const s = await store.get('servers');
  return s && Array.isArray(s.list) ? s : { list: [SERVER1], next: 2 };
}
const newServerCode = () => Array.from(crypto.randomBytes(6), (x) => ALPHABET[x % ALPHABET.length]).join('');
const serverName = (servers, id) => (servers.list.find((x) => x.id === id) || { name: 'Server ' + id }).name;
// Server 1 takes players without a code only on a brand-new site (so the first person can sign up and claim
// admin) and in local development with in-memory storage.
async function server1Open() {
  if (!store.persistent && !process.env.CLOSED_SERVER1) return true;
  const lb = await store.inServer('1', () => store.get('lb'));
  return !lb || !Object.keys(lb).length;
}
// A player looked up by name from another player's request: only visible when they share a server.
async function peerUser(name) {
  const t = await getUser(name);
  return t && srvOf(t) === store.server() ? t : null;
}
// ---------- @mentions ----------
// "@name" in the lobby, game or tournament chat notifies that player (same server only): pushed to them at once,
// and kept in "mentions:<name>" for a week so a player whose live updates are down, or who was away, still gets it.
const MENTION_RE = /(^|[^A-Za-z0-9_-])@([A-Za-z0-9_-]{2,16})(?![A-Za-z0-9_-])/g;
const MENTION_TTL = 7 * 86400, MENTION_MAX = 5;
const mentionsKey = (n) => 'mentions:' + n.toLowerCase();
function mentionNames(text) {
  const out = new Map();
  for (const m of String(text).matchAll(MENTION_RE)) if (!out.has(m[2].toLowerCase())) out.set(m[2].toLowerCase(), m[2]);
  return [...out.values()].slice(0, MENTION_MAX);
}
// where: { kind: 'lobby' | 'game' | 'tour', code (game), tid + title (tournament) }
async function notifyMentions(u, text, where) {
  const names = mentionNames(text).filter((n) => n.toLowerCase() !== u.name.toLowerCase());
  await Promise.all(names.map(async (n) => {
    const t = await peerUser(n);
    if (!t) return;
    const m = { id: crypto.randomUUID().slice(0, 10), from: u.name, text, ts: Date.now(), ...where };
    await editList(mentionsKey(t.name), (list) => [...list.filter((x) => Date.now() - x.ts < MENTION_TTL * 1000), m].slice(-20), MENTION_TTL)
      .catch((e) => console.error('mention save failed:', e.message));
    await RT.publish(RT.userTopic(t), 'ping', { why: 'mention', m });
  }));
}
const mentionLater = async (u, text, where) => { if (!mentionNames(text).length) return; const bg = later(notifyMentions(u, text, where)); if (bg) await bg; };

async function moveUser(t, to) {
  const from = srvOf(t);
  if (from === to) return;
  await store.inServer(from, async () => {
    const lb = (await store.get('lb')) || {};
    delete lb[t.name];
    await store.set('lb', lb);
  });
  t.srv = to;
  await saveUser(t);
  authCache.delete(t.name.toLowerCase());
  await store.inServer(to, () => bumpLeaderboard(t));
  await store.inServer(from, () => RT.publish(RT.userTopic(t), 'ping', { why: 'moved' }));   // their open tabs reload into the new server
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const ekey = (e) => 'email:' + e;
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 32, (e, k) => (e ? rej(e) : res(k))));

async function signup(body) {
  const email = String(body.email || '').trim().toLowerCase(), pw = String(body.password || ''), name = String(body.username || '').trim();
  if (!EMAIL_RE.test(email) || email.length > 254) fail(400, 'Enter a valid email address.');
  if (pw.length < 8 || pw.length > 128) fail(400, 'Password must be 8-128 characters.');
  if (!NAME_RE.test(name)) fail(400, 'Username must be 2-16 letters, numbers, _ or -.');
  const scode = normCode(body.server);
  const srv = scode ? (await getServers()).list.find((x) => x.code && x.code === scode) : (await server1Open()) && SERVER1;
  if (!srv) fail(400, scode ? "That server code doesn't work. Check it with whoever gave it to you." : 'Enter the server code you were given.');
  if (await store.get(ekey(email))) fail(409, 'That email already has an account. Log in instead.');
  if (await getUser(name)) fail(409, 'That username is taken. Pick another one.');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(pw, salt)).toString('hex');
  const u = { name, email, salt, hash, token: crypto.randomUUID(), elo: START_ELO, w: 0, l: 0, d: 0, created: Date.now(), srv: srv.id };
  const recovery = newRecovery(u);
  await saveUser(u);
  await store.set(ekey(email), { name });
  await store.inServer(srv.id, () => bumpLeaderboard(u));
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
//  2. a one-time reset link, emailed when an email service is configured (SMTP_USER + SMTP_PASS, e.g. a Gmail
//     address and app password, or RESEND_API_KEY + MAIL_FROM),
//     or created by an admin from the admin panel and passed on by hand
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const RESET_TTL = 30 * 60, ADMIN_RESET_TTL = 24 * 3600;
const smtpOn = () => !!(process.env.SMTP_USER && process.env.SMTP_PASS);
const mailOn = () => smtpOn() || !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
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

let smtp = null;
async function sendMail(to, subject, text) {
  if (smtpOn()) {
    // SMTP (Gmail by default: SMTP_USER = the address, SMTP_PASS = an app password)
    if (!smtp) {
      const port = +process.env.SMTP_PORT || 465;
      smtp = require('nodemailer').createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS.replace(/\s+/g, '') },   // Gmail shows app passwords with spaces
      });
    }
    await smtp.sendMail({ from: process.env.MAIL_FROM || `Chess <${process.env.SMTP_USER}>`, to, subject, text });
    return;
  }
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
  authCache.set(n, { token: u.token, exp: Date.now() + 60e3, u: { name: u.name, token: u.token, srv: u.srv } });
  if (authCache.size > 2000) authCache.delete(authCache.keys().next().value);
  return u;
}

const BAN_OK = new Set(['me', 'ping', 'fair_cases', 'fair_comment', 'fair_appeal', 'resume']);   // a banned player can still see the case and appeal
async function auth(req) {
  const name = req.headers['x-name'], token = req.headers['x-token'];
  const u = name && token ? await getUser(String(name)) : null;
  if (!u || u.token !== token) fail(401, 'Please sign in again.');
  if (u.banUntil && u.banUntil > Date.now() && !u.admin && !BAN_OK.has(new URL(req.url || '/', 'http://x').searchParams.get('r'))) fail(403, u.banUntil >= Trib.PERM_UNTIL ? 'This account is banned.' : `This account is banned until ${new Date(u.banUntil).toUTCString()}.`);
  const c = authCache.get(u.name.toLowerCase());
  if (c && c.u.srv !== u.srv) authCache.delete(u.name.toLowerCase());   // moved to another server on another instance
  return u;
}

// ---------- fair play ----------
const FAIR_EXT_MAX = 30, FAIR_GAMES = 20, FAIR_BUDGET_MS = 6000;   // Vercel stops a request at 10 s
const fairExtKey = (n) => 'fairext:' + n.toLowerCase();
const fairScanKey = (n) => 'fairscan:' + n.toLowerCase();
// A player's recent finished games long enough to judge: past the opening with some middlegame to look at.
async function fairGames(lname) {
  return chatList(await store.get('games:' + lname)).filter((x) => x.id && x.moves >= Fair.SKIP_PLIES + 16).slice(0, FAIR_GAMES);
}
// the detector's standing for a player: the worst of their last ten analysed games (5 when a tribunal confirmed a violation)
function detSummary(hist, conf) {
  const last = hist.slice(-10), worst = last.reduce((m, e) => (e.p < m.p ? e : m), { p: 1, level: 1 });
  return { level: conf.length ? 5 : worst.level || 1, label: conf.length ? M_LEVELS[5] : M_LEVELS[worst.level || 1], p: worst.p, games: hist.length, confirmed: conf.length, shift: FairModel.historyShift(hist.map((e) => ({ Z: e.Z }))) };
}
// Per player for the admin list: extension reports, the last verdict, and how many recent games await a check.
async function fairSummaries(names) {
  const keys = names.flatMap((n) => [fairExtKey(n), fairScanKey(n), 'games:' + n.toLowerCase(), FairAn.histKey(n), 'fconf:' + n.toLowerCase()]);
  const vals = keys.length ? await store.getMany(keys) : [];
  const out = {};
  names.forEach((n, i) => {
    const ext = chatList(vals[i * 5]), scan = vals[i * 5 + 1], seen = (scan && scan.games) || {}, hist = Array.isArray(vals[i * 5 + 3]) ? vals[i * 5 + 3] : [], conf = chatList(vals[i * 5 + 4]);
    const rows = chatList(vals[i * 5 + 2]).filter((x) => x.id && x.moves >= Fair.SKIP_PLIES + 16).slice(0, FAIR_GAMES);
    out[n.toLowerCase()] = { ext: ext.length, lastExt: ext[0] ? ext[0].ts : 0, verdict: scan ? scan.verdict : null, pending: rows.filter((x) => !(x.id in seen)).length, det: detSummary(hist, conf) };
  });
  return out;
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
// Change a stored list (chat log, game index) without losing entries when two writers land at the same moment
// (compare-and-swap on v). fn(list, v) returns the new list, or the same list to skip the write.
async function editList(key, fn, ttl, busy = 'Busy, try again.') {
  for (let i = 0; i < 6; i++) {
    const raw = await store.get(key);
    const prevV = raw && !Array.isArray(raw) ? raw.v : null;
    const cur = chatList(raw), v = (prevV || 0) + 1, list = fn(cur, v);   // v doubles as the chat message number
    if (list === cur) return cur;
    const next = { v, list };
    // an expired row still blocks create(); after one clash, overwrite it
    const ok = raw == null ? (await store.create(key, next, ttl)) || (i > 0 && (await store.set(key, next, ttl), true))
      : await store.cas(key, next, prevV, ttl);
    if (ok) return next.list;
  }
  fail(503, busy);
}
const editChat = (key, fn, ttl) => editList(key, fn, ttl, 'Chat is busy, try again.');
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
      ...(room.match ? { mx: matchTag(room) } : {}),
    });
  await store.set('live', list, 3600);
}

// a match in the live list: format, game number and each colour's score, e.g. { t: 'Bo5', g: 3, w: 1.5, b: 0.5 }
function matchTag(room) {
  const m = room.match, pts = Match.score(m).pts;
  return { t: Match.short(m), g: m.games.length + 1, w: pts[room.players.w.name] || 0, b: pts[room.players.b.name] || 0, a: !!room.arma };
}

// The "live" list is only rewritten every few moves, so read each game's current position for whose turn it is.
async function withTurns(list) {
  if (!list.length) return list;
  const states = await store.getMany(list.map((g) => rkey(g.code)), 'state').catch(() => []);
  return list.map((g, i) => (states[i] && states[i].turn ? { ...g, turn: states[i].turn, full: states[i].full } : g));
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
  room.archived = null;
  room.rematch = [];
  room.rematchSeries = null;
  room.arma = false;
  room.hist = [];
  room.mt = []; room.ck = []; room.lastAt = null;
  room.positions = { [Chess.key(room.state)]: 1 };
  room.rep = false;
  room.drawn = false;
  room.drawOffer = null;
  room.offerLog = { w: -1, b: -1 };
  room.paused = false; room.pauseReq = null; room.resumeReady = []; room.pauseCount = { w: 0, b: 0 };
  room.clock = room.tc ? { w: room.tc.base * 1000, b: room.tc.base * 1000, ts: now } : null;
}

const newRoomCode = () => Array.from({ length: 5 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
// fixed: create the room under this code or return null if it exists (tournament rooms, reserved in the tournament first)
async function makeRoom(players, tc, now, match = null, fixed = null, extra = null) {
  const ctc = cleanTc(tc), fmt = Match.clean(match);
  for (let i = 0; i < 8; i++) {
    const code = fixed || newRoomCode();
    const room = { code, tc: ctc, cat: R.category(ctc), players, seen: {}, v: 1, ...(fmt ? { match: Match.start(fmt) } : {}), ...(extra || {}) };
    freshGame(room, now);
    if (await store.create(rkey(code), room, ROOM_TTL)) {          // one insert, no read-before-write
      cachePut(room);
      const bg = later(touchLive(room, now)); if (bg) await bg;
      return room;
    }
    if (fixed) return null;
  }
  fail(503, 'Could not create a game. Try again.');
}

const seatOf = (room, name) =>
  room.players.w && room.players.w.name === name ? 'w' : room.players.b && room.players.b.name === name ? 'b' : 's';

function outcome(room) {
  if (room.aborted) return { over: true, result: 'draw', reason: 'ended by an admin', check: false };
  if (room.resigned) return { over: true, result: other(room.resigned), reason: 'resignation', check: false };
  if (room.forfeit) return { over: true, result: other(room.forfeit), reason: 'fair play forfeit', check: false };
  if (room.timeout) return { over: true, result: other(room.timeout), reason: 'timeout', check: false };
  if (room.drawn) return { over: true, result: 'draw', reason: 'agreement', check: false };
  const st = Chess.status(room.state);
  if (!st.over && room.rep) return { over: true, result: 'draw', reason: 'threefold repetition', check: false };
  return st;
}

// Flag the side to move if their clock has run out. Returns true if state changed.
function tick(room, now) {
  if (!room.tc || room.paused || room.resigned || room.forfeit || room.timeout || room.drawn || room.rep || room.aborted) return false;
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
  if (room.match && both && !room.aborted) {                     // head-to-head match: score this game, maybe decide the match
    const o = outcome(room);
    Match.record(room.match, { id: gameId(room), w: room.players.w.name, b: room.players.b.name, result: o.result, reason: o.reason, moves: room.moves.length, arma: room.arma });
  }
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
    r.ratings = { w: ratingLine(ow, nw), b: ratingLine(ob, nb) };
    r.delta = { w: r.ratings.w.delta, b: r.ratings.b.delta };
    r._settle = { cat, sw, nw, nb };
  }, { live: false });
  if (!(result && result.noWrite)) await RT.publish('room:' + room.code, 's', { v: room.v });
  if (needsArchive(room)) await archiveGame(room);                // after the ratings, so the archive has them
}
const ratingLine = (o, n) => ({ before: Math.round(o.r), after: Math.round(n.r), delta: Math.round(n.r) - Math.round(o.r), prov: R.provisional(n) });
// call after a mutation that may have ended the game
async function afterEnd(room) {
  const job = room.settlePending && !room.settled ? settleGame(room.code) : needsArchive(room) ? archiveGame(room) : null;
  if (job) { const bg = later(job); if (bg) await bg; }
  if (needsTourReport(room)) { const bg = later(reportTour(room)); if (bg) await bg; }
}

async function applySettle(room, p) {
  const [uw, ub] = await Promise.all([getUser(room.players.w.name), getUser(room.players.b.name)]);
  if (!uw || !ub) return;
  await saveRatings(uw, ub, p);
}
async function saveRatings(uw, ub, p) {
  for (const [u, rec, s] of [[uw, p.nw, p.sw], [ub, p.nb, 1 - p.sw]]) {
    u.ratings = { ...(u.ratings || {}), [p.cat]: rec };
    if (s === 1) u.w = (u.w || 0) + 1; else if (s === 0) u.l = (u.l || 0) + 1; else u.d = (u.d || 0) + 1;
    u.elo = R.show(R.ratingOf(u, 'blitz')).r;
  }
  await Promise.all([saveUser(uw), saveUser(ub)]);
  await bumpLeaderboard(uw, ub);
}

// ---------- game archive ----------
// Every finished game (both players seated, at least one move) is saved for good as "game:<id>", built from the
// room's own authoritative record: the move list the server validated, the result, and the rating change.
// Each player also gets a summary row in "games:<name>" (newest first) so the archive lists without opening games.
// Saving is idempotent (fixed id, insert-only record, rows de-duplicated by id) and retried from the game's
// heartbeat until the room is marked archived, so a lost background task cannot lose a game.
const ARCHIVE_MAX = 1000;                                          // index rows kept per player; the games themselves are never dropped
const GAME_ID_RE = /^[A-Z0-9]{5}-[a-z0-9]{1,12}$/;
const gameId = (r) => (r.startedAt ? `${r.code}-${r.startedAt.toString(36)}` : null);
const needsArchive = (r) => !!(r.settled && !r.archived && !r.settlePending && r.endedAt && r.players.w && r.players.b && r.moves.length && gameId(r) && outcome(r).over);
const STYLE_MAX = 40;                                             // games a playstyle profile is built from
const archiveTried = new Map();                                    // per instance: game id -> last attempt (keeps heartbeats from piling up retries)

function archiveRow(g, c) {
  const opp = other(c), mine = g.ratings ? g.ratings[c] : null;
  return {
    id: g.id, code: g.code, at: g.endedAt, cat: g.cat, tc: g.tc, color: c, opp: g.players[opp].name,
    oppRating: g.ratings ? g.ratings[opp].before : g.players[opp].elo, result: g.result === 'draw' ? 'draw' : g.result === c ? 'win' : 'loss',
    reason: g.reason, rated: !!mine, ...(mine || {}), moves: g.hist.length, dur: g.dur, eco: g.eco, op: g.opening,
  };
}

// Saves a finished game and its two index rows. Safe to repeat: returns the copy saved first.
async function storeArchive(g0) {
  const g = (await store.create('game:' + g0.id, g0)) ? g0 : (await store.get('game:' + g0.id)) || g0;
  // a game that ended just before the archive existed already has a summary row (no id): replace it, don't duplicate it
  const legacy = (x) => !x.id && x.code === g.code && (x.at === g0.endedAt || x.at === g.endedAt);
  await Promise.all(['w', 'b'].map((c) => editList('games:' + g.players[c].name.toLowerCase(),
    (list) => (list.some((x) => x.id === g.id) ? list : [archiveRow(g, c), ...list.filter((x) => !legacy(x))].slice(0, ARCHIVE_MAX)))));
  await pairsAdd({ id: g.id, t: g.endedAt, w: g.players.w.name, b: g.players.b.name, result: g.result, plies: (g.hist || []).length, reason: g.reason })
    .catch((e) => console.error('rivalry index update failed:', e.message));   // the archive is what matters; the index can be rebuilt from it
  return g;
}

// ---------- the community rivalry index: one small record per pair of players on this server ----------
// Kept up to date as games are saved; built once from the existing archive (and again if it is ever lost).
const PAIRS = 'rpairs', PAIRS_MAX = 3000;
const pairsBuilding = new Map();                                            // per server: a rebuild in progress
function prunePairs(map) {
  const keys = Object.keys(map);
  if (keys.length <= PAIRS_MAX) return map;
  const keep = keys.sort((x, y) => map[y].last - map[x].last).slice(0, PAIRS_MAX), out = {};
  for (const k of keep) out[k] = map[k];
  return out;
}
async function pairsAdd(g) {
  for (let i = 0; i < 6; i++) {
    const rec = await store.get(PAIRS);
    if (!rec || !rec.built) return;                                        // not built yet: the rebuild will read this game from the archive
    const map = { ...rec.map };
    if (!Riv.pairAdd(map, g)) return;
    if (await store.cas(PAIRS, { ...rec, v: rec.v + 1, built: true, ver: rec.ver, map: prunePairs(map) }, rec.v)) return;
  }
}
async function pairsBuild() {
  const lb = (await store.get('lb')) || {}, names = Object.keys(lb).slice(0, 2000);
  for (let attempt = 0; attempt < 4; attempt++) {
    const rec = await store.get(PAIRS);
    const raws = [];
    for (let i = 0; i < names.length; i += 100) raws.push(...(await store.getMany(names.slice(i, i + 100).map((n) => 'games:' + n.toLowerCase()))));
    const map = {}, seen = new Set();
    raws.forEach((raw, i) => {
      for (const x of chatList(raw)) {
        const gid = x.id || (x.code && x.at ? `${x.code}:${x.at}` : null);  // older rows have no id: the same key the head-to-head page uses
        if (!gid || !x.opp || seen.has(gid)) continue;                     // each game once, from whichever player's archive has it
        seen.add(gid);
        const white = x.color === 'w', res = x.result === 'draw' ? 'draw' : (x.result === 'win') === white ? 'w' : 'b';
        Riv.pairAdd(map, { id: gid, t: x.at, w: white ? names[i] : x.opp, b: white ? x.opp : names[i], result: res, plies: x.moves == null ? 2 : x.moves, reason: x.reason });
      }
    });
    const next = { v: ((rec && rec.v) || 0) + 1, built: true, ver: 3, at: Date.now(), map: prunePairs(map) };
    if (rec ? await store.cas(PAIRS, next, rec.v) : await store.create(PAIRS, next)) return next;
  }
  return store.get(PAIRS);
}
async function pairsGet() {
  const rec = await store.get(PAIRS);
  const srv = store.server();
  // the index is rebuilt from the archive every half hour, so a game it missed can never leave the totals wrong for long
  if (rec && rec.built && (rec.ver !== 3 || Date.now() - (rec.at || 0) > 30 * 60e3) && !pairsBuilding.has(srv)) {
    pairsBuilding.set(srv, pairsBuild().finally(() => pairsBuilding.delete(srv)));
    const bg = later(pairsBuilding.get(srv)); if (bg) return bg;
  }
  if (rec && rec.built) return rec;
  if (!pairsBuilding.has(srv)) pairsBuilding.set(srv, pairsBuild().finally(() => pairsBuilding.delete(srv)));
  return pairsBuilding.get(srv);
}
const communityCache = new Map();                                           // per server: { v, at, data } for a minute

async function archiveGame(room) {
  const id = gameId(room), now = Date.now();
  if (!id || now - (archiveTried.get(id) || 0) < 20e3) return;
  archiveTried.set(id, now);
  if (archiveTried.size > 2000) archiveTried.delete(archiveTried.keys().next().value);
  const o = outcome(room);
  let op = null;
  try { op = Opening.ofGame(room.hist || [], openingsTsv()); } catch (e) { console.error('opening lookup failed:', e.message); }
  const g = {
    id, code: room.code, players: { w: room.players.w, b: room.players.b }, tc: room.tc, cat: room.cat || R.category(room.tc),
    result: o.result, reason: o.reason, rated: !!room.ratings, ratings: room.ratings || null,
    startedAt: room.startedAt, endedAt: room.endedAt, dur: room.endedAt - room.startedAt,
    hist: room.hist || [], moves: room.moves, eco: op ? op.eco : null, opening: op ? op.name : null, saved: now,
    ...(room.mt && room.mt.length === (room.hist || []).length ? { mt: room.mt, ...(room.tc && room.ck && room.ck.length === room.mt.length ? { ck: room.ck } : {}) } : {}),
  };
  await storeArchive(g);
  try {
    await mutateRoom(room.code, (r) => { if (gameId(r) !== id || r.archived) return { noWrite: true }; r.archived = id; }, { live: false });
  } catch (e) { if (!(e instanceof HttpError)) throw e; }          // room already gone or rematched: the game is saved either way
  // the Damage Report: a card for this game (once), then the engine and the commentary in the background
  await damageLater((async () => { const r = await damageEnqueue(g); if (r && (r.card || r.dup)) await damageRun(g.id); })());
  const bg = later(fairPost(g)); if (bg) await bg;                                // the fair-play analysis of the finished game, in the background
}

// ---------- pass & play results: a game two people played on one device, rated only once the other player agrees ----------
// The player whose device it was sends the moves; the server replays them (so the position and any checkmate,
// stalemate or repetition are real) and parks the result in the opponent's "results:" list. Nothing touches either
// rating until the opponent accepts it, the next time they open the lobby. Declining throws the result away.
// The sender keeps a matching row in "resultsout:" that shows them the answer.
const RESULT_TTL = 14 * 86400, RESULT_MAX = 20, RESULT_PER_SENDER = 3;
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const resultsKey = (n) => 'results:' + n.toLowerCase();
const resultsOutKey = (n) => 'resultsout:' + n.toLowerCase();

// Replays the moves and returns the finished game, or fails with the reason it can't be rated.
function replayLocal(uci, end) {
  if (!Array.isArray(uci) || uci.length < 2 || uci.length > 600) fail(400, 'Only games where both players moved can be rated.');
  let state = Chess.initial();
  const positions = { [Chess.key(state)]: 1 }, hist = [], moves = [];
  let rep = false;
  for (const u of uci) {
    const m = UCI_RE.test(u) && !rep && !Chess.status(state).over ? Chess.findUci(state, u) : null;
    if (!m) fail(400, 'That game has an illegal move in it.');
    moves.push(Chess.notate(state, m));
    hist.push(m.promo ? { from: m.from, to: m.to, promo: m.promo } : { from: m.from, to: m.to });
    state = Chess.apply(state, m);
    const k = Chess.key(state);
    if ((positions[k] = (positions[k] || 0) + 1) >= 3) rep = true;
  }
  const st = Chess.status(state);
  if (st.over) return { hist, moves, result: st.result, reason: st.reason };
  if (rep) return { hist, moves, result: 'draw', reason: 'threefold repetition' };
  // a resignation, a flag fall or an agreed draw can't be seen on the board: the sender says which, the opponent confirms it
  if (end && (end.reason === 'resignation' || end.reason === 'timeout') && (end.result === 'w' || end.result === 'b')) return { hist, moves, result: end.result, reason: end.reason };
  if (end && end.reason === 'agreement' && end.result === 'draw') return { hist, moves, result: 'draw', reason: 'agreement' };
  fail(400, 'That game is not finished.');
}

// a client-made game id (letters and digits)
const cleanGid = (x) => String(x || '').replace(/[^a-z0-9]/gi, '').slice(0, 16) || fail(400, 'Bad game.');
const okTime = (t) => Number.isSafeInteger(t) && t > 0;
async function sendResult(req, body) {
  const u = await auth(req), now = Date.now();
  const color = body.color === 'w' || body.color === 'b' ? body.color : fail(400, 'Pick which side you played.');
  const opp = await peerUser(String(body.opp || '').trim());
  if (!opp) fail(404, 'No player with that name.');
  if (opp.name === u.name) fail(400, "You can't send a result to yourself.");
  const gid = cleanGid(body.gid);
  const tc = cleanTc(body.tc), g = replayLocal(body.moves, body.end);
  if (g.reason === 'timeout' && !tc) fail(400, 'That game had no clock.');
  // a game is sent once for good, even after it was answered and left the opponent's list
  const mark = `resultgid:${u.name.toLowerCase()}:${gid}`, seen = await store.get(mark);
  if (seen) return { ok: true, id: seen.id };
  const startedAt = okTime(+body.startedAt) ? Math.min(now, +body.startedAt) : now;
  const endedAt = okTime(+body.endedAt) ? Math.max(startedAt, Math.min(now, +body.endedAt)) : now;
  const item = { id: crypto.randomUUID().slice(0, 8), gid, from: u.name, to: opp.name, color, tc, cat: R.category(tc), hist: g.hist, moves: g.moves,
    result: g.result, reason: g.reason, startedAt, endedAt, ts: now };
  // the sender's row goes first, so an answer can never arrive before it (a retry replaces it: same game id)
  const row = { id: item.id, gid, to: opp.name, color, result: item.result, reason: item.reason, cat: item.cat, tc, moves: g.hist.length, status: 'pending', ts: now };
  await editList(resultsOutKey(u.name), (list) => [row, ...list.filter((x) => x.gid !== gid)].slice(0, RESULT_MAX), RESULT_TTL);
  let dup = null;
  await editList(resultsKey(opp.name), (list) => {
    const live = list.filter((x) => now - x.ts < RESULT_TTL * 1000);
    dup = live.find((x) => x.from === u.name && x.gid === gid) || null;
    if (dup) return list;                                            // sent twice (retry): keep the first
    if (live.filter((x) => x.from === u.name).length >= RESULT_PER_SENDER) fail(429, `${opp.name} already has ${RESULT_PER_SENDER} of your results to answer. Wait until they do.`);
    return [...live, item].slice(-RESULT_MAX);
  }, RESULT_TTL);
  const id = dup ? dup.id : item.id;
  await store.set(mark, { id }, RESULT_TTL);
  if (!dup) await RT.publish(RT.userTopic(opp), 'ping', { why: 'result' });
  return { ok: true, id };
}

// Rates an accepted result and archives it. Safe to repeat after a failure: the archived game has a fixed id,
// and the ratings are applied at most once (the "resultrated:" row is the gate).
async function rateResult(item, sender, u) {
  const users = { [item.color]: sender, [other(item.color)]: u }, uw = users.w, ub = users.b;
  const cat = item.cat, sw = item.result === 'w' ? 1 : item.result === 'b' ? 0 : 0.5, now = Date.now();
  const ow = R.ratingOf(uw, cat), ob = R.ratingOf(ub, cat);
  const [nw, nb] = R.rateGame(ow, ob, sw, now);
  const seat = (x, o) => ({ name: x.name, elo: Math.round(o.r), prov: R.provisional(o) });
  const code = [...crypto.createHash('sha256').update('result:' + item.id).digest().subarray(0, 5)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  let op = null;
  try { op = Opening.ofGame(item.hist, openingsTsv()); } catch (e) { console.error('opening lookup failed:', e.message); }
  const g = await storeArchive({
    id: `${code}-${item.startedAt.toString(36)}`, code, players: { w: seat(uw, ow), b: seat(ub, ob) }, tc: item.tc, cat, local: true,
    result: item.result, reason: item.reason, rated: true, ratings: { w: ratingLine(ow, nw), b: ratingLine(ob, nb) },
    startedAt: item.startedAt, endedAt: item.endedAt, dur: item.endedAt - item.startedAt,
    hist: item.hist, moves: item.moves, eco: op ? op.eco : null, opening: op ? op.name : null, saved: now,
  });
  const gate = 'resultrated:' + item.id;
  if (await store.create(gate, { ts: now }, RESULT_TTL)) {
    try { await saveRatings(uw, ub, { cat, sw, nw, nb }); } catch (e) { await store.del(gate); throw e; }
  }
  return g.ratings;
}

// ---------- clone alerts: tell a player when someone finished a game against their clone ----------
// The moves are replayed (like a pass & play result), so the result in the alert is real. One alert per sender:
// repeat games from the same player update it ("played your clone 3 times") instead of piling up.
const CLONE_TTL = 30 * 86400, CLONE_MAX = 20;
const CLONE_PER_DAY = 30, CLONE_PING_MS = 120e3;              // games one sender can report per day; at most one push per sender per 2 minutes
const clonesKey = (n) => 'cloneplays:' + n.toLowerCase();
const CLONE_DIFFS = ['easy', 'true', 'sharp', 'best'];
async function clonePlayed(req, body) {
  const u = await auth(req), now = Date.now();
  const t = await peerUser(String(body.name || '').trim());
  if (!t) fail(404, 'No player with that name.');
  if (t.name === u.name) return { ok: true, skipped: true };              // your own clone: nobody to tell
  const color = body.color === 'w' || body.color === 'b' ? body.color : fail(400, 'Pick which side you played.');
  const gid = cleanGid(body.gid);
  const g = replayLocal(body.moves, body.end);
  const diff = CLONE_DIFFS.includes(body.diff) ? body.diff : 'true';
  let item = null, ping = false;
  await editList(clonesKey(t.name), (list) => {
    item = null; ping = false;                                             // set again on each retry
    const live = list.filter((x) => now - x.ts < CLONE_TTL * 1000), prev = live.find((x) => x.from === u.name);
    if (prev && prev.gids.includes(gid)) return list;                     // sent twice (retry), even after it was dismissed
    const today = prev ? (prev.day || []).filter((ts) => now - ts < 86400e3) : [];
    if (today.length >= CLONE_PER_DAY) fail(429, 'Too many clone games reported today.');
    // a dismissed alert comes back with a fresh count; the game ids are kept so a late retry can't revive it
    const fresh = !prev || prev.seen;
    item = { id: prev ? prev.id : crypto.randomUUID().slice(0, 8), from: u.name, color, diff, result: g.result, reason: g.reason, moves: g.hist.length,
      games: fresh ? 1 : prev.games + 1, gids: [...(prev ? prev.gids : []), gid].slice(-40), day: [...today, now], ts: now, seen: false };
    ping = fresh || now - (prev.pinged || 0) > CLONE_PING_MS;
    if (ping) item.pinged = now; else item.pinged = prev.pinged;
    return [item, ...live.filter((x) => x !== prev)].slice(0, CLONE_MAX);
  }, CLONE_TTL);
  if (item && ping) { const { gids, day, pinged, seen, ...ev } = item; await RT.publish(RT.userTopic(t), 'ping', { why: 'clone', c: ev }); }
  return { ok: true };
}

const TAKE_MS = 60e3;
async function answerResult(req, body) {
  const u = await auth(req), accept = !!body.accept, now = Date.now();
  let item = null;
  // claimed, not removed, while it is being answered: a double click gets "busy", and a failure puts it back
  await editList(resultsKey(u.name), (list) => {
    item = list.find((x) => x.id === body.id) || null;
    if (!item) return list;
    if (item.taking && now - item.taking < TAKE_MS) fail(409, 'That result is already being answered.');
    return list.map((x) => (x.id === item.id ? { ...x, taking: now } : x));
  }, RESULT_TTL);
  if (!item) fail(404, 'That result is no longer waiting for you.');
  let sender = null, ratings = null;
  try {
    sender = await getUser(item.from);
    if (accept && sender) ratings = await rateResult(item, sender, u);
  } catch (e) {
    await editList(resultsKey(u.name), (list) => list.map((x) => (x.id === item.id ? { ...x, taking: 0 } : x)), RESULT_TTL).catch(() => {});
    throw e;
  }
  await editList(resultsKey(u.name), (list) => list.filter((x) => x.id !== item.id), RESULT_TTL);
  if (sender) {
    const status = accept ? 'accepted' : 'declined', rating = ratings ? ratings[item.color] : null;
    const mine = (x) => x.id === item.id || x.gid === item.gid;
    await editList(resultsOutKey(sender.name), (list) => (list.some(mine) ? list.map((x) => (mine(x) ? { ...x, status, rating, ts: Date.now() } : x)) : list), RESULT_TTL);
    await RT.publish(RT.userTopic(sender), 'ping', { why: 'result' });
  }
  return { ok: true, accepted: !!ratings, rating: ratings ? ratings[other(item.color)] : null };
}

const SPEC_DELAY = Math.max(0, Math.floor(+process.env.SPEC_DELAY_PLIES || 0));     // plies a spectator's view of a live game lags behind (off by default; set SPEC_DELAY_PLIES=4 to turn it on)
function delayedView(room) {
  const hist = (room.hist || []).slice(0, -SPEC_DELAY);
  let st = Chess.initial();
  for (const h of hist) { const m = Chess.legalMoves(st).find((x) => x.from === h.from && x.to === h.to && (x.promo || null) === (h.promo || null)); if (!m) return null; st = Chess.apply(st, m); }
  return { state: st, hist, moves: room.moves.slice(0, hist.length), last: hist.length ? { from: hist[hist.length - 1].from, to: hist[hist.length - 1].to } : null };
}
function snapshot(room, name, now, pres) {
  const o = outcome(room);
  const dv = SPEC_DELAY > 0 && !o.over && seatOf(room, name) === 's' && room.players.w && room.players.b && (room.hist || []).length > SPEC_DELAY ? delayedView(room) : null;
  const live = room.tc && room.players.w && room.players.b && room.moves.length >= 2 && !o.over && !room.paused;
  const run = live ? room.state.turn : null;
  const left = (c) => (room.clock ? Math.max(0, room.clock[c] - (run === c ? now - room.clock.ts : 0)) : null);
  return {
    code: room.code,
    you: seatOf(room, name),
    state: dv ? dv.state : room.state,
    moves: dv ? dv.moves : room.moves,
    last: dv ? dv.last : room.last,
    delayed: dv ? SPEC_DELAY : 0,
    fp: room.fpCase ? { name: room.fpCase.name, conf: room.fpCase.conf, id: room.fpCase.id } : null,
    status: o,
    players: room.players,
    present: { w: now - (pres.w || 0) < 7000, b: now - (pres.b || 0) < 7000 },
    tc: room.tc,
    clock: room.clock ? { w: left('w'), b: left('b'), running: run } : null,
    delta: room.delta,
    rematch: room.rematch, rematchSeries: room.rematchSeries || null,
    hist: dv ? dv.hist : room.hist || [],
    drawOffer: room.drawOffer || null,
    watching: Object.values(pres.spec || {}).filter((t) => now - t < 7000).length,
    cat: room.cat || R.category(room.tc), ratings: room.ratings || null, unrated: !!room.unrated,
    startedAt: room.startedAt || null, endedAt: room.endedAt || null, v: room.v || 0,
    paused: !!room.paused && !o.over, pauseReq: room.pauseReq || null, resumeReady: room.resumeReady || [],
    match: room.match || null, arma: !!room.arma, tour: room.tour || null,
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
  } else if (needsArchive(cur) && now - (cur.endedAt || 0) > 3000) {
    const bg = later(archiveGame(cur)); if (bg) await bg;                           // recovery if a background archive was lost
  } else if (needsTourReport(cur) && now - (cur.endedAt || 0) > 3000) {
    const bg = later(reportTour(cur)); if (bg) await bg;                            // recovery if a tournament report was lost
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

// ---------- tournaments ----------
// One record per tournament ("tour:<id>", versioned like rooms) plus a small index ("tours") for the list.
// Fixtures are played in normal rooms carrying room.tour; when a room's match is decided the result is
// reported back here (from the game's end, retried from its heartbeat) and the tournament moves on by itself.
const TOUR_ID_RE = /^[a-f0-9]{10}$/;
const tkey = (id) => 'tour:' + id;
const tourRow = (t) => ({ id: t.id, name: t.name, by: t.by, phase: t.phase, kind: t.cfg.kind, n: t.players.length, max: t.cfg.max, tc: t.tc, poll: !!(t.poll && t.poll.chosen == null), startAt: t.startAt || null,
  champion: t.champion, created: t.created, started: t.started, ended: t.ended, players: t.players.map((p) => p.name) });
const tourRun = (t, u) => t.by === u.name || !!u.admin;
const tx = (f) => { try { return f(); } catch (e) { if (e instanceof HttpError) throw e; fail(400, e.message); } };   // engine errors are user errors
async function loadTour(id) {
  id = String(id || '');
  const t = TOUR_ID_RE.test(id) ? await store.get(tkey(id)) : null;
  if (!t) fail(404, 'No such tournament.');
  return t;
}
async function tourIndex(fn) { await editList('tours', (list) => fn(list).slice(0, 100)); }
// ----- tournament chat: player messages plus news lines the server writes when something happens -----
const TCHAT_MAX = 100;
const tcText = (tc) => (tc ? `${tc.base / 60} + ${tc.inc}` : 'no clock');
async function tourSay(id, lines) {
  if (!lines.length) return;
  const now = Date.now();
  await editList('tchat:' + id, (list, k) => [...list, ...lines.map((t) => ({ id: crypto.randomUUID().slice(0, 8), sys: true, t, ts: now, k }))].slice(-TCHAT_MAX));
}
// what changed between two versions of a tournament, as news lines for its chat
function tourNews(a, b) {
  const out = [], had = new Set(a.players.map((p) => p.name)), has = new Set(b.players.map((p) => p.name));
  if (b.phase === 'signup') {
    for (const p of b.players) if (!had.has(p.name)) out.push(`${p.name} joined.`);
    for (const p of a.players) if (!has.has(p.name)) out.push(`${p.name} left.`);
  }
  if (b.poll && a.poll && a.poll.chosen == null && b.poll.chosen != null) out.push(`🗳 ${tcText(b.tc)} won the time-control vote.`);
  if (a.phase === 'signup' && b.phase !== 'signup') out.push(`▶ The tournament has started: ${b.players.length} players, ${tcText(b.tc)}.${b.groups && b.cfg.kind === 'gko' ? ` ${b.groups.length} groups.` : ''} Good luck!`);
  const was = new Map(Tour.allFixtures(a).map((f) => [f.id, f]));
  for (const f of Tour.allFixtures(b)) {
    const o = was.get(f.id);
    if (!f.res || (o && o.res) || f.by === 'bye') continue;
    const h = (x) => (x % 1 ? (Math.floor(x) || '') + '½' : String(x)), sc = f.score ? `${h(f.score[f.res === 'b' ? 1 : 0])}–${h(f.score[f.res === 'b' ? 0 : 1])}` : '';
    const how = f.by === 'awarded' ? ' (set by the organizer)' : '';
    out.push(f.res === 'draw' ? `${f.a} and ${f.b} drew · ${Tour.stageOf(b, f)}${how}` : `${Tour.winnerOf(f)} beat ${f.res === 'a' ? f.b : f.a} ${sc} · ${Tour.stageOf(b, f)}${how}`);
  }
  if (a.cfg.gn !== b.cfg.gn || a.cfg.kn !== b.cfg.kn) {
    const part = b.cfg.kind === 'ko' ? Tour.lengthText(b.cfg.kn, true) : b.cfg.kind === 'rr' || b.cfg.gn === b.cfg.kn ? Tour.lengthText(b.cfg.gn) : `${Tour.lengthText(b.cfg.gn)} in the groups, ${Tour.lengthText(b.cfg.kn, true)} in the knockout`;
    out.push(`⚙ Match length is now ${part}${b.phase === 'signup' ? '' : ' for games that haven\'t started'}.`);
  }
  if (a.phase === 'groups' && b.phase === 'ko') out.push(`${b.cfg.kind === 'ko' ? 'Qualifying' : 'The group stage'} is over: the knockout bracket is drawn (${b.ko.rounds[0].length * 2} players, no byes).`);
  if (a.phase !== 'done' && b.phase === 'done' && b.champion) out.push(`🏆 ${b.champion} wins ${b.name}!`);
  return out;
}

async function mutateTour(id, fn) {
  for (let i = 0; i < 6; i++) {
    const t = await loadTour(id), prevV = t.v, before = JSON.parse(JSON.stringify(t));
    const r = await fn(t);
    if (r && r.noWrite) return { t, r };
    t.v = (prevV || 0) + 1;
    if (await store.cas(tkey(t.id), t, prevV)) {
      // the index only lists tournaments: a failed update must not fail a change that is already saved (the next change fixes it)
      await tourIndex((list) => (list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? tourRow(t) : x)) : [tourRow(t), ...list]))
        .catch((e) => console.error('tournament index update failed:', e.message));
      await tourSay(t.id, tourNews(before, t)).catch((e) => console.error('tournament news failed:', e.message));
      return { t, r };
    }
  }
  fail(409, 'The tournament is busy. Try again.');
}
const needsTourReport = (r) => !!(r.tour && r.match && r.match.done && !r.tourDone);
async function reportTour(room) {
  const T = room.tour, m = room.match, pts = Match.score(m).pts;
  const res = m.winner === T.a ? 'a' : m.winner === T.b ? 'b' : 'draw';
  try {
    await mutateTour(T.id, (t) => {
      const f = Tour.find(t, T.fx);
      if (!f || f.res || f.room !== room.code) return { noWrite: true };
      Tour.record(t, f.id, res, [pts[T.a] || 0, pts[T.b] || 0], 'played', Date.now());
    });
  } catch (e) { if (!(e instanceof HttpError && e.code === 404)) throw e; }    // tournament deleted: nothing to report to
  try { await mutateRoom(room.code, (r) => { if (r.tourDone) return { noWrite: true }; r.tourDone = true; }, { live: false }); }
  catch (e) { if (!(e instanceof HttpError)) throw e; }
}
// start: the vote (if any) decides the time control, and seeding uses everyone's rating in it
async function startTour(t) {
  if (t.poll && t.poll.chosen == null && t.players.length >= Tour.MIN[t.cfg.kind]) {
    Tour.resolvePoll(t);
    const cat = R.category(cleanTc(t.tc)), us = await Promise.all(t.players.map((p) => getUser(p.name)));
    t.players.forEach((p, i) => { if (us[i]) p.elo = R.show(R.ratingOf(us[i], cat)).r; });
  }
  tx(() => Tour.start(t, Date.now()));
}
// a scheduled start: done by whoever looks at the tournament first once the time has come
const tourDue = (x) => x.phase === 'signup' && x.startAt && Date.now() >= x.startAt;
async function autoStart(id) {
  let short = null;
  await mutateTour(id, async (t) => {
    if (!tourDue(t)) return { noWrite: true };
    if (t.players.length < Tour.MIN[t.cfg.kind]) { short = t; t.startAt = null; return; }   // not enough players: the organizer decides
    t.startAt = null;
    await startTour(t);
  });
  if (short) await tourSay(id, [`⏰ Start time reached, but it needs at least ${Tour.MIN[short.cfg.kind]} players. Waiting for the organizer.`]);
}

// "I'm in the room, come and play": recorded on the fixture (shown on the tournament page and in the lobby) and
// pushed to the opponent, who gets a pop-up wherever they are. Repeat presses within a minute don't ping again
// unless it's an explicit reminder (rate-limited to one every 30 seconds).
const WAIT_FRESH = 20 * 60e3;
async function tourWaiting(t, f, name, code, remind) {
  const now = Date.now(), prev = f.wait, opp = f.a === name ? f.b : f.a;
  if (prev && prev.n === name && now - prev.ts < (remind ? 30e3 : 60e3)) { if (remind) fail(429, 'You reminded them just now. Give them a moment.'); return; }
  await mutateTour(t.id, (t2) => { const g = Tour.find(t2, f.id); if (!g || g.res) return { noWrite: true }; g.wait = { n: name, ts: now }; });
  const o = await getUser(opp);
  if (o) await RT.publish(RT.userTopic(o), 'ping', { why: 'tourwait', from: name, name: t.name, stage: Tour.stageOf(t, f), code, id: t.id, remind: !!remind });
}

// the room for a fixture: reserved in the tournament first, so both players always land in the same room
async function tourRoom(t, f) {
  let found = null;
  try { found = await loadRoom(f.room); } catch (e) { if (!(e instanceof HttpError && e.code === 404)) throw e; }
  if (found) return found.tour && found.tour.id === t.id && found.tour.fx === f.id ? found : null;   // a code taken by another game
  if (f.res) fail(404, 'That game has expired.');                    // decided, room gone: nothing to play there any more
  const tc = cleanTc(t.tc), cat = R.category(tc);
  const [ua, ub] = await Promise.all([getUser(f.a), getUser(f.b)]);
  const pa = seatInfo(ua || { name: f.a }, cat), pb = seatInfo(ub || { name: f.b }, cat), aw = crypto.randomInt(2) === 0;
  const extra = { tour: { id: t.id, name: t.name, fx: f.id, stage: Tour.stageOf(t, f), a: f.a, b: f.b } };
  const made = await makeRoom(aw ? { w: pa, b: pb } : { w: pb, b: pa }, tc, Date.now(), f.fmt, f.room, extra);
  if (made) return made;
  // the code is taken: the opponent opened it a moment ago, or it can't be used. Look once; otherwise the caller
  // reserves a new code (this used to call itself forever when the code stayed taken, and the request hung)
  try { const r = await loadRoom(f.room); return r.tour && r.tour.id === t.id && r.tour.fx === f.id ? r : null; } catch { return null; }
}

// ---------- Fair play: automatic forfeit, the public announcement, the community poll and the appeal ----------
// Every case is one record ("fcase:<game id>"): the evidence, the confidence, the votes with their history, the
// discussion, the appeal and an append-only log of everything that happened. The game id makes a case (and its forfeit
// and announcement) happen once, however often the check runs.
const fcaseKey = (id) => 'fcase:' + id, FCASES = 'fcases';
const fairDeps = () => module.exports.fairDeps || {};
const fairLog = (c, who, act, detail) => { c.log = [...(c.log || []), { ts: Date.now(), who, act, detail: detail || null }].slice(-200); };
async function fcaseMutate(id, fn) {
  for (let i = 0; i < 8; i++) {
    const c = await store.get(fcaseKey(id));
    if (!c) fail(404, 'No such case.');
    const next = JSON.parse(JSON.stringify(c)), out = await fn(next);
    if (out === false) return c;
    next.v = (c.v || 0) + 1;
    if (await store.cas(fcaseKey(id), next, c.v || 0)) return next;
  }
  fail(409, 'Busy. Try again.');
}
// From ply 24 of a rated game with a clock, every FAIR_EVERY plies: look at the last 25 moves of each player. Only a very sure result acts.
// Stockfish never runs in the function that serves moves and chat: on Vercel the check runs in api/fairplay.js (FAIR_WORKER), which
// api/index.js calls after a move without waiting; locally (node server.js) it runs in the same process as before.
const FAIR_EVERY = Math.max(1, +process.env.FAIR_EVERY || 6);
let fairWarned = false;
async function fairWatch(room) {
  let gid = null;
  try {
    if (process.env.VERCEL && !process.env.FAIR_WORKER) return;                // the move/chat function never runs the engine
    const hist = room.hist || [], n = hist.length;
    if (!room.tc || room.unrated || n < 24 || n % FAIR_EVERY !== 0 || outcome(room).over || room.forfeit) return;
    gid = gameId(room);
    if (!gid || !(await store.create('fairlock:' + gid + ':' + n, { at: Date.now() }, 3600))) { gid = null; return; }
    if (!(await store.create('fairbusy:' + gid, { at: Date.now() }, 70))) { gid = null; return; }   // a check of this game is still running: the next move's check will catch up
    const exempt = (await store.get('fairexempt')) || [];
    let an = null;
    for (const color of ['w', 'b']) {
      const name = room.players[color].name;
      if (exempt.includes(name.toLowerCase())) continue;                      // exempt players are skipped silently: no scan, no case, no notice
      const ext = chatList(await store.get('fairext:' + name.toLowerCase())).filter((x) => x.game === room.code).length || 0;
      if (fairDeps().scan) {                                                     // test hook: the original single-number check
        const scan = await fairDeps().scan(hist, color, room.mt, name);
        const j = Trib.judge(scan, { ext, tc: room.tc });
        if (j.strong) return fairForfeit(room, color, j, scan);
        continue;
      }
      if (!an) an = await FairAn.analyse(gid, hist, room.mt, { deps: fairDeps() });
      const a = FairAn.assessSide(an.rows, color, { rating: room.players[color].elo, tc: room.tc, ext, prior: await FairAn.history(name) });
      if (a.auto) return fairForfeit(room, color, { confidence: a.confidence, reasons: [...a.evidence, ...a.corroboration.map((x) => 'Supporting: ' + x)], strong: true, level: a.level, p: a.p }, { n: a.n, match: Math.round(a.features.match * 100), acpl: Math.round(a.features.acpl), engine: 'model' });
      if (a.investigate) await fairInvestigate(gid, name, color, a, room.code);
    }
  } catch (e) { console.error('fair-play check failed:', e && e.message); }
  finally { if (gid) await store.del('fairbusy:' + gid).catch(() => {}); }
}
// After a move: start the check without waiting for it.
//  - on Vercel: POST to this deployment's /api/fairplay (its own function, shared secret FAIR_SECRET), which answers at once and works in the background
//  - locally: run it here, as always
function fairPing(body, req) {
  const secret = process.env.FAIR_SECRET;
  if (!secret) { if (!fairWarned) { fairWarned = true; console.error('FAIR_SECRET is not set: the fair-play check is off (set it in Vercel to turn it on)'); } return null; }
  const h = (req && req.headers) || {}, host = h['x-forwarded-host'] || h.host;
  const base = host ? 'https://' + host : appUrl();
  const p = fetch(`${base}/api/fairplay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fair-secret': secret }, body: JSON.stringify({ ...body, srv: store.server() }), signal: AbortSignal.timeout(4000) })
    .catch((e) => console.error('fair-play trigger failed:', e && e.message));
  return later(p);
}
function fairTrigger(room, req) {
  if (!room.tc || room.unrated || (room.hist || []).length < 24) return null;
  if (!process.env.VERCEL) return later(fairWatch(room));
  return fairPing({ code: room.code }, req);
}
// what the worker does for a request: a live game, the analysis of a finished game, or the sweep of unfinished analyses
async function fairWork(b) {
  return store.inServer(/^\d{1,3}$/.test(String(b.srv)) ? String(b.srv) : '1', async () => {
    if (b.code) { const room = await store.get(rkey(String(b.code).toUpperCase())); if (room) await fairWatch(room); }
    else if (b.post) { const g = await store.get('game:' + String(b.post)); if (g) await fairPost(g); }
    else if (b.sweep) await fairSweep();
  });
}
// the work behind api/fairplay.js: check one game, in the server namespace it belongs to
const fairRun = fairWork;
// Suspicious (level 3): an investigation for the admins. Nobody else is told and nothing is enforced.
async function fairInvestigate(gid, name, color, a, code) {
  const id = gid + ':' + color, key = 'finv:' + id, now = Date.now();
  const rec = { id, gid, code: code || '', name, color, level: a.level, p: a.p, evidence: a.evidence, corroboration: a.corroboration, at: now, status: 'open' };
  if (await store.create(key, rec, 400 * 86400)) { await editList('finvs', (list) => [{ id, at: now }, ...list.filter((x) => x.id !== id)].slice(0, 100), 400 * 86400); return; }
  const old = await store.get(key);                                          // already open: keep the stronger reading
  if (old && old.status === 'open' && a.p < old.p) await store.set(key, { ...old, level: a.level, p: a.p, evidence: a.evidence, corroboration: a.corroboration, updated: now }, 400 * 86400);
}
// a finished game: analyse it (cached, resumable), record each side's result in their history, open an investigation if it is suspicious
async function fairPost(g) {
  try {
    if (process.env.VERCEL && !process.env.FAIR_WORKER) { const bg = fairPing({ post: g.id }); if (bg) await bg; return; }   // the engine only runs in api/fairplay.js
    if (!g || !g.rated || !g.tc || (g.hist || []).length < 24 || g.reason === 'fair play forfeit') return;
    const exempt = (await store.get('fairexempt')) || [];
    const an = await FairAn.analyse(g.id, g.hist, g.mt || null, { deps: fairDeps() });
    if (!an.done) { await editList('fq', (list) => [...list.filter((x) => x.id !== g.id), { id: g.id, at: Date.now() }].slice(-200), 7 * 86400); return; }
    await editList('fq', (list) => list.filter((x) => x.id !== g.id), 7 * 86400);
    for (const color of ['w', 'b']) {
      const name = g.players[color].name;
      if (exempt.includes(name.toLowerCase())) continue;
      const prior = (await FairAn.history(name)).filter((e) => e.id !== g.id);
      const ext = chatList(await store.get('fairext:' + name.toLowerCase())).filter((x) => x.game === g.code).length || 0;
      const a = FairAn.assessSide(an.rows, color, { rating: g.ratings ? g.ratings[color].before : g.players[color].elo, tc: g.tc, ext, prior });
      if (a.Z === null) continue;
      await FairAn.addHistory(name, { id: g.id, at: g.endedAt || Date.now(), Z: a.Z, p: a.p, n: a.n, level: a.level });
      await store.set('fairlast:' + name.toLowerCase(), { id: g.id, at: g.endedAt || Date.now(), ...FairAn.summary(a) }, 400 * 86400);
      if (a.level >= 3) await fairInvestigate(g.id, name, color, a, g.code);
    }
  } catch (e) { console.error('fair-play analysis failed:', e && e.message); }
}
// finish the analysis of games that were cut short (called from the lobby's regular case refresh; one at a time)
async function fairSweep() {
  if (process.env.VERCEL && !process.env.FAIR_WORKER) { const bg = fairPing({ sweep: true }); if (bg) await bg; return; }
  const q = chatList(await store.get('fq'));
  if (!q.length || !(await store.create('fairsweep', { at: Date.now() }, 25))) return;
  const g = await store.get('game:' + q[0].id);
  if (!g) { await editList('fq', (list) => list.filter((x) => x.id !== q[0].id), 7 * 86400); return; }
  await fairPost(g);
}
// Confirmed (level 5): a ban a tribunal or an admin applied and that was not overturned
async function fairConfirm(name, id, on) {
  const k = 'fconf:' + name.toLowerCase();
  await editList(k, (list) => (on ? [{ id, at: Date.now() }, ...list.filter((x) => x.id !== id)] : list.filter((x) => x.id !== id)).slice(0, 50), 800 * 86400);
}
async function fairOpenManual(adminName, t, game, note, reasons) {
  const now = Date.now(), id = 'FLAG0-' + now.toString(36);
  const c = { id, code: '', name: t.name, color: null, conf: null, manual: true, game, evidence: { scan: null, reasons: reasons || ['Flagged by an admin' + (note ? ': ' + note : '')], plies: 0, at: now },
    status: 'poll', createdAt: now, pollEnds: now + Trib.POLL_MS, votes: {}, comments: [], appeal: null, result: null, log: [], v: 0 };
  fairLog(c, adminName, 'flagged', note || 'no note');
  if (!(await store.create(fcaseKey(id), c, 400 * 86400))) fail(409, 'Try again.');
  await editList(FCASES, (list) => [{ id, name: t.name, at: now }, ...list].slice(0, 100), 400 * 86400);
  return id;
}
async function fairForfeit(room, color, j, scan) {
  const gid = gameId(room), name = room.players[color].name;
  const c = { id: gid, code: room.code, name, color, conf: j.confidence, level: j.level || null, p: j.p == null ? null : j.p, evidence: { scan, reasons: j.reasons, plies: (room.hist || []).length, tc: room.tc, at: Date.now() },
    status: 'poll', createdAt: Date.now(), pollEnds: Date.now() + Trib.POLL_MS, votes: {}, comments: [], appeal: null, result: null, log: [], v: 0 };
  fairLog(c, 'system', 'detected', `confidence ${j.confidence}: ${j.reasons.join('; ')}`);
  if (!(await store.create(fcaseKey(gid), c, 400 * 86400))) return;           // already handled
  const { room: cur } = await mutateRoom(room.code, (r) => {
    if (gameId(r) !== gid || outcome(r).over) return { noWrite: true };
    r.forfeit = color; r.fpCase = { id: gid, name, conf: j.confidence }; markEnded(r);
  });
  await fcaseMutate(gid, (x) => { fairLog(x, 'system', 'forfeit', `${name} forfeited the game`); });
  await editList(FCASES, (list) => [{ id: gid, name, at: c.createdAt }, ...list.filter((x) => x.id !== gid)].slice(0, 100), 400 * 86400);
  const phrases = (await store.get('fairphrases')) || [];
  const text = Trib.announceText(phrases.length ? phrases : null, name, c.createdAt);
  const msg = { id: crypto.randomUUID().slice(0, 8), name: 'Fair Play', text, ts: Date.now(), admin: true, sys: true, fp: gid };
  await editChat('chat:lobby', (list) => [...list, msg].slice(-60));
  await RT.publish('lobby', 'chat', msg);
  await fcaseMutate(gid, (x) => { fairLog(x, 'system', 'announced'); });
  RT.publish('room:' + room.code, 's', { v: cur.v });
  await afterEnd(cur);
}
// polls that ran out: apply the community's decision (or move on after an appeal vote)
async function fairClose(c, now) {
  if (c.status === 'poll' && now >= c.pollEnds) {
    const d = Trib.decide(c.votes), until = Trib.untilOf(d.key, now);
    return fcaseMutate(c.id, async (x) => {
      if (x.status !== 'poll') return false;
      x.status = 'decided'; x.result = { key: d.key, counts: d.counts, total: d.total, by: 'community', at: now, until, appealUntil: now + Trib.APPEAL_MS };
      fairLog(x, 'system', 'poll closed', `${d.key} (${d.total} votes)`);
      if (until) { const t = await getUser(x.name); if (t && !t.admin) { t.banUntil = until; await saveUser(t); authCache.delete(t.name.toLowerCase()); fairLog(x, 'system', 'applied', d.key); await fairConfirm(x.name, x.id, true); } }
    });
  }
  if (c.status === 'appeal' && now >= c.appeal.ends) {
    const t = Trib.tally(c.appeal.votes, ['uphold', 'overturn']), over = t.total >= Trib.QUORUM && t.counts.overturn > t.counts.uphold;
    return fcaseMutate(c.id, async (x) => {
      if (x.status !== 'appeal') return false;
      x.status = 'closed'; x.appeal.result = { counts: t.counts, total: t.total, overturned: over, at: now };
      fairLog(x, 'system', 'appeal closed', over ? 'overturned' : 'upheld');
      if (over) { const u = await getUser(x.name); if (u && u.banUntil) { delete u.banUntil; await saveUser(u); authCache.delete(u.name.toLowerCase()); fairLog(x, 'system', 'ban lifted'); } await fairConfirm(x.name, x.id, false); }
    });
  }
  if (c.status === 'decided' && now >= c.result.appealUntil) return fcaseMutate(c.id, (x) => { if (x.status !== 'decided') return false; x.status = 'closed'; fairLog(x, 'system', 'closed', 'no appeal'); });
  return c;
}
const fairPublic = (c, me) => ({
  id: c.id, code: c.code, name: c.name, conf: c.conf, manual: !!c.manual, game: c.manual ? c.game || null : c.id, status: c.status, createdAt: c.createdAt, pollEnds: c.pollEnds,
  evidence: { reasons: c.evidence.reasons, n: c.evidence.scan && c.evidence.scan.n, match: c.evidence.scan && c.evidence.scan.match, acpl: c.evidence.scan && c.evidence.scan.acpl },
  options: Trib.OPTIONS.map((o) => ({ key: o.key, label: o.label })), poll: Trib.tally(c.votes), mine: (c.votes[me.toLowerCase()] || {}).o || null,
  result: c.result, comments: (c.comments || []).slice(-40),
  appeal: c.appeal ? { text: c.appeal.text, at: c.appeal.at, ends: c.appeal.ends, poll: Trib.tally(c.appeal.votes, ['uphold', 'overturn']), mine: (c.appeal.votes[me.toLowerCase()] || {}).o || null, result: c.appeal.result || null } : null,
  canAppeal: c.name.toLowerCase() === me.toLowerCase() && c.status === 'decided' && !c.appeal,
});

// ---------- The Damage Report: how brutal was this one game? (lib/damage.js scores it, lib/damagetext.js writes the line) ----------
// A finished online game gets a card the moment it is archived: scored from the moves alone and given a template line,
// so something sensible exists straight away. Then the engine looks at every position in slices that fit a serverless
// time limit (progress is saved, so a slow or failed run only delays the final card), the card is re-scored with the
// real evaluation, the commentary is written (AI if it is configured and behaves, the template bank if not) and the
// card is final. Everything is stored per game ("dmg:<id>"), so nothing is analysed or written twice, and a page view
// never touches the engine or the AI. Draws, aborted, abandoned, pass & play and too-short games never get a card.
const DMG = { feed: 'dmgfeed', recent: 'dmgrecent', opt: 'dmgopt', queue: 'dmgq', backfill: 'dmgbackfill', MIN: 21, FEED_MAX: 80 };
const DMG_BUDGET = +process.env.DAMAGE_BUDGET_MS || (process.env.VERCEL ? 5000 : 30000);
const DMG_RETRY = [60e3, 5 * 60e3, 30 * 60e3, 3 * 3600e3];                 // waits after a failed analysis; then the card stays as it is
const dmgKey = (id) => 'dmg:' + id, dmgJobKey = (id) => 'dmgjob:' + id;
const dmgInflight = new Set();                                              // running jobs of this instance (tests wait for them)
const dmgDeps = () => module.exports.damageDeps || {};
const dmgRow = (r) => { const { tl, low2, ...x } = r; return x; };            // the light version for the feed (no graph)
const dmgQualifies = (r) => r.kind === 'comeback' || r.score >= DMG.MIN;
const dmgIdOk = (id) => GAME_ID_RE.test(String(id || ''));

async function dmgFeedPut(rec) {
  await editList(DMG.feed, (list) => {
    const rest = list.filter((x) => x.id !== rec.id);
    return dmgQualifies(rec) ? [dmgRow(rec), ...rest].sort((a, b) => b.at - a.at).slice(0, DMG.FEED_MAX) : (rest.length === list.length ? list : rest);
  }, 30 * 86400);
}
async function dmgQueuePut(id, rt, n) { await editList(DMG.queue, (list) => [...list.filter((x) => x.id !== id), { id, rt, n }].slice(-200), 7 * 86400); }
async function dmgQueueDone(id) { await editList(DMG.queue, (list) => (list.some((x) => x.id === id) ? list.filter((x) => x.id !== id) : list), 7 * 86400); }
async function dmgRecentPut(line) { await editList(DMG.recent, (list) => [{ line: line.line, tpl: line.tpl || null, type: line.type || null }, ...list].slice(0, 30), 30 * 86400); }

// a finished game that was just saved: make its card (once, however many times the game-end is processed)
async function damageEnqueue(g) {
  if (await store.get('dmgoff')) return { skipped: 'off for this server' };
  if (Dmg.eligible(g)) return { skipped: Dmg.eligible(g) };
  const rep = Dmg.replay(g.hist);
  if (!rep) return { skipped: 'unreadable' };
  const f = Dmg.buildFacts(g, rep, null), sc = Dmg.score(f), card = Dmg.cardOf(g, f, sc);
  const recent = chatList(await store.get(DMG.recent));
  const t = DmgText.fromBank(DmgText.ctxOf(card, f, { target: dmgTargetOf(await dmgTargets(), f) }), recent, g.id);
  const rec = { ...card, line: t ? t.line : `${f.winner} beat ${f.loser} in ${f.moves} moves.`, src: 'template', tpl: t ? t.tpl : 'plain', ltype: t ? t.type : 'gen', st: 'q', made: Date.now(), llm: 0 };
  if (!(await store.create(dmgKey(g.id), rec, 90 * 86400))) return { dup: true };   // the same game ended twice: one card
  await dmgQueuePut(g.id, Date.now(), 0);
  await dmgFeedPut(rec);
  return { card: rec };
}

// the usable in-game chat for a finished game (stored server-side, from its two players, filtered); empty is fine
async function dmgChatOf(g) {
  try {
    const users = await Promise.all(['w', 'b'].map((c) => getUser(g.players[c].name)));
    const muted = users.filter((u) => u && (u.muted || u.dmgOptOut)).map((u) => u.name);
    return DmgText.Chat.pick(g, chatList(await store.get('gchat:' + g.code)), muted);
  } catch (e) { return []; }
}

// one slice of work on a game: analyse, then (when every position is done) score and write the final card
async function damageRun(id, budget = DMG_BUDGET) {
  const key = dmgKey(id), jk = dmgJobKey(id), now = Date.now();
  const rec = await store.get(key);
  if (!rec || rec.st === 'd' || rec.st === 'f') { await dmgQueueDone(id); return { done: true }; }
  const job = await store.get(jk);
  if (job && job.lease > now) return { busy: true };                          // someone else is on it
  const next = { v: ((job && job.v) || 0) + 1, ev: (job && job.ev) || [], best: (job && job.best) || [], tries: (job && job.tries) || 0, lease: now + Math.max(60e3, budget + 30e3) };
  if (!(job ? await store.cas(jk, next, job.v) : await store.create(jk, next, 86400))) return { busy: true };
  try {
    const g = await store.get('game:' + id);
    const rep = g && Dmg.replay(g.hist);
    if (!rep) throw new Error('game missing');
    const part = await DmgEng.analyseSlice(rep.states, { ev: next.ev, best: next.best }, budget, dmgDeps().engine);
    if (!part.done) { await store.set(jk, { v: next.v + 1, ev: part.ev, best: part.best, tries: next.tries, lease: 0 }, 86400); return { partial: part.ev.length / rep.states.length }; }
    const f = Dmg.buildFacts(g, rep, { ev: part.ev, best: part.best }), sc = Dmg.score(f), card = Dmg.cardOf(g, f, sc);
    const recent = chatList(await store.get(DMG.recent));
    const c = await DmgText.commentary(card, f, recent, dmgDeps().ai, { target: dmgTargetOf(await dmgTargets(), f), chat: await dmgChatOf(g) });
    const fin = { ...card, line: c.line, src: c.src, tpl: c.tpl || null, ltype: c.type || null, st: 'd', made: rec.made, llm: (rec.llm || 0) + (DmgText.aiEnabled(dmgDeps().ai) ? 1 : 0) };
    await store.set(key, fin, 90 * 86400);
    await store.set(jk, { v: next.v + 1, ev: part.ev, best: part.best, tries: next.tries, lease: 0, done: true }, 6 * 3600);   // kept a few hours: a template line can be redone by the AI
    await dmgRecentPut(c);
    await dmgFeedPut(fin);
    await dmgQueueDone(id);
    return { done: true, card: fin };
  } catch (e) {
    console.error('damage analysis failed:', id, e.message);
    const tries = next.tries + 1;
    await store.set(jk, { v: next.v + 1, ev: next.ev, best: next.best, tries, lease: 0 }, 86400).catch(() => {});
    if (tries > DMG_RETRY.length) {                                           // give up: the card stays as scored from the moves alone
      await store.set(key, { ...rec, st: 'f' }, 90 * 86400); await dmgQueueDone(id);
      await dmgFeedPut({ ...rec, st: 'f' });
    } else await dmgQueuePut(id, Date.now() + DMG_RETRY[tries - 1], tries);
    return { failed: true };
  }
}
function damageTrack(p) { const t = Promise.resolve(p).catch((e) => console.error('damage job failed:', e && e.message)).finally(() => dmgInflight.delete(t)); dmgInflight.add(t); return t; }
const damageLater = async (p) => { const t = damageTrack(p); const bg = later(t); if (bg) await bg; };

// the finished card for the AI to redo when its line was a template (the AI was down)
async function damageRelive(id) {
  const rec = await store.get(dmgKey(id)), job = await store.get(dmgJobKey(id));
  if (!rec || rec.st !== 'd' || rec.src === 'ai' || !job || !job.done) return;
  const g = await store.get('game:' + id), rep = g && Dmg.replay(g.hist);
  if (!rep) return;
  const f = Dmg.buildFacts(g, rep, { ev: job.ev, best: job.best }), sc = Dmg.score(f), card = Dmg.cardOf(g, f, sc);
  const recent = chatList(await store.get(DMG.recent)).filter((x) => x.line !== rec.line);
  const c = await DmgText.commentary(card, f, recent, dmgDeps().ai, { target: dmgTargetOf(await dmgTargets(), f), chat: await dmgChatOf(g) });
  const fresh = { ...rec, llm: (rec.llm || 0) + 1 };
  if (c.src === 'ai') { Object.assign(fresh, { line: c.line, src: 'ai', tpl: null, ltype: 'ai' }); await dmgRecentPut(c); }
  await store.set(dmgKey(id), fresh, 90 * 86400);
  if (c.src === 'ai') await dmgFeedPut(fresh);
}

// pick up unfinished work (at most a couple of games per call), and give the AI another go at template lines
const dmgSweepAt = new Map();                                              // per server: each has its own queue
async function damageSweep() {
  const now = Date.now();
  const sk = store.server();
  if (now - (dmgSweepAt.get(sk) || 0) < 15e3) return;
  dmgSweepAt.set(sk, now);
  const q = chatList(await store.get(DMG.queue)).filter((x) => x.rt <= now).sort((a, b) => a.rt - b.rt).slice(0, 2);
  for (const x of q) await damageRun(x.id);
  const aiOn = DmgText.aiEnabled(dmgDeps().ai);
  if (aiOn && !q.length) {
    const redo = chatList(await store.get(DMG.feed)).find((x) => x.st === 'd' && x.src !== 'ai' && (x.llm || 0) < 3 && now - x.at < 6 * 3600e3);
    if (redo) await damageRelive(redo.id);
  }
}

// the first time on a server: give the last couple of weeks of finished games a card (they are analysed a few at a time)
async function damageBackfill() {
  if (!(await store.create(DMG.backfill, { at: Date.now() }))) return;
  const lb = (await store.get('lb')) || {}, names = Object.keys(lb).slice(0, 300);
  const raws = names.length ? await store.getMany(names.map((n) => 'games:' + n.toLowerCase())) : [];
  const seen = new Set(), cand = [];
  for (const raw of raws) for (const x of chatList(raw)) {
    if (!x.id || x.color !== 'w' || x.result === 'draw' || seen.has(x.id) || Date.now() - x.at > 14 * 86400e3 || !['checkmate', 'resignation', 'timeout'].includes(x.reason) || (x.moves || 0) < 8) continue;
    seen.add(x.id); cand.push(x);
  }
  cand.sort((a, b) => b.at - a.at);
  for (const x of cand.slice(0, 40)) { const g = await store.get('game:' + x.id); if (g) await damageEnqueue(g); }
}

// players who asked not to be featured (either player in the game is enough)
// players the admin has marked for extra mean commentary (when they are the one who lost)
async function dmgTargets() { const o = await store.get('dmgtarget'); return (o && o.map) || {}; }
const dmgTargetOf = (tg, f) => !!tg[String(f.loser || '').toLowerCase()];
async function dmgOptOut() { const o = await store.get(DMG.opt); return (o && o.map) || {}; }
const dmgShown = (r, opt, lb) => !opt[r.w.toLowerCase()] && !opt[r.b.toLowerCase()] && (!lb || (lb[r.w] && lb[r.b]));

// what the home page shows: the most brutal game of the day (the week if the day is quiet) and a strip of recent one-sided games
function damagePick(rows, now) {
  const dayStart = Math.floor(now / 86400e3) * 86400e3, week = now - 7 * 86400e3;
  const best = (list) => {
    const dom = list.filter((r) => r.kind === 'domination');
    const pool = (dom.some((r) => !r.prov) ? dom.filter((r) => !r.prov) : dom.length ? dom : list.filter((r) => !r.prov).length ? list.filter((r) => !r.prov) : list);
    return pool.slice().sort((a, b) => b.rank - a.rank || b.at - a.at)[0] || null;
  };
  let scope = 'today', headline = best(rows.filter((r) => r.at >= dayStart));
  if (!headline) { scope = 'week'; headline = best(rows.filter((r) => r.at >= week)); }
  if (!headline) { scope = 'earlier'; headline = best(rows); }
  const rest = rows.filter((r) => r !== headline);
  let strip = rest.filter((r) => r.at >= week);
  if (!strip.length) strip = rest;
  strip = strip.sort((a, b) => b.rank - a.rank || b.at - a.at).slice(0, 10);
  return { headline, scope, strip };
}

// share cards and the link page are public (a link preview has no login), so they check everything themselves
const dmgImgCache = new Map();
async function damagePublic(req, res, url) {
  const q = url.searchParams;
  let raw = q.get('p') || (url.pathname.startsWith('/d/') ? decodeURIComponent(url.pathname.slice(3)) : q.get('id') || ''), srv = q.get('s') || '1';
  const m = /^(?:(\d{1,3})\.)?([A-Z0-9]{5}-[a-z0-9]{1,12})$/.exec(raw);
  const text = (code, type, body, extra) => { if (res.headersSent) return; res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...(extra || {}) }); res.end(body); };
  if (!m) return text(404, 'text/plain', 'Not found');
  if (m[1]) srv = m[1];
  const id = m[2];
  return store.inServer(/^\d{1,3}$/.test(srv) ? srv : '1', async () => {
    const [rec, opt, lb] = await Promise.all([store.get(dmgKey(id)), dmgOptOut(), store.get('lb')]);
    if (!rec || rec.st === 'q' && !rec.line || !dmgQualifies(rec) || !dmgShown(rec, opt, lb || {})) return text(404, 'text/plain', 'Not found');
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim(), proto = String(req.headers['x-forwarded-proto'] || (/^localhost|^127\./.test(host) ? 'http' : 'https')).split(',')[0];
    const origin = `${proto}://${host}`, sid = store.server(), idq = encodeURIComponent(id);
    if (q.get('r') === 'damage_img' || q.get('r') === 'damage_png') {
      const fmt = q.get('fmt') === 'wide' ? 'wide' : 'portrait', type = q.get('type') === 'svg' ? 'svg' : 'png';
      const k = [sid, id, fmt, type, host, rec.line].join('|');
      let hit = dmgImgCache.get(k);
      if (!hit) {
        const svg = DmgCard.svgOf(rec, fmt, host), png = type === 'png' ? DmgCard.pngOf(svg, DmgCard.FMT[fmt].w) : null;
        hit = png ? { type: 'image/png', body: png } : { type: 'image/svg+xml', body: svg };
        dmgImgCache.set(k, hit); if (dmgImgCache.size > 80) dmgImgCache.delete(dmgImgCache.keys().next().value);
      }
      const dl = q.get('dl') ? { 'Content-Disposition': `attachment; filename="damage-report-${id}-${fmt}.${hit.type === 'image/png' ? 'png' : 'svg'}"` } : {};
      return text(200, hit.type, hit.body, { 'Cache-Control': 'public, max-age=3600', ...dl });
    }
    // the link page: the preview text and picture, then straight on to the replay
    const e = DmgCard.esc, who = `${rec.w} ${rec.result === 'w' ? '1–0' : '0–1'} ${rec.b}`;
    const title = `The Damage Report: ${who}`, img = `${origin}/api?r=damage_img&fmt=wide&s=${sid}&id=${idq}`, target = `${origin}/?archive=${idq}`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)}</title>
<meta property="og:type" content="website"><meta property="og:title" content="${e(title)}"><meta property="og:description" content="${e(rec.line)}"><meta property="og:image" content="${e(img)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${e(title)}"><meta name="twitter:description" content="${e(rec.line)}"><meta name="twitter:image" content="${e(img)}">
<meta name="robots" content="noindex"><meta http-equiv="refresh" content="1;url=${e(target)}"><style>body{margin:0;background:#1b1a18;color:#f2f1ec;font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center;padding:16px}img{max-width:min(100%,640px);border-radius:10px}a{color:#9fd0f0}</style></head>
<body><div><img src="${e(img)}" alt="${e(rec.line)}"><p>${e(rec.line)}</p><p><a href="${e(target)}">Watch the replay</a></p></div></body></html>`;
    return text(200, 'text/html; charset=utf-8', html, { 'Cache-Control': 'public, max-age=300' });
  });
}

// ---------- rivalries ----------
const rivSeasonKey = (a, b) => 'rivseason:' + [a.toLowerCase(), b.toLowerCase()].sort().join('|');
function rivCtx(u, lb, onlineRaw, live, now) {
  const people = new Map(Object.entries(lb || {}).map(([n, x]) => [n.toLowerCase(), { name: n, ratings: x.ratings || R.summary(x) }]));
  const on = new Set(onlineList(onlineRaw, null, (live || []).filter((g) => now - g.ts < LIVE_TTL), u.name, now).filter((p) => p.st !== 'offline').map((p) => p.name.toLowerCase()));
  const playing = new Set((live || []).filter((g) => now - g.ts < LIVE_TTL).flatMap((g) => [g.w.name.toLowerCase(), g.b.name.toLowerCase()]));
  return { people, on, playing, myRatings: R.summary(u) };
}
function rivCard(games, ctx, now) {
  const last = games[games.length - 1], k = last.opp.toLowerCase(), p = ctx.people.get(k);
  const s = Riv.summary(p ? p.name : last.opp, games, now), mine = ctx.myRatings[s.cat], theirs = p && p.ratings[s.cat];
  return {
    ...s,
    available: !!p,                                   // deleted, or moved to another server: the history stays, no rematch
    online: ctx.on.has(k), playing: ctx.playing.has(k),
    rating: theirs ? { r: theirs.r, prov: !!theirs.prov } : null, myRating: mine ? { r: mine.r, prov: !!mine.prov } : null,
  };
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
    const [u, inboxRaw, outboxRaw, lb, chat, live, ann, onlineRaw, resIn, resOut, clonesRaw, servers, toursRaw] = await Promise.all([
      auth(req), store.get('inbox:' + lname), store.get('outbox:' + lname), store.get('lb'),
      store.get('chat:lobby'), store.get('live'), store.get('announce'), store.get('online'),
      store.get('results:' + lname), store.get('resultsout:' + lname), store.get(clonesKey(lname)), getServers(), store.get('tours'),
    ]);
    // tournament matches waiting for me (only tournaments I play in, still running)
    const myTours = chatList(toursRaw).filter((x) => (x.phase === 'groups' || x.phase === 'ko') && (x.players || []).includes(u.name)).slice(0, 10);
    const tourDocs = myTours.length ? await store.getMany(myTours.map((x) => tkey(x.id))) : [];
    const tourNext = tourDocs.filter(Boolean).flatMap((t) => Tour.myFixtures(t, u.name).slice(0, 1).map((f) => ({ id: t.id, name: t.name, fx: f.id, opp: f.a === u.name ? f.b : f.a, stage: Tour.stageOf(t, f), room: f.room,
      wait: f.wait && f.wait.n !== u.name && now - f.wait.ts < WAIT_FRESH ? f.wait.ts : null })));
    const liveP = withTurns((live || []).filter((g) => now - g.ts < LIVE_TTL));   // runs alongside markOnline
    const bgo = later(markOnline(u.name, 'lobby', onlineRaw)); if (bgo) await bgo;
    const liveNow = await liveP;
    const inbox = (inboxRaw || []).filter((c) => now - c.ts < CHALLENGE_TTL);
    let outbox = outboxRaw;
    if (outbox && outbox.status === 'pending' && now - outbox.ts > CHALLENGE_TTL) outbox = null;
    const rows = Object.entries(lb || {}).map(([name, st]) => ({ name, ratings: st.ratings || R.summary(st), w: st.w || 0, l: st.l || 0, d: st.d || 0 }));
    const leaderboards = {};
    for (const c of R.CATS)
      leaderboards[c] = rows.filter((x) => x.ratings[c].n > 0)          // only players with rated games in this time control
        .map((x) => ({ name: x.name, r: x.ratings[c].r, prov: x.ratings[c].prov, n: x.ratings[c].n, w: x.w, l: x.l, d: x.d }))
        .sort((x, y) => (y.r - x.r) || (y.n - x.n)).slice(0, 25);   // rank by rating; games played only breaks ties
    return {
      user: { ...pub(u), banUntil: u.banUntil && u.banUntil > Date.now() ? u.banUntil : 0, dmgHide: !!u.hideDamage, dmgOut: !!u.dmgOptOut, admin: !!u.admin, muted: !!u.muted, srvName: u.admin && servers.list.length > 1 ? serverName(servers, srvOf(u)) : '' },   // admins only: players aren't told about servers
      inbox, outbox, leaderboards, leaderboard: leaderboards.blitz,
      chat: chatList(chat).slice(-50),
      live: liveNow,
      announce: ann && ann.text ? ann.text : '',
      online: onlineList(onlineRaw, lb, live, u.name, now),
      // pass & play results waiting for my answer (without the move list), and answers to the ones I sent
      results: chatList(resIn).filter((x) => now - x.ts < RESULT_TTL * 1000).map(({ hist, moves, ...x }) => ({ ...x, n: hist.length })),
      resultsOut: chatList(resOut).filter((x) => x.status !== 'pending'),
      // people who played my clone
      clones: chatList(clonesRaw).filter((x) => !x.seen && now - x.ts < CLONE_TTL * 1000).map(({ gids, day, pinged, seen, ...x }) => x),
      tourNext,
      // tournaments open for sign-ups that I haven't joined: invitations on the main page
      tourOpen: chatList(toursRaw).filter((x) => x.phase === 'signup' && !(x.players || []).includes(u.name) && x.n < x.max)
        .slice(0, 5).map(({ id, name, by, n, max, kind, tc, poll, startAt }) => ({ id, name, by, n, max, kind, tc, poll, startAt })),
      // the main page's Tournaments card: what's open or running, and the ones that just finished
      tours: chatList(toursRaw).filter((x) => x.phase !== 'done' || now - (x.ended || 0) < 3 * 86400e3)
        .sort((a, b) => ({ signup: 1, groups: 0, ko: 0, done: 2 })[a.phase] - ({ signup: 1, groups: 0, ko: 0, done: 2 })[b.phase] || b.created - a.created).slice(0, 6)
        .map(({ players, ...x }) => ({ ...x, in: (players || []).includes(u.name) })),
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
    await mentionLater(u, text, { kind: 'game', code: room.code, title: room.tour ? room.tour.name : '' });
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
    const [me, t] = await Promise.all([auth(req), peerUser(name)]);
    if (!t) fail(404, 'No player with that name.');
    const ratings = {};
    for (const c of R.CATS) {
      const rec = R.ratingOf(t, c);
      ratings[c] = { ...R.show(rec), rd: Math.round(rec.rd), peak: rec.peak || Math.round(rec.r), w: rec.w || 0, l: rec.l || 0, d: rec.d || 0, hist: rec.hist || [] };
    }
    return { name: t.name, joined: t.created || null, w: t.w || 0, l: t.l || 0, d: t.d || 0, ratings,
      ...(me.name === t.name ? { recovery: !!t.recovery } : {}) };
  },

  // A player's game archive: one summary row per finished game, newest first (filtering and sorting happen in the browser).
  async games(req, body) {
    const name = String(body.name || '').trim();
    if (!NAME_RE.test(name)) fail(400, 'No player with that name.');
    const [, raw] = await Promise.all([authFast(req), store.get('games:' + name.toLowerCase())]);
    return { name, games: chatList(raw) };
  },
  // One archived game, for replay and analysis. Read-only: never touches rooms, ratings or accounts.
  async game_get(req, body) {
    const id = String(body.id || '');
    if (!GAME_ID_RE.test(id)) fail(400, 'That is not a game link.');
    const [, g] = await Promise.all([authFast(req), store.get('game:' + id)]);
    if (!g) fail(404, 'That game is not in the archive.');
    return { game: g };
  },

  // A player's recent archived games with their moves, in one call: the input for "Play against a style"
  // (the profile is built in the browser). Moves go as one UCI string per game to keep the response small.
  async style_games(req, body) {
    const [, t] = await Promise.all([authFast(req), peerUser(String(body.name || '').trim())]);
    if (!t) fail(404, 'No player with that name.');
    const n = Math.max(1, Math.min(STYLE_MAX, +body.n || STYLE_MAX));
    const all = chatList(await store.get('games:' + t.name.toLowerCase())).filter((x) => x.id);
    const rows = all.filter((x) => x.moves >= 2).slice(0, n);
    const recs = rows.length ? await store.getMany(rows.map((x) => 'game:' + x.id)) : [];
    const games = [];
    rows.forEach((x, i) => {
      const g = recs[i];
      if (!g || !Array.isArray(g.hist) || !g.players || !g.players[x.color]) return;
      const opp = other(x.color);
      games.push({ id: g.id, color: x.color, result: g.result, reason: g.reason, tc: g.tc || null, cat: g.cat, at: g.endedAt,
        moves: g.hist.map((h) => Chess.sqName(h.from) + Chess.sqName(h.to) + (h.promo ? h.promo.toLowerCase() : '')).join(' '),
        mt: g.mt || null, ck: g.ck || null, eco: g.eco || null, opening: g.opening || null,
        elo: g.ratings ? g.ratings[x.color].before : g.players[x.color].elo, opp: g.players[opp] ? g.players[opp].name : '?',
        oppElo: g.ratings ? g.ratings[opp].before : g.players[opp] && g.players[opp].elo });
    });
    return { name: t.name, games, total: all.length };
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
    const room = await makeRoom(players, body.tc, now, body.match);
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
      // thinking time per move (and the clock left after it), for the playstyle profile's time-management habits
      const spent = Math.max(0, Math.min(36e5, now - (room.tc ? room.clock.ts : room.lastAt || now)));
      if (room.tc) {
        if (room.moves.length >= 2) room.clock[seat] += room.tc.inc * 1000 - (now - room.clock.ts);
        room.clock.ts = now;
      }
      room.mt = room.mt || []; room.mt.push(Math.round(spent)); room.lastAt = now;
      if (room.tc) { room.ck = room.ck || []; room.ck.push(Math.max(0, Math.round(room.clock[seat]))); }
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
    // live rated games: the room channel is open to anyone who knows the code, so it only says "something changed";
    // the move itself goes to the opponent's private channel (a spectator account gets the delayed view from the server)
    let pub;
    if (room.tc && !room.unrated && !room.endedAt && room.players.w && room.players.b) {
      const opp = await getUser(room.players[room.state.turn].name);
      pub = Promise.all([RT.publish(topic, 's', { v: room.v }), opp ? RT.publish(RT.userTopic(opp), 'ping', { why: 'm', code: room.code, ev }) : null]);
    } else pub = RT.publish(topic, 'm', ev);
    tmark(req, 'push');
    if (process.env.PERF) perfLog.push({ v: room.v, code: room.code, recvAt: req[TM].wall, marks: req[TM].marks.slice(), pubAt: performance.timeOrigin + performance.now() });
    await pub;
    { const bg = fairTrigger(room, req); if (bg) await bg; }                   // the fair-play check runs in the background (on Vercel: in its own function)
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
        room.lastAt = Date.now();                                   // a pause isn't thinking time (untimed games)
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
      if (room.tour && (!room.match || room.match.done)) fail(400, 'This tournament match is over.');
      // "best of 3": either player can offer it; the other accepts with either rematch button
      // (not once the other player has asked for a plain rematch: that would start a series they never agreed to)
      if (body.series === 'bo3' && !room.tour && (!room.match || room.match.done) && !room.rematch.some((x) => x !== seat)) room.rematchSeries = 'bo3';
      if (!room.rematch.includes(seat)) room.rematch.push(seat);
      if (room.rematch.length === 2) {
        const series = room.rematchSeries;
        const [a, b] = [room.players.w, room.players.b];
        const [ua, ub] = await Promise.all([getUser(a.name), getUser(b.name)]);
        const cat = room.cat || R.category(room.tc);
        room.players = { w: seatInfo(ub || { name: b.name }, cat), b: seatInfo(ua || { name: a.name }, cat) };
        freshGame(room, Date.now());
        if (series) { room.match = Match.start(Match.clean({ fmt: 'bo', n: 3 })); room.match.p = [room.players.w.name, room.players.b.name]; }
        else if (room.match) {
          if (room.match.done) room.match = Match.again(room.match);            // a finished match: start the next one
          else if (room.match.arma) {                                         // the decider: Black has less time but draw odds
            room.arma = true;
            if (room.clock) room.clock.b = Math.round(room.tc.base * Match.ARMA_BLACK) * 1000;
          }
        }
      }
    }, { req });
    await RT.publish('room:' + room.code, 's', { v: room.v });
    return { ok: true };
  },

  // ---------- rivalries: derived from the server's own game archive (see lib/rivalry.js) ----------
  async rivalries(req) {
    const u = await auth(req), now = Date.now(), ln = u.name.toLowerCase();
    const [raw, lb, onlineRaw, live, prefs] = await Promise.all([store.get('games:' + ln), store.get('lb'), store.get('online'), store.get('live'), store.get('rivprefs:' + ln)]);
    const ctx = rivCtx(u, lb, onlineRaw, live, now), arch = (prefs && prefs.arch) || {};
    const list = [];
    for (const [k, games] of Riv.byOpponent(chatList(raw))) {
      const s = { ...rivCard(games, ctx, now), ...Riv.halves(games), recent: Riv.recentOf(games, now) };
      s.archived = !!(arch[k] && arch[k] >= s.last.at);
      list.push(s);
    }
    list.sort((a, b) => b.last.at - a.last.at);
    const insights = Riv.insights(list), ins = (key) => (insights.find((x) => x.key === key) || {}).name;
    const featured = Riv.curate(list, { tough: ins('tough'), most: ins('most') }, now);
    const why = new Map(list.map((x) => [x.name, (Riv.reasonsFor(x, { tough: ins('tough'), most: ins('most') }, now)[0] || {}).text || null]));
    return { me: { name: u.name, ratings: R.summary(u) }, list: list.map(({ firstHalf, lastHalf, ...x }) => ({ ...x, why: why.get(x.name) })), insights, featured };
  },
  async rivalry(req, body) {
    const u = await auth(req), now = Date.now(), ln = u.name.toLowerCase(), k = String(body.name || '').trim().toLowerCase();
    if (!NAME_RE.test(k)) fail(400, 'No player with that name.');
    const [raw, lb, onlineRaw, live, prefs, seasonsRaw] = await Promise.all([store.get('games:' + ln), store.get('lb'), store.get('online'), store.get('live'), store.get('rivprefs:' + ln), store.get(rivSeasonKey(u.name, k))]);
    const games = Riv.byOpponent(chatList(raw)).get(k);
    if (!games) fail(404, "You haven't finished a game against this player yet.");
    const ctx = rivCtx(u, lb, onlineRaw, live, now), card = rivCard(games, ctx, now), name = card.name;
    card.archived = !!(((prefs && prefs.arch) || {})[k] >= card.last.at);
    const seasons = chatList(seasonsRaw).map((s) => Riv.seasonView(s, games, now)).reverse();
    const moments = Riv.moments(games, name);
    for (const s of seasons) if (s.done && s.games) moments.push({ type: 'season', at: s.end, id: null, accent: true, text: `Season ${s.no}: ${s.winner === 'me' ? 'you won it' : s.winner === 'them' ? `${name} won it` : 'it ended level'} ${Math.max(s.w, s.l)}–${Math.min(s.w, s.l)}${s.d ? `, ${s.d} drawn` : ''}` });
    moments.sort((a, b) => a.at - b.at);
    return {
      me: { name: u.name, ratings: R.summary(u) }, rival: card, stats: Riv.stats(games), moments,
      seasons, season: seasons.find((s) => !s.done) || null, seasonDays: Riv.SEASON_DAYS,
      // newest first; light rows (the replay loads the full game)
      encounters: games.slice().reverse().map((g) => ({ id: g.id || null, at: g.at, result: g.result, reason: g.reason || null, tc: 'tc' in g ? g.tc : undefined,   // undefined: an old row that never recorded it cat: g.cat || null, color: g.color,
        delta: g.delta != null ? g.delta : null, before: g.before != null ? g.before : null, opp: g.oppRating != null ? g.oppRating : null, op: g.op || null, eco: g.eco || null, moves: g.moves || null, dur: g.dur || null, rated: !!g.rated })),
    };
  },
  // around the community: interesting pairs on this server (from the same public game archive), cached for a minute
  async rivalry_community(req, body) {
    const u = await authFast(req), now = Date.now(), srv = store.server();
    // your own matchups are under "Your rivalries": the community view is everyone else's
    const forMe = (ranked) => {
      if (body && body.all) return { featured: ranked[0] || null, picks: ranked.slice(1, 3) };   // the main page: the server's top matchups, the same for everyone
      const mine = (p) => [p.a, p.b].some((n) => n.toLowerCase() === u.name.toLowerCase()), list = ranked.filter((p) => !mine(p));
      return { featured: list[0] || null, picks: list.slice(1, 7) };
    };
    const c = communityCache.get(srv);
    if (c && now - c.at < 60e3) return forMe(c.ranked);
    const [rec, lb] = await Promise.all([pairsGet(), store.get('lb')]);
    const people = new Map(Object.entries(lb || {}).map(([n, x]) => [n.toLowerCase(), { name: n, ratings: x.ratings || R.summary(x) }]));
    const out = Riv.community((rec && rec.map) || {}, (n) => people.has(n.toLowerCase()), now);   // removed accounts are left out
    const dress = (p) => {
      if (!p) return null;
      const pa = people.get(p.a.toLowerCase()), pb = people.get(p.b.toLowerCase()), cat = 'blitz';
      return { ...p, a: pa.name, b: pb.name, ra: pa.ratings[cat] ? { r: pa.ratings[cat].r, prov: !!pa.ratings[cat].prov } : null, rb: pb.ratings[cat] ? { r: pb.ratings[cat].r, prov: !!pb.ratings[cat].prov } : null };
    };
    const ranked = out.map(dress);
    communityCache.set(srv, { v: rec && rec.v, at: now, ranked });
    return forMe(ranked);
  },
  // somebody else's rivalry: the same public archive anyone can open from a profile, read from the first player's side
  async rivalry_public(req, body) {
    const u = await authFast(req), a = String(body.a || '').trim(), b = String(body.b || '').trim(), now = Date.now();
    if (!NAME_RE.test(a) || !NAME_RE.test(b)) fail(400, 'No such rivalry.');
    const [raw, lb, onlineRaw, live] = await Promise.all([store.get('games:' + a.toLowerCase()), store.get('lb'), store.get('online'), store.get('live')]);
    const people = new Map(Object.entries(lb || {}).map(([n, x]) => [n.toLowerCase(), { name: n, ratings: x.ratings || R.summary(x) }]));
    const pa = people.get(a.toLowerCase()), pb = people.get(b.toLowerCase());
    if (!pa || !pb) fail(404, 'That rivalry is not available.');
    const games = Riv.byOpponent(chatList(raw)).get(b.toLowerCase());
    if (!games) fail(404, 'These two have not finished a game yet.');
    const card = Riv.summary(pb.name, games, now), rate = (p) => (p.ratings[card.cat] ? { r: p.ratings[card.cat].r, prov: !!p.ratings[card.cat].prov } : null);
    const on = new Set(onlineList(onlineRaw, null, (live || []).filter((g) => now - g.ts < LIVE_TTL), u.name, now).filter((p) => p.st !== 'offline').map((p) => p.name.toLowerCase()));
    return {
      a: { name: pa.name, rating: rate(pa), online: on.has(pa.name.toLowerCase()) }, b: { name: pb.name, rating: rate(pb), online: on.has(pb.name.toLowerCase()) },
      rival: card, stats: Riv.stats(games), moments: Riv.moments(games, pb.name, pa.name),
      encounters: games.slice().reverse().slice(0, 200).map((g) => ({ id: g.id || null, at: g.at, result: g.result, reason: g.reason || null, tc: 'tc' in g ? g.tc : undefined, cat: g.cat || null, color: g.color, op: g.op || null, moves: g.moves || null })),
    };
  },
  // ---------- The Damage Report ----------
  async damage_feed(req) {
    const u = await auth(req), now = Date.now();
    if (await store.get('dmgoff')) return { hide: false, off: true };           // an admin turned the Damage Report off for this server
    if (u.hideDamage) return { hide: true, optOut: !!u.dmgOptOut };
    damageLater(damageSweep());                                                // unfinished games, a few at a time
    const [list, opt, lb, bf] = await Promise.all([store.get(DMG.feed), dmgOptOut(), store.get('lb'), store.get(DMG.backfill)]);
    if (!bf) damageLater(damageBackfill());
    const rows = chatList(list).filter((r) => dmgShown(r, opt, lb || {}));
    const pick = damagePick(rows, now);
    const q = chatList(await store.get(DMG.queue));
    return { hide: false, optOut: !!u.dmgOptOut, ...pick, pending: q.length, share: store.server() };
  },
  // hide the section (saved to the account, so it follows the player to every device) and opt out of being featured
  async damage_prefs(req, body) {
    const u = await auth(req);
    if (body.hide != null) u.hideDamage = !!body.hide;
    if (body.optOut != null) {
      u.dmgOptOut = !!body.optOut;
      let saved = false;
      for (let i = 0; i < 12 && !saved; i++) {
        const o = await store.get(DMG.opt), map = { ...((o && o.map) || {}) };
        if (u.dmgOptOut) map[u.name.toLowerCase()] = 1; else delete map[u.name.toLowerCase()];
        saved = o ? await store.cas(DMG.opt, { v: o.v + 1, map }, o.v) : await store.create(DMG.opt, { v: 1, map });
      }
      if (!saved) throw new HttpError(503, 'Could not save that. Try again.');
    }
    await saveUser(u);
    return { ok: true, hide: !!u.hideDamage, optOut: !!u.dmgOptOut };
  },
  // the result card after a game: the head-to-head in one glance
  async rivalry_brief(req, body) {
    const u = await auth(req), now = Date.now(), k = String(body.name || '').trim().toLowerCase();
    if (!NAME_RE.test(k)) fail(400, 'No player with that name.');
    const [raw, lb, onlineRaw, live] = await Promise.all([store.get('games:' + u.name.toLowerCase()), store.get('lb'), store.get('online'), store.get('live')]);
    const games = Riv.byOpponent(chatList(raw)).get(k);
    return { rival: games ? rivCard(games, rivCtx(u, lb, onlineRaw, live, now), now) : null };
  },
  async rivalry_archive(req, body) {
    const u = await auth(req), k = String(body.name || '').trim().toLowerCase();
    if (!NAME_RE.test(k)) fail(400, 'No player with that name.');
    const key = 'rivprefs:' + u.name.toLowerCase(), [prefs0, raw] = await Promise.all([store.get(key), store.get('games:' + u.name.toLowerCase())]), prefs = prefs0 || {};
    if (body.on && !Riv.byOpponent(chatList(raw)).get(k)) fail(404, "You haven't played this player.");
    const arch = { ...(prefs.arch || {}) };
    if (body.on) arch[k] = Date.now(); else delete arch[k];
    await store.set(key, { ...prefs, arch });
    return { ok: true };
  },
  // seasons: either player starts one (7, 14 or 30 days); its score is counted from the same archived games
  async rivalry_season(req, body) {
    const u = await auth(req), k = String(body.name || '').trim().toLowerCase(), now = Date.now();
    if (!NAME_RE.test(k)) fail(400, 'No player with that name.');
    const [raw, opp] = await Promise.all([store.get('games:' + u.name.toLowerCase()), peerUser(k)]);
    if (!Riv.byOpponent(chatList(raw)).get(k)) fail(400, 'Play a game against them first.');
    if (!opp) fail(400, 'That player is not available.');
    let err = null;
    if (body.action === 'start') {
      const days = +body.days;
      if (!Riv.SEASON_DAYS.includes(days)) fail(400, 'Pick a season length.');
      await editList(rivSeasonKey(u.name, k), (list) => {
        if (list.some((s) => s.end > now)) { err = 'A season is already running.'; return list; }
        return [...list, { no: list.length + 1, start: now, end: now + days * 86400e3, by: u.name, len: days }].slice(-50);
      });
      if (err) fail(400, err);
      await RT.publish(RT.userTopic(opp), 'ping', { why: 'rivseason', from: u.name, days }).catch(() => {});
    } else if (body.action === 'end') {
      await editList(rivSeasonKey(u.name, k), (list) => {
        if (!list.some((s) => s.end > now)) { err = 'There is no season running.'; return list; }
        return list.map((s) => (s.end > now ? { ...s, end: now, endedBy: u.name } : s));
      });
      if (err) fail(400, err);
    } else fail(400, 'Unknown action.');
    return { ok: true };
  },

  // Stop a head-to-head match between games; whoever leads takes it.
  async match_end(req, body) {
    const u = await auth(req);
    const { room } = await mutateRoom(body.code, (room) => {
      if (!room.match) fail(400, 'This game is not part of a match.');
      if (seatOf(room, u.name) === 's') fail(403, 'Only the players can end the match.');
      if (room.tour) fail(400, "Tournament matches can't be ended early.");
      if (room.match.done) return { noWrite: true };
      const over = outcome(room).over;
      if (!over && room.moves.length) fail(400, 'Finish this game first.');
      Match.stop(room.match, u.name);
      room.rematch = [];
      if (!over && room.arma) {                                            // stopped before a decider began: it becomes a normal game
        room.arma = false;
        if (room.clock) room.clock.b = room.clock.w;
      }
    }, { req });
    await RT.publish('room:' + room.code, 's', { v: room.v });
    return { ok: true };
  },

  // ---------- tournaments ----------
  // who is online right now (names only), for the quiet online/offline notes on pages other than the lobby;
  // asking also keeps you online
  async presence(req) {
    const now = Date.now();
    const [u, raw, live] = await Promise.all([authFast(req), store.get('online'), store.get('live')]);
    { const bg = later(markOnline(u.name, 'lobby', raw)); if (bg) await bg; }
    return { on: onlineList(raw, null, (live || []).filter((g) => now - g.ts < LIVE_TTL), u.name, now).filter((p) => p.st !== 'offline').map((p) => p.name) };
  },
  async tour_list(req) {
    let [u, raw] = await Promise.all([auth(req), store.get('tours')]);
    { const bg = later(markOnline(u.name, 'lobby')); if (bg) await bg; }   // browsing tournaments counts as online
    const due = chatList(raw).filter(tourDue);
    if (due.length) { for (const x of due) await autoStart(x.id).catch((e) => console.error('auto start failed:', e.message)); raw = await store.get('tours'); }
    return { tours: chatList(raw), admin: !!u.admin };
  },
  async tour_get(req, body) {
    let [u, t, chat] = await Promise.all([auth(req), loadTour(body.id), store.get('tchat:' + String(body.id || ''))]);
    { const bg = later(markOnline(u.name, 'lobby')); if (bg) await bg; }
    if (tourDue(t)) { await autoStart(t.id); [t, chat] = await Promise.all([loadTour(t.id), store.get('tchat:' + t.id)]); }
    return { tour: t, admin: !!u.admin, chat: chatList(chat).slice(-60) };
  },
  async tour_create(req, body) {
    const u = await auth(req), now = Date.now();
    if (!u.admin) fail(403, 'Only admins can create tournaments.');
    const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (name.length < 3) fail(400, 'Give the tournament a name (at least 3 letters).');
    // a time-control poll: 2-5 different options (null = no clock)
    let poll = null;
    if (Array.isArray(body.poll)) {
      const seen = new Set();
      poll = body.poll.slice(0, 5).map((x) => cleanTc(x)).filter((x) => { const k = JSON.stringify(x); return !seen.has(k) && seen.add(k); });
      if (poll.length < 2) fail(400, 'Pick at least two time controls for the vote.');
    }
    const t = Tour.create({ id: crypto.randomBytes(5).toString('hex'), name, by: u.name, tc: poll ? null : cleanTc(body.tc), cfg: body.cfg, now, poll });
    if (body.startAt != null && body.startAt !== '') {
      const at = +body.startAt;
      if (!Number.isSafeInteger(at) || at < now + 60e3 || at > now + 30 * 86400e3) fail(400, 'Pick a start time at least a minute from now and within 30 days.');
      t.startAt = at;
    }
    if (body.join !== false) Tour.join(t, { name: u.name, elo: R.show(R.ratingOf(u, R.category(t.tc))).r });
    t.v = 1;
    if (!(await store.create(tkey(t.id), t))) fail(503, 'Could not create the tournament. Try again.');
    await tourIndex((list) => [tourRow(t), ...list]);
    await tourSay(t.id, [`${u.name} created ${t.name}.${t.startAt ? ' It starts by itself at the scheduled time.' : ''}`]).catch(() => {});
    return { tour: t };
  },
  async tour_join(req, body) {
    const u = await auth(req);
    const { t } = await mutateTour(body.id, (t) => {
      if (t.players.some((x) => x.name === u.name)) return { noWrite: true };
      tx(() => Tour.join(t, { name: u.name, elo: R.show(R.ratingOf(u, R.category(t.tc))).r }));
    });
    return { tour: t };
  },
  // a signed-up player's vote in the time-control poll (changing it is fine until the start)
  async tour_vote(req, body) {
    const u = await auth(req);
    const { t } = await mutateTour(body.id, (t) => {
      const same = t.poll && t.poll.votes[u.name] === +body.i;
      tx(() => Tour.vote(t, u.name, +body.i));                         // throws when voting is closed
      if (same) return { noWrite: true };
    });
    return { tour: t };
  },
  async tour_leave(req, body) {
    const u = await auth(req);
    const { t } = await mutateTour(body.id, (t) => {
      if (!t.players.some((x) => x.name === u.name)) return { noWrite: true };
      tx(() => Tour.leave(t, u.name));
    });
    return { tour: t };
  },
  async tour_start(req, body) {
    const u = await auth(req);
    const { t } = await mutateTour(body.id, async (t) => {
      if (!tourRun(t, u)) fail(403, 'Only the organizer can start it.');
      t.startAt = null;
      await startTour(t);
    });
    return { tour: t };
  },
  // a player's fixture: the room to play it in (made on first use)
  async tour_play(req, body) {
    const u = await auth(req), fxId = String(body.fx || '');
    let t = await loadTour(body.id), f = Tour.find(t, fxId);
    if (!f) fail(404, 'No such match.');
    const player = f.a === u.name || f.b === u.name;
    for (let i = 0; i < 4; i++) {
      if (f.room) {
        if (!player && !f.res) { try { return { code: (await loadRoom(f.room)).code }; } catch (e) { fail(404, 'That match has not started yet.'); } }
        const room = await tourRoom(t, f);
        if (room) {
          if (player && !f.res) await tourWaiting(t, f, u.name, room.code, false).catch((e) => console.error('tournament wait failed:', e.message));
          return { code: room.code };
        }
      } else {
        if (!player) fail(403, 'This is not your match.');
        if (!Tour.ready(f)) fail(400, f.res ? 'That match is already decided.' : 'That match is not ready yet.');
      }
      // reserve a (new) code for the fixture: none yet, or the reserved one turned out to belong to another game
      const old = f.room, code = newRoomCode();
      ({ t } = await mutateTour(t.id, (t) => { const g = Tour.find(t, fxId); if (g.room !== old || !Tour.ready(g)) return { noWrite: true }; g.room = code; }));
      f = Tour.find(t, fxId);
      if (!f.room) fail(400, 'That match is not ready yet.');
    }
    fail(503, 'Could not open the match. Try again.');
  },
  // nudge the opponent again from the waiting room
  async tour_remind(req, body) {
    const u = await auth(req), t = await loadTour(body.id), f = Tour.find(t, String(body.fx || ''));
    if (!f || (f.a !== u.name && f.b !== u.name)) fail(403, 'This is not your match.');
    if (!Tour.ready(f) || !f.room) fail(400, 'There is nothing to remind them about.');
    await tourWaiting(t, f, u.name, f.room, true);
    return { ok: true };
  },
  // the organizer settles a fixture by hand (a no-show, a dispute)
  // the organizer changes the match length (before the start, or for the games that haven't started yet)
  async tour_length(req, body) {
    const u = await auth(req);
    const { t } = await mutateTour(body.id, (t) => {
      if (!tourRun(t, u)) fail(403, 'Only the organizer can change this.');
      const gn = body.gn == null ? t.cfg.gn : +body.gn, kn = body.kn == null ? t.cfg.kn : +body.kn;
      if (gn === t.cfg.gn && kn === t.cfg.kn) return { noWrite: true };
      tx(() => Tour.setLength(t, gn, kn));
    });
    return { tour: t };
  },
  async tour_award(req, body) {
    const u = await auth(req), res = body.res;
    if (!['a', 'b', 'draw'].includes(res)) fail(400, 'Pick a result.');
    const { t } = await mutateTour(body.id, (t) => {
      if (!tourRun(t, u)) fail(403, 'Only the organizer can set results.');
      if (!tx(() => Tour.record(t, String(body.fx || ''), res, null, 'awarded', Date.now()))) fail(400, 'That match is already decided.');
    });
    const f = Tour.find(t, String(body.fx || ''));
    if (f && f.room) {                                                  // settled by hand: the room's match no longer counts
      try {
        const { room } = await mutateRoom(f.room, (r) => {
          if (!r.tour || r.tour.fx !== f.id || r.tourDone) return { noWrite: true };
          if (r.match && !r.match.done) Match.stop(r.match, null);
          r.tourDone = true; r.rematch = [];
        }, { live: false });
        await RT.publish('room:' + room.code, 's', { v: room.v });
      } catch (e) { if (!(e instanceof HttpError)) throw e; }
    }
    return { tour: t };
  },
  // my mentions that haven't been shown yet (the push is best-effort; the page also asks now and then)
  async mentions(req) {
    const u = await auth(req), now = Date.now();
    return { mentions: chatList(await store.get(mentionsKey(u.name))).filter((x) => !x.seen && now - x.ts < MENTION_TTL * 1000) };
  },
  async mention_seen(req, body) {
    const u = await auth(req), ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 50));
    if (!ids.size) return { ok: true };
    await editList(mentionsKey(u.name), (list) => (list.some((x) => ids.has(x.id) && !x.seen) ? list.map((x) => (ids.has(x.id) ? { ...x, seen: 1 } : x)) : list), MENTION_TTL);
    return { ok: true };
  },
  async tour_chat_send(req, body) {
    const u = await auth(req), t = await loadTour(body.id);
    if (u.muted) fail(403, 'You are muted.');
    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) fail(400, 'Type a message first.');
    chatThrottle('t:' + u.name.toLowerCase());
    const msg = { id: crypto.randomUUID().slice(0, 8), n: u.name, t: text, ts: Date.now(), ...(t.players.some((p) => p.name === u.name) ? { p: 1 } : {}), ...(u.admin ? { a: 1 } : {}) };
    await editList('tchat:' + t.id, (list, k) => { msg.k = k; return [...list, msg].slice(-TCHAT_MAX); });
    await mentionLater(u, text, { kind: 'tour', tid: t.id, title: t.name });
    return { ok: true, msg };
  },
  async tour_delete(req, body) {
    const u = await auth(req), t = await loadTour(body.id);
    if (!tourRun(t, u)) fail(403, 'Only the organizer can delete it.');
    if (!u.admin && t.phase !== 'signup' && t.phase !== 'done') fail(400, 'A tournament in progress can only be deleted by an admin.');
    await Promise.all([store.del(tkey(t.id)), store.del('tchat:' + t.id)]);
    await tourIndex((list) => list.filter((x) => x.id !== t.id));
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
    await mentionLater(u, text, { kind: 'lobby' });
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
    const names = Object.keys(lb || {});
    const [accts, fair] = await Promise.all([Promise.all(names.map((n) => getUser(n))), fairSummaries(names)]);
    const users = accts.filter(Boolean).map((x) => ({
      name: x.name, email: x.email || '', elo: R.show(R.ratingOf(x, 'blitz')).r, ratings: R.summary(x), w: x.w || 0, l: x.l || 0, d: x.d || 0, muted: !!x.muted, banUntil: x.banUntil && x.banUntil > Date.now() ? x.banUntil : 0, admin: !!x.admin, created: x.created || 0,
      fair: fair[x.name.toLowerCase()],
    })).sort((a2, b2) => b2.created - a2.created);
    const games = (live || []).filter((g) => now - g.ts < LIVE_TTL);
    return { users, live: games, announce: ann ? ann.text : '', stats: { users: users.length, live: games.length, chat: chatList(chat).length } };
  },

  // Fair play, from the player's browser: something on the page looks like an engine helper (an extension drawing on
  // the board, or its traces in the page). Kept for admins to see; it changes nothing in the game.
  async fair_report(req, body) {
    const u = await authFast(req);
    const what = String(body.what || '').replace(/\s+/g, ' ').trim().slice(0, 160), game = String(body.code || '').slice(0, 20);
    if (!what) fail(400, 'Nothing to report.');
    await editList(fairExtKey(u.name), (list) => (list.some((x) => x.game === game && x.what === what) ? list : [{ ts: Date.now(), game, what }, ...list].slice(0, FAIR_EXT_MAX)));
    return { ok: true };
  },
  // Fair play, for admins: a player's extension reports and how engine-like their recent games are. With scan, also
  // checks games not looked at yet, as many as fit in this request; the admin panel calls again while more remain.
  async admin_fair(req, body) {
    await needAdmin(req);
    const t = await getUser(String(body.name || ''));
    if (!t) fail(404, 'No such player.');
    const lname = t.name.toLowerCase();
    const [rows, scans, ext] = await Promise.all([fairGames(lname), store.get(fairScanKey(lname)), store.get(fairExtKey(lname))]);
    const done = (scans && scans.games) || {};
    let todo = rows.filter((x) => !(x.id in done));
    if (body.scan && todo.length) {
      const t0 = Date.now();
      const recs = await store.getMany(todo.map((x) => 'game:' + x.id));
      let i = 0;
      for (; i < todo.length && Date.now() - t0 < FAIR_BUDGET_MS; i++) {
        const g = recs[i];
        done[todo[i].id] = g && Array.isArray(g.hist) ? Fair.scanGame(g.hist, todo[i].color, g.mt) : null;
      }
      todo = todo.slice(i);
      const kept = {};
      for (const x of rows) if (x.id in done) kept[x.id] = done[x.id];   // only the games still in their recent list
      await store.set(fairScanKey(lname), { at: Date.now(), games: kept, verdict: Fair.verdict(Object.values(kept)) });
    }
    const games = rows.filter((x) => x.id in done).map((x) => ({ id: x.id, at: x.at, color: x.color, opp: x.opp, result: x.result, scan: done[x.id] }));
    const [hist, last, conf] = await Promise.all([FairAn.history(t.name), store.get('fairlast:' + lname), store.get('fconf:' + lname)]);
    return { name: t.name, ext: chatList(ext), games, verdict: Fair.verdict(games.map((g) => g.scan)), pending: todo.length, det: { ...detSummary(hist, chatList(conf)), history: hist.slice(-30), last: last || null } };
  },

  // lift a fair-play ban now (any ban, from any source); the player can play again straight away
  async admin_unban(req, body) {
    const a = await needAdmin(req);
    const t = await getUser(String(body.name || ''));
    if (!t) fail(404, 'No such player.');
    const was = t.banUntil || 0;
    delete t.banUntil;
    await saveUser(t); authCache.delete(t.name.toLowerCase());
    await store.del('fconf:' + t.name.toLowerCase());                          // no longer a confirmed violation
    const ids = chatList(await store.get(FCASES)).filter((x) => x.name.toLowerCase() === t.name.toLowerCase()).slice(0, 5);
    for (const x of ids) { try { await fcaseMutate(x.id, (c) => { if (c.status === 'closed' || c.status === 'decided' || c.status === 'appeal') fairLog(c, a.name, 'unbanned', 'ban lifted by an admin'); else return false; }); } catch (e) { /* the case may be gone */ } }
    return { ok: true, wasBanned: was > Date.now() };
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
    await store.inServer(srvOf(t), () => bumpLeaderboard(t));
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
    return store.inServer(srvOf(t), () => deleteUser(t));
  },

  // ---------- servers (admin) ----------
  async admin_servers(req) {
    const me = await needAdmin(req);
    const servers = await getServers();
    const lbs = await Promise.all(servers.list.map((x) => store.inServer(x.id, () => store.get('lb'))));
    const offs = await Promise.all(servers.list.map((x) => store.inServer(x.id, () => store.get('dmgoff'))));
    return { current: srvOf(me), servers: servers.list.map((x, i) => ({ ...x, players: Object.keys(lbs[i] || {}).length, dmgOff: !!offs[i] })) };
  },
  // the Damage Report on or off for one server (no new cards, and the section is hidden there)
  async admin_dmg_server(req, body) {
    await needAdmin(req);
    const servers = await getServers();
    if (!servers.list.some((x) => x.id === String(body.id))) fail(404, 'No such server.');
    await store.inServer(String(body.id), () => (body.off ? store.set('dmgoff', { at: Date.now() }) : store.del('dmgoff')));
    return { ok: true };
  },
  async admin_server_new(req, body) {
    await needAdmin(req);
    const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!name) fail(400, 'Give the server a name.');
    for (let i = 0; i < 5; i++) {
      const servers = await getServers(), id = String(servers.next || servers.list.length + 1);
      const next = { v: (servers.v || 0) + 1, next: +id + 1, list: [...servers.list, { id, name, code: newServerCode() }] };
      if (await saveServers(servers, next)) return { ok: true, id };
    }
    fail(409, 'Busy. Try again.');
  },
  // body: { id, name? , code: 'new' | 'off' }
  async admin_server_edit(req, body) {
    await needAdmin(req);
    for (let i = 0; i < 5; i++) {
      const servers = await getServers();
      const list = servers.list.map((x) => ({ ...x })), s = list.find((x) => x.id === String(body.id));
      if (!s) fail(404, 'No such server.');
      if (body.name != null) { const n = String(body.name).replace(/\s+/g, ' ').trim().slice(0, 30); if (!n) fail(400, 'Give the server a name.'); s.name = n; }
      if (body.code === 'new') { if (s.id === '1') fail(400, 'Server 1 is closed to new players, so it has no code.'); s.code = newServerCode(); }
      if (body.code === 'off') s.code = null;
      if (await saveServers(servers, { ...servers, v: (servers.v || 0) + 1, list })) return { ok: true };
    }
    fail(409, 'Busy. Try again.');
  },
  // Move a player (or yourself: that is how admins switch servers) to another server.
  async admin_move(req, body) {
    const me = await needAdmin(req);
    const to = String(body.to || ''), servers = await getServers();
    if (!servers.list.some((x) => x.id === to)) fail(404, 'No such server.');
    const t = body.name ? await getUser(String(body.name)) : me;
    if (!t) fail(404, 'No such player.');
    await moveUser(t, to);
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
    await afterEnd(room);
    return { ok: true };
  },

  async admin_clear_chat(req) { await needAdmin(req); await editChat('chat:lobby', () => []); await RT.publish('lobby', 'chatdel', { all: true }); return { ok: true }; },

  async admin_delete_msg(req, body) {
    await needAdmin(req);
    await editChat('chat:lobby', (list) => list.filter((m) => m.id !== body.id));
    await RT.publish('lobby', 'chatdel', { id: String(body.id || '') });
    return { ok: true };
  },

  // ---------- fair-play tribunal ----------
  async fair_cases(req) {
    const u = await authFast(req), now = Date.now();
    const sw = later(fairSweep()); if (sw) await sw;                           // finish any game analysis that was cut short
    const ids = chatList(await store.get(FCASES)).slice(0, 12), raws = ids.length ? await store.getMany(ids.map((x) => fcaseKey(x.id))) : [];
    const out = [];
    for (let c of raws) { if (!c) continue; c = await fairClose(c, now); out.push(fairPublic(c, u.name)); }
    return { ok: true, cases: out.filter((c) => c.status !== 'closed' || now - (c.result ? c.result.at : c.createdAt) < 7 * 86400e3) };
  },
  async fair_vote(req, body) {
    const u = await authFast(req), id = String(body.id || '');
    if (!GAME_ID_RE.test(id)) fail(400, 'No such case.');
    const o = String(body.opt || '');
    const c = await fcaseMutate(id, (x) => {
      const now = Date.now(), k = u.name.toLowerCase();
      if (k === x.name.toLowerCase()) fail(403, 'You cannot vote on your own case.');
      if (x.status === 'poll' && now < x.pollEnds) {
        if (!Trib.OPTIONS.some((y) => y.key === o)) fail(400, 'Pick one of the options.');
        const prev = x.votes[k]; x.votes[k] = { o, ts: now }; fairLog(x, u.name, 'vote', prev && prev.o !== o ? `${prev.o} -> ${o}` : o);
      } else if (x.status === 'appeal' && now < x.appeal.ends) {
        if (!['uphold', 'overturn'].includes(o)) fail(400, 'Uphold or overturn.');
        const prev = x.appeal.votes[k]; x.appeal.votes[k] = { o, ts: now }; fairLog(x, u.name, 'appeal vote', prev && prev.o !== o ? `${prev.o} -> ${o}` : o);
      } else fail(400, 'Voting is closed.');
    });
    return { ok: true, case: fairPublic(c, u.name) };
  },
  async fair_comment(req, body) {
    const u = await auth(req), id = String(body.id || '');
    if (!GAME_ID_RE.test(id)) fail(400, 'No such case.');
    if (u.muted) fail(403, 'You are muted.');
    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!text) fail(400, 'Write something first.');
    chatThrottle('f:' + u.name.toLowerCase());
    const c = await fcaseMutate(id, (x) => {
      if (x.status === 'closed') fail(400, 'This case is closed.');
      x.comments = [...(x.comments || []), { id: crypto.randomUUID().slice(0, 8), name: u.name, text, ts: Date.now(), accused: u.name.toLowerCase() === x.name.toLowerCase() }].slice(-100);
      fairLog(x, u.name, 'comment');
    });
    return { ok: true, case: fairPublic(c, u.name) };
  },
  // the accused player asks the community to look again: a second vote, with its own discussion
  async fair_appeal(req, body) {
    const u = await auth(req), id = String(body.id || '');
    if (!GAME_ID_RE.test(id)) fail(400, 'No such case.');
    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (text.length < 10) fail(400, 'Say why, in at least a sentence.');
    const c = await fcaseMutate(id, (x) => {
      if (x.name.toLowerCase() !== u.name.toLowerCase()) fail(403, 'Only the player can appeal.');
      if (x.status !== 'decided' || x.appeal) fail(400, 'This case cannot be appealed.');
      x.status = 'appeal'; x.appeal = { text, at: Date.now(), ends: Date.now() + Trib.APPEAL_MS, votes: {} };
      fairLog(x, u.name, 'appeal', text);
    });
    return { ok: true, case: fairPublic(c, u.name) };
  },
  // admins: the full record (evidence, votes, log), a decision of their own, or the announcement phrases
  async admin_fair_case(req, body) {
    await needAdmin(req);
    const id = String(body.id || '');
    if (!GAME_ID_RE.test(id)) fail(400, 'No such case.');
    const c = await store.get(fcaseKey(id));
    if (!c) fail(404, 'No such case.');
    return { ok: true, case: c };
  },
  // end the vote now and apply what the community chose (the same rules as when the 48 hours run out: quorum, caps, then the ban)
  async admin_fair_apply(req, body) {
    const a = await needAdmin(req), id = String(body.id || '');
    if (!GAME_ID_RE.test(id)) fail(400, 'No such case.');
    const now = Date.now();
    let c = await fcaseMutate(id, (x) => {
      if (x.status === 'poll') { x.pollEnds = now; fairLog(x, a.name, 'ended the vote early', 'to apply the result'); }
      else if (x.status === 'appeal') { x.appeal.ends = now; fairLog(x, a.name, 'ended the appeal vote early', 'to apply the result'); }
      else return false;
    });
    c = await fairClose(c, now);
    return { ok: true, case: fairPublic(c, a.name) };
  },
  async admin_fair_decide(req, body) {
    const a = await needAdmin(req), id = String(body.id || ''), act = String(body.act || '');
    if (!GAME_ID_RE.test(id)) fail(400, 'No such case.');
    const c = await fcaseMutate(id, async (x) => {
      const t = await getUser(x.name), now = Date.now();
      if (act === 'dismiss') { x.status = 'closed'; x.result = { key: 'dismissed', by: a.name, at: now }; if (t && t.banUntil) { delete t.banUntil; await saveUser(t); authCache.delete(t.name.toLowerCase()); } fairLog(x, a.name, 'dismissed', 'ban lifted if any'); await fairConfirm(x.name, x.id, false); }
      else if (Trib.OPTIONS.some((o) => o.key === act) && t && !t.admin) { const until = Trib.untilOf(act, now); if (until) t.banUntil = until; else delete t.banUntil; await saveUser(t); authCache.delete(t.name.toLowerCase()); x.status = 'closed'; x.result = { key: act, by: a.name, at: now, until }; fairLog(x, a.name, 'decided', act); if (until) await fairConfirm(x.name, x.id, true); }
      else fail(400, 'Unknown action.');
    });
    return { ok: true, case: c };
  },
  // Suspicious detections waiting for an admin: open the community vote, or dismiss. Only admins ever see them.
  async admin_fair_inv(req) {
    await needAdmin(req);
    const ids = chatList(await store.get('finvs')).slice(0, 30), raws = ids.length ? await store.getMany(ids.map((x) => 'finv:' + x.id)) : [];
    return { ok: true, items: raws.filter((x) => x && x.status === 'open') };
  },
  async admin_fair_inv_act(req, body) {
    const a = await needAdmin(req), id = String(body.id || ''), act = String(body.act || '');
    const inv = await store.get('finv:' + id);
    if (!inv) fail(404, 'No such investigation.');
    if (inv.status !== 'open') return { ok: true, already: inv.status };
    if (act === 'vote') {
      const t = await getUser(inv.name);
      if (!t || t.admin) fail(400, "Can't open a vote on them.");
      const g = await store.get('game:' + inv.gid);
      const caseId = await fairOpenManual(a.name, t, g ? inv.gid : null, 'from an investigation', [...inv.evidence, ...inv.corroboration.map((x) => 'Supporting: ' + x)].slice(0, 8));
      await store.set('finv:' + id, { ...inv, status: 'voted', by: a.name, at2: Date.now(), caseId }, 400 * 86400);
      return { ok: true, caseId };
    }
    if (act !== 'dismiss') fail(400, 'Unknown action.');
    await store.set('finv:' + id, { ...inv, status: 'dismissed', by: a.name, at2: Date.now() }, 400 * 86400);
    return { ok: true };
  },
  // an admin flags a player: opens the community poll right away (no forfeit, no automatic confidence)
  async admin_fair_flag(req, body) {
    const a = await needAdmin(req);
    const t = await getUser(String(body.name || ''));
    if (!t) fail(404, 'No such player.');
    if (t.admin) fail(400, "Can't flag an admin.");
    const note = String(body.note || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    let game = String(body.game || '').trim();
    if (game) { const g = GAME_ID_RE.test(game) && (await store.get('game:' + game)); if (!g || ![g.players.w.name, g.players.b.name].some((n) => n.toLowerCase() === t.name.toLowerCase())) fail(400, 'That game is not one of theirs.'); } else game = null;
    const id = await fairOpenManual(a.name, t, game, note);
    return { ok: true, id };
  },
  async admin_fair_phrases(req, body) {
    await needAdmin(req);
    if (Array.isArray(body.phrases)) {
      const list = body.phrases.map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
      for (const p of list) { const bad = Trib.phraseProblem(p); if (bad) fail(400, bad + ' (' + p.slice(0, 40) + ')'); }
      await store.set('fairphrases', list);
    }
    return { ok: true, phrases: (await store.get('fairphrases')) || [], defaults: Trib.DEFAULT_PHRASES };
  },
  // Fair-play exceptions: admin only, never shown to the player or anyone else, never announced
  async admin_fair_exempt(req, body) {
    await needAdmin(req);
    let list = (await store.get('fairexempt')) || [];
    if (body.name) {
      const t = await getUser(String(body.name));
      if (!t) fail(404, 'No such player.');
      const k = t.name.toLowerCase();
      list = list.filter((x) => x !== k);
      if (body.on) list.push(k);
      await store.set('fairexempt', list);
    }
    return { ok: true, exempt: list };
  },
  // The Damage Report: players marked for extra mean commentary
  async admin_dmg_targets(req) { await needAdmin(req); return { ok: true, targets: Object.keys(await dmgTargets()) }; },
  async admin_dmg_target(req, body) {
    await needAdmin(req);
    const t = await getUser(String(body.name || ''));
    if (!t) fail(404, 'No such player.');
    const k = t.name.toLowerCase();
    for (let i = 0; i < 12; i++) {
      const o = await store.get('dmgtarget'), map = { ...((o && o.map) || {}) };
      if (body.on) map[k] = 1; else delete map[k];
      if (o ? await store.cas('dmgtarget', { v: o.v + 1, map }, o.v) : await store.create('dmgtarget', { v: 1, map })) return { ok: true, targets: Object.keys(map) };
    }
    fail(503, 'Try again.');
  },
  async admin_announce(req, body) {
    await needAdmin(req);
    await store.set('announce', { text: String(body.text || '').trim().slice(0, 200), ts: Date.now() });
    return { ok: true };
  },

  async result_send(req, body) { return sendResult(req, body); },
  async clone_played(req, body) { return clonePlayed(req, body); },
  async clone_dismiss(req, body) {
    const u = await auth(req);
    // kept (marked seen) rather than deleted, so a late retry of the same game can't bring it back
    await editList(clonesKey(u.name), (list) => (list.some((x) => x.id === body.id && !x.seen) ? list.map((x) => (x.id === body.id ? { ...x, seen: true } : x)) : list), CLONE_TTL);
    return { ok: true };
  },
  async result_answer(req, body) { return answerResult(req, body); },
  async result_dismiss(req, body) {
    const u = await auth(req);
    await editList(resultsOutKey(u.name), (list) => (list.some((x) => x.id === body.id && x.status !== 'pending') ? list.filter((x) => x.id !== body.id) : list), RESULT_TTL);
    return { ok: true };
  },

  async challenge(req, body) {
    const now = Date.now(), ok = 'outbox:' + hname(req);
    const [u, target, prev] = await Promise.all([auth(req), peerUser(String(body.to || '').trim()), store.get(ok)]);
    if (!target) fail(404, 'No player with that name.');
    if (target.name === u.name) fail(400, "You can't challenge yourself.");
    const live = prev && prev.status === 'pending' && now - prev.ts < CHALLENGE_TTL;
    const same = (x) => JSON.stringify(x || null);
    if (live && prev.to === target.name && same(prev.tc) === same(cleanTc(body.tc)) && same(prev.match) === same(Match.clean(body.match)))
      return { ok: true, id: prev.id };                                    // double-click / retry: already sent
    if (live) { // switching opponent or terms: withdraw the old challenge first
      const pk = 'inbox:' + prev.to.toLowerCase();
      const pin = (await store.get(pk)) || [];
      await store.set(pk, pin.filter((c) => c.id !== prev.id), 3600);
    }
    const ik = 'inbox:' + target.name.toLowerCase();
    const inbox = ((await store.get(ik)) || []).filter((c) => now - c.ts < CHALLENGE_TTL && c.from !== u.name);
    const ctc = cleanTc(body.tc), cat = R.category(ctc), mine = R.show(R.ratingOf(u, cat));
    const ch = { id: crypto.randomUUID().slice(0, 8), from: u.name, fromElo: mine.r, fromProv: mine.prov, fromTopic: RT.userTopic(u), cat, to: target.name, tc: ctc, ts: now, match: Match.clean(body.match) };
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
    const room = await makeRoom({ w: meFirst ? me : them, b: meFirst ? them : me }, ch.tc, now, ch.match);
    const ok = 'outbox:' + ch.from.toLowerCase();
    const theirTopic = ch.fromTopic || (await getUser(ch.from).then((x) => x && RT.userTopic(x)));
    await Promise.all([
      // tell the challenger first, with everything needed to draw the game without another request
      theirTopic ? RT.publish(theirTopic, 'ping', { why: 'accepted', code: room.code, g: { players: room.players, tc: room.tc, cat: room.cat, v: room.v, match: room.match || null } }) : null,
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

async function saveServers(prev, next) {
  return prev.v == null ? store.create('servers', next) : store.cas('servers', next, prev.v);
}

async function deleteUser(t) {
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
}

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

// Every request answers within 9.5s, even if something inside it is stuck, so players get "busy, try again" instead of a hang.
function guarded(req, res) {
  const t = setTimeout(() => {
    if (res.headersSent || res.writableEnded) return;
    console.error('request over 9.5s, answered 503:', req.url);
    try { res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"error":"Server busy. Try again."}'); } catch {}
  }, 9500);
  if (typeof res.on === 'function') { res.on('finish', () => clearTimeout(t)); res.on('close', () => clearTimeout(t)); }
  return Promise.resolve(handler(req, res)).finally(() => clearTimeout(t));
}
module.exports = guarded;
module.exports.archiveTried = archiveTried;                          // for tests
module.exports.damageIdle = async () => { while (dmgInflight.size) await Promise.all([...dmgInflight]); };   // for tests: wait for the Damage Report's background work
module.exports.fairCase = async (id) => store.get(fcaseKey(id));          // for tests
module.exports.fairBackground = (b) => later(fairWork(b));              // api/fairplay.js: start the work, keep the function alive for it
module.exports.fairRun = fairRun;
module.exports.damage = { damageEnqueue, damageRun, damageSweep, damageRelive, DMG, dmgKey, damagePick, sweepReset() { dmgSweepAt.clear(); } };
async function handler(req, res) {
  req[TM] = { marks: [], last: performance.now(), start: performance.now(), wall: performance.timeOrigin + performance.now() };
  const send = (code, obj) => {
    let body = JSON.stringify(obj);
    const t = req[TM];
    const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'Server-Timing': [...t.marks.map(([n, d]) => `${n};dur=${d.toFixed(1)}`), `total;dur=${(performance.now() - t.start).toFixed(1)}`].join(', ') };
    if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { body = zlib.gzipSync(body); h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; }
    if (res.headersSent) return;                                               // already answered "busy" (over 9.5s)
    res.writeHead(code, h);
    res.end(body);
  };
  try {
    if (req.method === 'GET') {                                                  // share images and link pages: public, and checked there
      const u = new URL(req.url, 'http://x'), r = u.searchParams.get('r');
      if (r === 'damage_img' || r === 'damage_page' || u.pathname.startsWith('/d/')) return await damagePublic(req, res, u);
    }
    if (req.method !== 'POST') return send(405, { error: 'POST only.' });
    const route = new URL(req.url, 'http://x').searchParams.get('r');
    if (!Object.prototype.hasOwnProperty.call(routes, route)) return send(404, { error: 'Unknown route.' });
    const body = await readBody(req);
    const srv = req.headers['x-token'] ? await authFast(req).then((u) => srvOf(u), () => '1') : '1';   // signed out: only shared data is touched
    send(200, await store.inServer(srv, () => routes[route](req, body)));
  } catch (e) {
    if (e instanceof HttpError) return send(e.code, { error: e.message });
    console.error(e);
    send(500, { error: 'Server error.' });
  }
};
