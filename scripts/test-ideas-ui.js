// Feature requests: anyone can ask for a feature and vote, admins set the status. Run: node scripts/test-ideas-ui.js (needs Playwright)
const { chromium } = require('playwright');
process.env.PORT = String(4230 + Math.floor(Math.random() * 9)); process.env.SUPABASE_URL = ''; process.env.ADMIN_KEY = 'k';
const PORT = process.env.PORT, origLog = console.log; console.log = () => {};
require('../server.js'); console.log = origLog;
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, who) => { const r = await fetch(`http://localhost:${PORT}/api?r=${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-name': who.name, 'x-token': who.token } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, ...(await r.json()) }; };
(async () => {
  await sleep(300);
  const su = async (n) => { const r = await api('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const O = await su('owner'), A = await su('ann'), B = await su('bob');
  await api('admin_claim', { key: 'k' }, O);

  console.log('server');
  ok('an idea needs a real title', (await api('feat_add', { t: 'x' }, A)).status === 400, null);
  const f1 = await api('feat_add', { t: 'Dark mode for the board', d: 'Please!' }, A);
  ok('anyone can post an idea (and starts with their own vote)', f1.ok && (await api('feat_list', {}, A)).feats[0].votes === 1, f1);
  ok('posting again straight away is slowed down', (await api('feat_add', { t: 'Another thing' }, A)).status === 429, null);
  ok('others can vote, and vote again to take it back', (await api('feat_vote', { id: f1.id }, B)).on === true && (await api('feat_list', {}, B)).feats[0].votes === 2 && (await api('feat_vote', { id: f1.id }, B)).on === false, null);
  ok('only admins can set a status', (await api('admin_feat_set', { id: f1.id, st: 'done' }, B)).status >= 400, null);
  ok('only the author or an admin can remove it', (await api('feat_delete', { id: f1.id }, B)).status === 403, null);

  console.log('in the browser');
  const br = await chromium.launch();
  const open = async (u, w = 1280) => { const c = await br.newContext({ viewport: { width: w, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => { failed++; console.log('  ✗ page error:', e.message); }); p.on('dialog', (d) => d.accept()); await p.route(/cdn\.jsdelivr\.net|fonts\.g/, (r) => r.abort()); await c.addInitScript((x) => localStorage.setItem('chess:user', JSON.stringify(x)), u); await p.goto(`http://localhost:${PORT}/`); return p; };
  const pb = await open(B, 390); await pb.waitForSelector('#navIdeas');
  await pb.click('#navIdeas'); await pb.waitForSelector('#ideaForm');
  ok('the Ideas button opens the board with the list', /Dark mode for the board/.test(await pb.textContent('#ideasBody')), null);
  await pb.click('[data-ivote]'); await pb.waitForFunction(() => document.querySelector('[data-ivote]').classList.contains('on'));
  ok('voting from the page lights the button', true);
  await pb.fill('#ideaT', 'Spectator reactions'); await pb.fill('#ideaD', 'emoji while watching'); await pb.click('#ideaForm button[type=submit]');
  await pb.waitForFunction(() => /Spectator reactions/.test(document.querySelector('#ideasBody').textContent));
  ok('sending an idea adds it to the list', true);
  ok('a normal player sees no admin controls', !(await pb.$('[data-ist]')), null);
  ok('the board fits a phone', await pb.evaluate(() => [...document.querySelectorAll('#sheet *')].every((e) => e.getBoundingClientRect().right <= innerWidth + 1)), null);
  if (process.env.SHOT) await pb.screenshot({ path: process.env.SHOT + '-ideas.png' });
  const po = await open(O); await po.waitForSelector('#navIdeas'); await po.click('#navIdeas'); await po.waitForSelector('[data-ist]');
  await po.selectOption('[data-ist]', 'planned'); await po.fill('[data-inote]', 'building this week'); await po.click('[data-isave]');
  await po.waitForFunction(() => /building this week/.test(document.querySelector('#ideasBody').textContent));
  const after = (await api('feat_list', {}, A)).feats.find((f) => f.id === f1.id);
  ok('an admin sets the status and a note, and everyone sees it', after.st === 'planned' && /building this week/.test(after.note), after);
  ok('planned ideas show a badge', /Planned/.test(await po.textContent('#ideasBody')), null);
  await br.close(); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
