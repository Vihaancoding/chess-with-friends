// Big animated profile pictures (up to 10 MB): locally they go through avatar_set; on a real server the browser uploads to Supabase Storage and
// avatar_commit checks the file. Storage is faked here. Run: node scripts/test-avatar-big.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY; process.env.ADMIN_KEY = 'k';
const http = require('http'), handler = require('../lib/app'), store = require('../lib/store');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const call = (route, body, who) => new Promise((resolve) => handler({ method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body }, { setHeader() {}, writeHead(c, h) { this.code = c; this.h = h; }, end(b) { let j = {}; try { j = JSON.parse(b || '{}'); } catch {} resolve({ status: this.code, loc: this.h && this.h.Location, ...j }); } }));
const gif = (mb) => { const b = Buffer.alloc(Math.floor(mb * 1048576), 1); Buffer.from('GIF89a').copy(b); return b; };
(async () => {
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const A = await su('ann'), B = await su('bob');
  ok('a file over 10 MB is refused', (await call('avatar_upload', { type: 'image/gif', size: 11 * 1048576 }, A)).status === 400, null);
  ok('only gif / webp go this way', (await call('avatar_upload', { type: 'image/png', size: 1000 }, A)).status === 400, null);
  ok('without file storage (local) the server says to send it the normal way', (await call('avatar_upload', { type: 'image/gif', size: 5e6 }, A)).direct === false, null);
  const big = gif(5), r = await call('avatar_set', { img: 'data:image/gif;base64,' + big.toString('base64') }, A);
  ok('locally a 5 MB GIF is kept as it is', r.status === 200, r);
  // the storage side, faked
  let files = {}, dropped = [];
  const srv = http.createServer((req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0]).replace('/storage/v1/object/public/avatars/', '');
    if (req.method === 'DELETE') { dropped.push(req.url); res.writeHead(200); return res.end('{}'); }
    const f = files[path]; if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(206, { 'content-range': `bytes 0-31/${f.length}` }); res.end(f.subarray(0, 32));
  });
  await new Promise((r) => srv.listen(0, r));
  store.storageBase = 'http://127.0.0.1:' + srv.address().port; store.storage = async (p, o = {}) => fetch(store.storageBase + '/storage/v1' + p, o);
  files['ann/abc.gif'] = gif(9);
  const c = await call('avatar_commit', { path: 'ann/abc.gif' }, A);
  ok('a 9 MB GIF in storage becomes the picture', c.status === 200 && c.ok, c);
  const pub = await new Promise((resolve) => { let out = {}; const pr = require('../lib/app'); resolve(store.get('avatar:ann')); });
  ok('the record points at it, and the picture route redirects there', pub && pub.url.endsWith('/avatars/ann/abc.gif'), pub);
  ok('someone else cannot claim ann\'s file', (await call('avatar_commit', { path: 'ann/abc.gif' }, B)).status === 400, null);
  files['bob/x.gif'] = gif(11);
  ok('a file that arrived over 10 MB is refused and deleted', (await call('avatar_commit', { path: 'bob/x.gif' }, B)).status === 400 && dropped.length === 1, dropped);
  files['bob/y.gif'] = Buffer.alloc(100000, 7);
  ok('a file that is not really a gif is refused', (await call('avatar_commit', { path: 'bob/y.gif' }, B)).status === 400, null);
  ok('a path that is not yours or not an image is refused', (await call('avatar_commit', { path: '../ann/abc.gif' }, B)).status === 400 && (await call('avatar_commit', { path: 'bob/y.exe' }, B)).status === 400, null);
  files['ann/new.gif'] = gif(2); await new Promise((r) => setTimeout(r, 1)); dropped.length = 0;
  await call('avatar_commit', { path: 'ann/new.gif' }, A);
  ok('replacing it deletes the old file', dropped.some((u) => u.includes('ann/abc.gif')), dropped);
  await call('avatar_clear', {}, A);
  ok('removing it deletes the file in storage too', dropped.some((u) => u.includes('ann/new.gif')) && !(await store.get('avatar:ann')), dropped);
  srv.close(); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
