// The fair-play check lives in its own function: api/fairplay.js. Run: node scripts/test-fairworker.js
//  - locally the check still runs in the same process (node server.js keeps working)
//  - on Vercel (simulated) a move only POSTs to /api/fairplay with the secret and never runs the check itself
//  - api/fairplay.js refuses callers without the secret, answers 202 at once, and then does the check
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
process.env.ADMIN_KEY = 'test-admin-key'; delete process.env.ANTHROPIC_API_KEY; delete process.env.VERCEL; delete process.env.FAIR_SECRET;
const handler = require('../lib/app');
const worker = require('../api/fairplay');
const fx = require('./fixtures/damage-games.json');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function call(route, body, who) {
  return new Promise((resolve) => {
    const req = { method: 'POST', url: '/api?r=' + route, headers: { host: 'chess.test', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body };
    handler(req, { setHeader() {}, writeHead(code) { this.code = code; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } });
  });
}
function callWorker(method, headers, body) {
  return new Promise((resolve) => {
    const res = { statusCode: 0, setHeader() {}, end(b) { resolve({ status: this.statusCode, ...JSON.parse(b) }); } };
    worker({ method, headers, body }, res);
  });
}
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
const LONG = fx[9].ucis;
let scans = 0;
handler.fairDeps = { scan: async (h, color) => { scans++; return color === 'w' ? { n: 22, match: 97, acpl: 3, cv: 0.2 } : null; } };

(async () => {
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = {}; for (const n of ['ann', 'bob']) P[n] = await su(n);
  const start = async () => { const g = await call('create', { color: 'w', tc: { base: 300, inc: 0 } }, P.ann); await call('join', { code: g.code }, P.bob); return g.code; };
  const mv = (code, i) => { const u = LONG[i]; return call('move', { code, from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)) }, P[i % 2 ? 'bob' : 'ann']); };

  console.log('locally: unchanged, the check runs in this process');
  const g1 = await start(); for (let i = 0; i < 42; i++) await mv(g1, i); await sleep(500);
  ok('the engine-like side is forfeited as before', scans > 0 && (await call('room', { code: g1 }, P.bob)).status.reason === 'fair play forfeit', scans);

  console.log('on Vercel: a move only triggers the worker, in the background');
  process.env.VERCEL = '1'; process.env.FAIR_SECRET = 's3cret';
  const posts = []; const realFetch = global.fetch;
  global.fetch = async (url, opts) => { if (String(url).includes('/api/fairplay')) { posts.push({ url: String(url), opts }); return { ok: true, status: 202 }; } return realFetch(url, opts); };
  const before = scans;
  const g2 = await start(); for (let i = 0; i < 26; i++) await mv(g2, i); await sleep(300);
  ok('no check ran inside the move function', scans === before, scans - before);
  ok('moves from ply 24 each POST once to this host with the secret and the game code', posts.length >= 2 && posts.every((p) => p.url === 'https://chess.test/api/fairplay' && p.opts.headers['x-fair-secret'] === 's3cret' && JSON.parse(p.opts.body).code === g2), posts.length);
  ok('only plies 24, 25 and 26 triggered (nothing earlier)', posts.length === 3, posts.length);
  ok('the game is still on and the moves were accepted', !(await call('room', { code: g2 }, P.bob)).status.over, null);
  const n0 = posts.length;
  delete process.env.FAIR_SECRET;
  await mv(g2, 26); await sleep(100);
  ok('without FAIR_SECRET nothing is sent and the game still works', posts.length === n0 && (await call('room', { code: g2 }, P.bob)).hist.length === 27, null);
  global.fetch = realFetch;

  console.log('the worker function');
  process.env.FAIR_SECRET = 's3cret';
  ok('GET is refused', (await callWorker('GET', {}, {})).status === 405, null);
  ok('no secret, no entry', (await callWorker('POST', {}, { code: g2 })).status === 401, null);
  ok('a wrong secret, no entry', (await callWorker('POST', { 'x-fair-secret': 'nope' }, { code: g2 })).status === 401, null);
  ok('a bad game code is refused', (await callWorker('POST', { 'x-fair-secret': 's3cret' }, { code: '../x' })).status === 400, null);
  delete process.env.VERCEL;                                                // run the work in this process for the test (no waitUntil here)
  const s0 = scans;
  const g3 = await start(); for (let i = 0; i < 30; i++) await mv(g3, i); await sleep(300);    // the in-process check above already ran: use the worker for the rest
  const r = await callWorker('POST', { 'x-fair-secret': 's3cret' }, { code: g3, srv: '1' });
  await sleep(500);
  ok('the right secret gets 202 at once', r.status === 202 && r.ok === true, r);
  ok('and the worker ran the check for that game', scans > s0, scans - s0);
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
