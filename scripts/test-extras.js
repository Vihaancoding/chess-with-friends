// Profile pictures, GIF search and the move-stats leaderboard. Run: node scripts/test-extras.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY; process.env.ADMIN_KEY = 'k'; delete process.env.GIPHY_API_KEY;
const handler = require('../lib/app'), Dmg = require('../lib/damage'), store = require('../lib/store');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const call = (route, body, who) => new Promise((resolve) => handler({ method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body }, { setHeader() {}, writeHead(c) { this.code = c; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } }));
const get = (url) => new Promise((resolve) => handler({ method: 'GET', url, headers: {} }, { setHeader() {}, headersSent: false, writeHead(c, h) { this.code = c; this.h = h; }, end(b) { resolve({ status: this.code, h: this.h, body: b }); } }));
(async () => {
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const O = await su('owner'); await call('admin_claim', { key: 'k' }, O);
  const A = await su('ann'), B = await su('bob');

  console.log('profile pictures');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const d = await get('/api?r=avatar&n=ann');
  ok('without a picture there is nothing to show (the page keeps its letter avatar)', d.status === 404, d.status);
  ok('bad pictures are refused', (await call('avatar_set', { img: 'http://evil/x.png' }, A)).status === 400 && (await call('avatar_set', { img: 'data:image/svg+xml;base64,AAAA' }, A)).status === 400 && (await call('avatar_set', { img: 'data:image/png;base64,' + 'A'.repeat(80000) }, A)).status === 400, null);
  const up = await call('avatar_set', { img: png }, A);
  ok('a small picture is accepted and noted on my account', up.ok && (await call('me', {}, A)).user.avAt === up.at, up);
  const g = await get('/api?r=avatar&n=ann');
  ok('and served as the image itself', g.status === 200 && g.h['Content-Type'] === 'image/png' && Buffer.isBuffer(g.body) && g.body.length > 20, g.h);
  ok('people without one get nothing', (await get('/api?r=avatar&n=bob')).status === 404, null);
  ok('only admins can clear someone else\'s', (await call('admin_avatar_clear', { name: 'ann' }, B)).status >= 400 && (await call('admin_avatar_clear', { name: 'ann' }, O)).ok && (await get('/api?r=avatar&n=ann')).status === 404, null);

  console.log('animated pictures');
  const GIFB = Buffer.from('47494638396101000100800000ffffff00000021ff0b4e45545343415045322e30030100000021f9040000000a002c00000000010001000002024401002c000000000100010000020244013b'.replace('3b', ''), 'hex');
  const gif = 'data:image/gif;base64,' + Buffer.concat([GIFB, Buffer.from('3b', 'hex')]).toString('base64');
  await new Promise((r) => setTimeout(r, 800));
  const ag = await call('avatar_set', { img: gif }, A);
  const sg = await get('/api?r=avatar&n=ann');
  ok('an animated GIF is accepted and served unchanged (so it keeps moving)', ag.ok && sg.h['Content-Type'] === 'image/gif' && Buffer.compare(sg.body, Buffer.concat([GIFB, Buffer.from('3b', 'hex')])) === 0, [ag, sg.h]);
  await new Promise((r) => setTimeout(r, 800));
  ok('a file that is not really a GIF is refused', (await call('avatar_set', { img: 'data:image/gif;base64,' + Buffer.from('not a gif at all, just text').toString('base64') }, A)).status === 400, null);
  await new Promise((r) => setTimeout(r, 800));
  const big = 'data:image/gif;base64,' + Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(450 * 1024, 1)]).toString('base64');
  ok('an animation over 400 KB is refused with a clear message', /400 KB/.test((await call('avatar_set', { img: big }, A)).error), null);
  await new Promise((r) => setTimeout(r, 800));
  ok('a PNG pretending to be a GIF is refused', (await call('avatar_set', { img: 'data:image/gif;base64,' + Buffer.from(png.split(',')[1], 'base64').toString('base64') }, A)).status === 400, null);

  console.log('gifs');
  const gs = await call('gif_search', { q: 'cat' }, A);
  ok('without a Giphy key the search says so (people paste links instead)', gs.nokey === true && gs.gifs.length === 0, gs);

  console.log('move stats');
  // a tiny game: 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6?? 4.Qxf7#, with made-up evaluations: black's Nf6 is a blunder
  const hist = [['e2', 'e4'], ['e7', 'e5'], ['d1', 'h5'], ['b8', 'c6'], ['f1', 'c4'], ['g8', 'f6'], ['h5', 'f7']].map(([a, b]) => ({ from: 'abcdefgh'.indexOf(a[0]) + (8 - +a[1]) * 8, to: 'abcdefgh'.indexOf(b[0]) + (8 - +b[1]) * 8 }));
  const rep = Dmg.replay(hist);
  const ev = [20, 30, 25, 30, 25, 30, 9999, 9999].slice(0, rep.n + 1);
  ev[6] = 9999; ev[5] = 40;
  const ms = Dmg.moveStats(rep, ev);
  ok('every counted move lands in exactly one bucket, per side', ['w', 'b'].every((c) => ['brilliant', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder'].reduce((a, k) => a + ms[c][k], 0) === ms[c].n) && ms.w.n + ms.b.n >= 5, ms);
  ok('the move that walks into mate is a blunder, for black', ms.b.blunder === 1, ms.b);

  await store.set('lb', { ann: {}, bob: {} });
  // two analysed games: the totals add up, and the same game is never counted twice
  for (const id of ['GAME1-x', 'GAME2-x', 'GAME1-x']) await handler.statsRecord({ id, players: { w: { name: 'ann' }, b: { name: 'bob' } } }, rep, ev);
  const sb = await call('stats_board', {}, A);
  ok('the board lists players with analysed games and their totals', sb.rows.length === 2 && sb.rows.find((r) => r.name === 'bob').blunder === 2 && sb.rows.find((r) => r.name === 'bob').games === 2, sb.rows);
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
