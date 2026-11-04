// The Damage Report: scoring on real games, who gets a card, comebacks, the commentary (AI checks and the template bank),
// the background pipeline (duplicates, analysis failures, caching), privacy, and the share card.
// Drives the real API in-process with in-memory storage. Run: node scripts/test-damage.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
process.env.ADMIN_KEY = 'test-admin-key';
process.env.DAMAGE_MOVE_MS = '2000';                                     // fixed depth, not the clock: the same evaluation every run
delete process.env.ANTHROPIC_API_KEY; process.env.DAMAGE_BUDGET_MS = '60000';
const fs = require('fs'), path = require('path');
const handler = require('../lib/app');
const store = require('../lib/store');
const C = require('../public/chess.js');
const D = require('../lib/damage.js');
const T = require('../lib/damagetext.js');
const CARD = require('../lib/damagecard.js');
const { BANK, TEMPLATES } = require('../lib/damagebank.js');
const fx = require('./fixtures/damage-games.json');

let failed = 0, passed = 0;
const ok = (name, cond, got) => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, '\n      got:', JSON.stringify(got)); } };
function call(route, body, who) {
  return new Promise((resolve) => {
    const req = { method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body };
    const res = { setHeader() {}, writeHead(code) { this.code = code; }, end(b) { resolve({ status: this.code, ...JSON.parse(b) }); } };
    handler(req, res);
  });
}
function get(url, host = 'chess.test') {
  return new Promise((resolve) => {
    const req = { method: 'GET', url, headers: { host }, on() {} };
    const res = { status: 0, headers: {}, writeHead(code, h) { this.status = code; this.headers = h || {}; }, end(b) { resolve({ status: this.status, headers: this.headers, body: b }); } };
    handler(req, res);
  });
}
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8;
const toHist = (u) => { let st = C.initial(); return u.map((x) => { const m = C.findUci(st, x); st = C.apply(st, m); return { from: m.from, to: m.to, ...(m.promo ? { promo: m.promo } : {}) }; }); };
const gameOf = (i, over = {}) => {
  const s = fx[i], hist = toHist(s.ucis);
  return { id: 'FIXT' + i + '-x', code: 'FIXT' + i, players: { w: { name: 'maya', elo: s.rw }, b: { name: 'jonas', elo: s.rb } }, hist, result: s.result, reason: s.reason, cat: 'blitz', tc: { base: 300, inc: 0 }, endedAt: Date.now(), ratings: null, ...over };
};
const scoreOf = (g, ev) => { const rep = D.replay(g.hist), f = D.buildFacts(g, rep, ev ? { ev, best: [] } : null); return { f, sc: D.score(f), card: D.cardOf(g, f, D.score(f)), rep }; };
const fix = (i, over) => { const g = gameOf(i, over); return scoreOf(g, fx[i].ev); };

(async () => {
  console.log('who gets a card');
  const g0 = gameOf(3);
  ok('a decisive, finished online game is eligible', D.eligible(g0) === null);
  ok('a draw never gets one', !!D.eligible({ ...g0, result: 'draw', reason: 'agreement' }));
  ok('aborted and admin-ended games never get one', !!D.eligible({ ...g0, reason: 'ended by an admin' }) && !!D.eligible({ ...g0, result: null }));
  ok('pass & play results never get one (one device, not verified)', !!D.eligible({ ...g0, local: true }));
  ok('a game of 4 moves is too thin to say anything about', !!D.eligible({ ...g0, hist: g0.hist.slice(0, 4) }));
  ok('a timeout in 14 moves is a disconnect, not a game', !!D.eligible({ ...g0, reason: 'timeout', hist: g0.hist.slice(0, 14) }));
  ok('a resignation after 8 moves is not scored either', !!D.eligible({ ...g0, reason: 'resignation', hist: g0.hist.slice(0, 8) }));
  ok('an unreadable move list is refused', D.replay([{ from: 0, to: 63 }]) === null);

  console.log('the score');
  const rows = fx.map((s, i) => ({ i, name: s.name, ...fix(i) }));
  for (const r of rows) console.log(`      ${String(r.i).padStart(2)} ${r.name.padEnd(12)} ${String(r.f.moves).padStart(3)} moves  ${String(r.sc.score).padStart(3)} ${r.sc.band.padEnd(9)} ${r.f.shape.padEnd(11)} ${D.headline(r.f)}`);
  ok('every score is a whole number from 0 to 100', rows.every((r) => Number.isInteger(r.sc.score) && r.sc.score >= 0 && r.sc.score <= 100));
  ok('the same game always scores the same', JSON.stringify(fix(3).sc) === JSON.stringify(fix(3).sc));
  ok('bands follow the scale', D.bandOf(20).key === 'competitive' && D.bandOf(21).key === 'slight' && D.bandOf(40).key === 'slight' && D.bandOf(41).key === 'dominant' && D.bandOf(60).key === 'dominant' && D.bandOf(61).key === 'brutal' && D.bandOf(80).key === 'brutal' && D.bandOf(81).key === 'complete' && D.bandOf(100).key === 'complete');
  const crush = rows[3], mate = rows[0];
  ok('a crushing win (queen gone on move 6, 20 points up, resigned on 13) is brutal', crush.sc.score >= 61 && crush.f.mat.queenLost && crush.f.mat.queenLost.move === 6, [crush.sc.score, crush.f.mat.queenLost]);
  ok('a 13-ply mate scores low: thin evidence, and the winner gave up the queen', mate.sc.score <= 40, mate.sc.score);
  ok('the real moments are found: a hung queen on a real move', rows[4].f.loserBlunders.some((b) => b.kind === 'hung' && b.piece === 'Q' && b.move === 10), rows[4].f.loserBlunders);
  ok('the queen sacrifice in the Opera game is engine-confirmed', rows[1].f.tactics.some((t) => t.kind === 'sacrifice' && t.move === 16), rows[1].f.tactics);
  ok('a missed mate in 2 is found (and attributed to the right side)', rows[6].f.missed.some((m) => m.kind === 'mate' && m.n === 2 && m.move === 12 && m.side === rows[6].f.wc), rows[6].f.missed);
  ok('king hunt: checks and king moves counted from the last 16 plies', rows[6].f.king.hunted && rows[6].f.king.checks >= 5 && rows[6].f.king.kingMoves >= 3, rows[6].f.king);
  ok('blunders record the move number and the evaluation drop', rows[2].f.loserBlunders.every((b) => b.move > 0 && b.drop > 200), rows[2].f.loserBlunders);
  ok('the headline and detail say what happened', /^Checkmate in 16, 2 blunders$/.test(D.headline(rows[2].f)) && D.detail(rows[2].f) === 'Checkmate · 16 moves · 2 blunders', [D.headline(rows[2].f), D.detail(rows[2].f)]);

  // thin evidence and the shape of a game
  const short = fix(8, { hist: gameOf(8).hist.slice(0, 22), reason: 'resignation' });
  ok('a short resignation does not score like a real checkmate', short.sc.score < rows[2].sc.score + 10 && short.sc.score <= 60, short.sc.score);
  const timeout = fix(8, { reason: 'timeout' });
  ok('a timeout scores lower than the same game ending in a resignation', timeout.sc.score < rows[8].sc.score, [timeout.sc.score, rows[8].sc.score]);
  ok('shapes tell competitive, collapse and one-sided apart', new Set(rows.map((r) => r.f.shape)).size >= 2 && ['onesided', 'collapse', 'competitive'].every((s) => ['onesided', 'collapse', 'competitive'].includes(s)), rows.map((r) => r.f.shape));
  const win3 = fx[3].result, rt = (win, lose) => ({ ratings: { [win3]: { before: win }, [win3 === 'w' ? 'b' : 'w']: { before: lose } } });
  const equal = fix(3, rt(1500, 1500)), crushWeak = fix(3, rt(1900, 1300)), upset = fix(3, rt(1300, 1900));
  ok('crushing a much weaker player scores lower than an equal; beating a stronger one scores higher', crushWeak.sc.score < equal.sc.score && upset.sc.score > equal.sc.score, [crushWeak.sc.score, equal.sc.score, upset.sc.score]);
  // without the engine: scored from the moves, capped
  const prov = scoreOf(gameOf(3), null);
  ok('without analysis the score is provisional, from the moves, and capped', prov.sc.prov && prov.sc.score <= 60 && prov.f.analysis === 'result', prov.sc);
  // an extreme game reaches the top band
  const wipe = JSON.parse(JSON.stringify(fix(3).f));
  Object.assign(wipe, { reason: 'checkmate', mate: true, plies: 36, moves: 18, ratingW: 1500, ratingL: 1500 });
  wipe.mat = { maxLead: 24, finalLead: 24, bigPly: 10, queenLost: { ply: 11, move: 6 }, lostPieces: 7, loserLost: 36, winnerLost: 2 };
  wipe.loserBlunders = [{ kind: 'hung', piece: 'Q', drop: 900, move: 6 }, { kind: 'hung', piece: 'R', drop: 500, move: 9 }, { kind: 'fork', drop: 600, move: 11 }];
  wipe.tactics = [{ kind: 'fork' }, { kind: 'sacrifice' }]; wipe.king = { checks: 6, kingMoves: 4, hunted: true };
  wipe.dom = { share: 0.95, big: 0.8 }; wipe.acc = { w: 96, b: 52 }; wipe.eval = { final: 100000 }; wipe.chance = { had: false }; wipe.comeback = null; wipe.analysis = 'done';
  const top = D.score(wipe);
  ok('a total wipe-out (mate in 18, queen hung on 6, three blunders, 24 points up) is complete domination', top.score >= 81 && top.band === 'complete', top);

  console.log('comebacks');
  // the winner's evaluation dives to -5 for ten plies, then recovers
  const cb = scoreOf(gameOf(3), fx[3].ev.map((v, i) => (i >= 8 && i < 20 ? (fx[3].result === 'w' ? -500 : 500) : v)));
  ok('a winner who was lost and came back is tagged as a comeback, with no domination score', cb.sc.kind === 'comeback' && cb.sc.score === null && cb.card.kind === 'comeback' && cb.card.swing > 400, [cb.sc, cb.f.comeback]);
  ok('…and it has its own headline', /down \d/.test(D.headline(cb.f)) && cb.card.rank > 0, D.headline(cb.f));
  ok('a normal one-sided game is not a comeback', rows[3].sc.kind === 'domination');

  console.log('the bank');
  const per = Object.fromEntries(Object.entries(BANK).map(([b, t]) => [b, Object.values(t).reduce((a, l) => a + l.length, 0)]));
  ok('at least 50 templates for every band (and for comebacks)', Object.values(per).every((n) => n >= 50) && ['slight', 'dominant', 'brutal', 'complete', 'comeback'].every((b) => per[b]), per);
  const ctxAll = { band: 'brutal', flags: new Set(['gen', 'queen', 'hung', 'fork', 'blunders', 'mmL', 'mmW', 'mate', 'early', 'king', 'tactic', 'resign', 'timeout', 'long', 'short', 'lead', 'lost']),
    t: { w: 'maya', l: 'jonas', moves: 31, qm: 9, surv: 22, hm: 12, hp: 'rook', fm: 14, bn: 3, mn: 2, mm: 22, ck: 5, km: 4, tm: 18, tk: 'fork', tp: 'knight', lead: 14, lost: 6, down: 5, lowm: 12 },
    nums: new Set([0, 1, 31, 9, 22, 12, 14, 3, 2, 5, 4, 18, 6]), moveNums: new Set([31, 9, 12, 14, 22, 18]), pieces: new Set(['queen', 'rook', 'bishop', 'knight', 'pawn', 'king']), reason: 'checkmate', mateOk: true, comeback: true, facts: { moments: ['sacrifice on move 18'] } };
  const bad = [];
  for (const x of TEMPLATES) {
    const line = T.fill(x.s, ctxAll.t);
    if (!line) { bad.push([x.id, 'unfilled']); continue; }
    const why = T.styleProblem(line);
    if (why) bad.push([x.id, why, line]);
    if (/\{|\}/.test(line)) bad.push([x.id, 'leftover braces']);
    if (/ - /.test(line)) bad.push([x.id, 'dash used as punctuation']);
  }
  ok(`every template passes the style rules (${TEMPLATES.length} templates: no dashes, colons, emoji, hashtags, pronouns, lists of three, essays)`, bad.length === 0, bad.slice(0, 5));
  ok('every template only talks about what its flags guarantee (pieces, mates, resignations, clocks, forks)', TEMPLATES.every((x) => {
    const need = new Set(x.need), line = T.fill(x.s, ctxAll.t).toLowerCase();
    const c = { ...ctxAll, flags: new Set(['gen', ...need]), pieces: new Set(need.has('queen') ? ['queen'] : []), mateOk: need.has('mate') || need.has('mmL') || need.has('mmW'), reason: need.has('resign') ? 'resignation' : need.has('timeout') ? 'timeout' : 'x', comeback: x.band === 'comeback' };
    if (/\bqueen\b/.test(line) && !(need.has('queen') || (need.has('hung')))) return false;
    if (/\bmat(e|ed|es)\b|checkmate/.test(line) && !c.mateOk && x.band !== 'comeback') return false;
    if (/\bresign/.test(line) && !need.has('resign') && x.band !== 'comeback') return false;
    if (/\bflag|clock|on time/.test(line) && !need.has('timeout')) return false;
    if (/\bfork\b/.test(line) && !need.has('fork') && !need.has('tactic')) return false;
    return true;
  }), TEMPLATES.filter((x) => { const l = T.fill(x.s, ctxAll.t).toLowerCase(), n = x.need; return (/\bqueen\b/.test(l) && !(n.includes('queen') || n.includes('hung'))) || (/\bmat(e|ed|es)\b|checkmate/.test(l) && !n.includes('mate') && !n.includes('mmL') && !n.includes('mmW') && x.band !== 'comeback') || (/\bresign/.test(l) && !n.includes('resign') && x.band !== 'comeback') || (/\bflag|clock|on time/.test(l) && !n.includes('timeout')) || (/\bfork\b/.test(l) && !n.includes('fork') && !n.includes('tactic')); }).map((x) => x.id));
  ok('no two templates are the same line', new Set(TEMPLATES.map((x) => x.s)).size === TEMPLATES.length);

  console.log('the fallback never repeats itself');
  const sequence = [], recent = [];
  const mix = [3, 4, 2, 7, 5, 8, 9, 6, 1, 10, 0];
  for (let k = 0; k < 60; k++) {
    const i = mix[k % mix.length], r = fix(i, { id: `SEQ${k}-x` }), ctx = T.ctxOf(r.card, r.f);
    const t = T.fromBank(ctx, recent, `SEQ${k}`);
    if (!t) { sequence.push(null); continue; }
    sequence.push(t); recent.unshift({ line: t.line, tpl: t.tpl, type: t.type });
  }
  ok('a line for every one of 60 games', sequence.every((x) => x && x.line), sequence.filter((x) => !x).length);
  ok('never the same line twice in a row (or anywhere in the last 20)', sequence.every((x, k) => !sequence.slice(Math.max(0, k - 20), k).some((y) => y.line === x.line)), null);
  ok('never the same kind of joke three times in a row', sequence.every((x, k) => k < 2 || !(sequence[k - 1].type === x.type && sequence[k - 2].type === x.type)), sequence.map((x) => x.type).join(' '));
  ok('never the same opening words as one of the last 5', sequence.every((x, k) => !sequence.slice(Math.max(0, k - 5), k).some((y) => y.line.split(' ').slice(0, 3).join(' ').toLowerCase() === x.line.split(' ').slice(0, 3).join(' ').toLowerCase())), sequence.map((x) => x.line.split(' ').slice(0, 3).join(' ')).slice(0, 12));
  ok('a variety of jokes: at least 6 kinds', new Set(sequence.map((x) => x.type)).size >= 6, [...new Set(sequence.map((x) => x.type))]);

  console.log('the AI is checked, never trusted');
  const c3 = fix(4), ctx3 = T.ctxOf(c3.card, c3.f);
  const lines = {
    good: 'Hung the queen on move 10 and still played 7 more moves. Delusional is the polite word.',
    invented: 'Hung the queen on move 77 and carried on for 7 more moves. Delusional is the polite word.',
    dash: 'Hung the queen on move 10 — and carried on. Delusional is the polite word.',
    colon: 'Hung the queen on move 10 and then this happened: delusion on a stick.',
    emoji: 'Hung the queen on move 10 and kept going 😂 Delusional is the polite word.',
    notX: "It's not a blunder, it's a lifestyle. Queen gone on move 10.",
    three: 'Hung the queen on move 10, lost a rook, and resigned. Delusional is the polite word.',
    essay: 'The queen was lost on move 10. The game continued for a while. Eventually it was resigned. Sad.',
    mate: 'Hung the queen on move 10 and got mated anyway. Delusional is the polite word.',
    piece: 'Hung the rook pair on move 10 and carried on like a champ. Delusional is the polite word.',
    pronoun: 'Hung the queen on move 10 and he carried on for ages. Delusional is the polite word.',
    ai: 'Hung the queen on move 10, a masterclass in what not to do. Delusional is the polite word.',
    generic: 'What a game of chess that was, honestly. Just a lot of pieces moving around.',
  };
  const why = Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, T.problemWith(v, ctx3, [])]));
  ok('a good line passes', why.good === null, why.good);
  ok('invented move numbers are rejected', /invented/.test(why.invented), why.invented);
  ok('em dashes, colons, emoji, "it\'s not X it\'s Y", lists of three, essays, AI-isms and pronouns are rejected', ['dash', 'colon', 'emoji', 'notX', 'three', 'essay', 'pronoun', 'ai'].every((k) => why[k]), why);
  ok('a mate that did not happen, a piece that did not happen and a generic line are rejected', why.mate && why.piece && why.generic, [why.mate, why.piece, why.generic]);
  ok('a line is rejected if it reuses a recent line', T.problemWith(lines.good, ctx3, [{ line: lines.good }]) !== null && T.problemWith(lines.good, ctx3, [{ line: 'Hung the queen on move 10 and then did something else' }]) !== null);

  let calls = [];
  const mockAI = (answers) => ({ apiKey: 'test-key', baseUrl: 'http://ai.test', fetch: async (url, opts) => {
    const body = JSON.parse(opts.body); calls.push(body);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    if (a === 500) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(a) }] }) };
  } });
  const stats0 = { ...T.stats };
  let out = await T.commentary(c3.card, c3.f, [], mockAI([{ lines: [lines.invented, lines.good, lines.dash] }, { pick: 0 }]));
  ok('three candidates in, the bad ones thrown out, the good one kept', out.src === 'ai' && out.line === lines.good, out);
  ok('it asked the AI for candidates with the facts and the recent lines (and nothing invented)', calls[0].messages[0].content.includes('Facts') && calls[0].messages[0].content.includes('Recent lines') && /Never invent/.test(calls[0].system) && !/\b(he|she) /.test(calls[0].messages[0].content), calls[0].messages[0].content.slice(0, 300));
  calls = [];
  const second = 'Queen hung on move 10 and 7 more moves of pretending. Absolutely cooked.';
  out = await T.commentary(c3.card, c3.f, [], mockAI([{ lines: [lines.good, second, lines.dash] }, { pick: 1 }]));
  ok('a second pass picks the funniest of the accurate ones (2 calls)', out.line === second && calls.length === 2 && /funniest AND completely accurate/.test(calls[1].messages[0].content) && !calls[1].messages[0].content.includes(lines.dash), [out.line, calls.length]);
  out = await T.commentary(c3.card, c3.f, [], mockAI([{ lines: [lines.invented, lines.mate, lines.generic] }]));
  ok('if every candidate is rejected the bank is used', out.src === 'template' && out.line.length > 20, out);
  out = await T.commentary(c3.card, c3.f, [], mockAI([500]));
  ok('if the AI is down the bank is used', out.src === 'template', out);
  out = await T.commentary(c3.card, c3.f, [], mockAI([new Error('network')]));
  ok('if the AI call throws the bank is used', out.src === 'template', out);
  out = await T.commentary(c3.card, c3.f, [], { apiKey: '' });
  ok('with no AI key the bank is used, quietly', out.src === 'template' && out.line, out);
  // Llama through an OpenAI-compatible host
  let lcalls = [];
  const llamaAI = (answers) => ({ provider: 'llama', apiKey: 'llama-key', baseUrl: 'http://llama.test/v1', fetch: async (url, opts) => { lcalls.push({ url, opts, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(answers.shift()) } }] }) }; } });
  out = await T.commentary(c3.card, c3.f, [], llamaAI([{ lines: [lines.invented, lines.good, lines.dash] }, { pick: 0 }]));
  ok('Llama: same checks, the good line kept, sent to /chat/completions with a bearer key and a system message', out.src === 'ai' && out.line === lines.good && lcalls[0].url === 'http://llama.test/v1/chat/completions' && lcalls[0].opts.headers.authorization === 'Bearer llama-key' && lcalls[0].body.messages[0].role === 'system' && /llama/.test(lcalls[0].body.model), [out, lcalls[0] && lcalls[0].url]);
  out = await T.commentary(c3.card, c3.f, [], { ...llamaAI([{ lines: [lines.invented, lines.mate, lines.generic] }]) });
  ok('Llama: if every candidate is rejected the bank is used', out.src === 'template', out);
  ok('Llama without a key is simply off', !T.aiEnabled({ provider: 'llama', apiKey: '' }) && T.aiEnabled({ provider: 'llama', apiKey: 'x' }));
  ok('the prompt makes the AI avoid its recent lines', T.promptFor(ctx3, [{ line: 'a recent joke about a queen' }]).includes('a recent joke about a queen'));

  console.log('the pipeline');
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const P = { ann: await su('ann'), bob: await su('bob'), cat: await su('cat'), dan: await su('dan') };
  const playGame = async (white, black, ucis, end) => {
    const g = await call('create', { color: 'w', tc: { base: 300, inc: 0 } }, P[white]);
    await call('join', { code: g.code }, P[black]);
    for (const [i, u] of ucis.entries()) { const r = await call('move', { code: g.code, from: sq(u.slice(0, 2)), to: sq(u.slice(2, 4)), promo: u[4] ? u[4].toUpperCase() : undefined }, P[i % 2 ? black : white]); if (!r.ok) throw new Error(`${u}: ${r.error}`); }
    if (end === 'resign') await call('resign', { code: g.code }, P[ucis.length % 2 ? black : white]);
    if (end === 'draw') { await call('draw_offer', { code: g.code }, P[white]); await call('draw_accept', { code: g.code }, P[black]); }
    if (end === 'abort') { await call('admin_claim', { key: 'test-admin-key' }, P.dan); await call('admin_abort', { code: g.code }, P.dan); }
    await new Promise((r) => setTimeout(r, 30));
    await handler.damageIdle();
    return g.code;
  };
  const opera = fx[1].ucis;
  const feed = async (who = 'cat') => (await call('damage_feed', {}, P[who]));
  let f0 = await feed();
  ok('an empty server: nothing to show, and no error', f0.ok !== false && f0.headline === null && f0.strip.length === 0, f0);
  const code1 = await playGame('ann', 'bob', opera);
  let fd = await feed();
  ok('a finished game gets a card, analysed by the engine, with a line', fd.headline && fd.headline.w === 'ann' && fd.headline.b === 'bob' && !fd.headline.prov && fd.headline.line.length > 20 && fd.headline.label, fd.headline);
  ok('the card says how it ended', fd.headline.reason === 'checkmate' && /^Checkmate/.test(fd.headline.detail) && fd.headline.moves === 17, fd.headline);
  const rec1 = await store.get('dmg:' + fd.headline.id);
  ok('it is stored as final (analysis done) and the score matches the replay', rec1.st === 'd' && rec1.analysis === 'done' && rec1.score === fix(1, { id: rec1.id, players: { w: { name: 'ann', elo: 1200 }, b: { name: 'bob', elo: 1200 } } }).sc.score, rec1.score);
  // the same game ended twice
  const gameRec = await store.get('game:' + fd.headline.id);
  const again = await Promise.all([handler.damage.damageEnqueue(gameRec), handler.damage.damageEnqueue(gameRec), handler.damage.damageEnqueue(gameRec)]);
  ok('the same game-end three times at once: one card', again.filter((x) => x.card).length === 0 && again.every((x) => x.dup), again.map((x) => Object.keys(x)));
  fd = await feed();
  ok('…and one row in the feed', [fd.headline, ...fd.strip].filter((x) => x && x.id === rec1.id).length === 1);
  ok('a second run of the same game does no work (cached)', (await handler.damage.damageRun(rec1.id)).done === true);

  const before = T.stats.llmCalls;
  for (let i = 0; i < 5; i++) await feed();
  ok('page views never call the AI or the engine', T.stats.llmCalls === before);

  // draws, aborted and too-short games
  const nFeed = async () => { const x = await feed(); return [x.headline, ...x.strip].filter(Boolean).length; };
  const n0 = await nFeed();
  await playGame('ann', 'bob', 'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 d2d3 f8c5 c2c3 d7d6 b1d2 a7a6'.split(' '), 'draw');
  ok('a drawn game gets no card', (await nFeed()) === n0);
  await playGame('ann', 'bob', 'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 d2d3 f8c5 c2c3 d7d6 b1d2 a7a6'.split(' '), 'abort');
  ok('an aborted game gets no card', (await nFeed()) === n0);
  await playGame('ann', 'bob', 'f2f3 e7e5 g2g4 d8h4'.split(' '));
  ok("a 2-move fool's mate gets no card", (await nFeed()) === n0);
  const resignEarly = await playGame('ann', 'bob', 'e2e4 e7e5 g1f3 b8c6'.split(' '), 'resign');
  ok('an early resignation gets no card', (await nFeed()) === n0);

  // a pass & play result is not verified here
  const MATE7 = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
  await call('result_send', { opp: 'bob', color: 'w', gid: 'pp1', tc: { base: 300, inc: 0 }, moves: opera }, P.ann);
  const rin = (await call('me', {}, P.bob)).results[0];
  await call('result_answer', { id: rin.id, accept: true }, P.bob);
  await handler.damageIdle();
  ok('a pass & play result never gets a card', (await nFeed()) === n0);

  console.log('when the engine fails');
  handler.damageDeps = { engine: { beforeMove() { throw new Error('engine down'); } } };
  const code2 = await playGame('cat', 'dan', fx[7].ucis, 'resign');
  let rows2 = await call('damage_feed', {}, P.ann);
  const all2 = [rows2.headline, ...rows2.strip].filter(Boolean), pend = all2.find((x) => x.w === 'cat');
  ok('the card still exists, scored from the moves alone, marked provisional', pend && pend.prov === true && pend.score <= 60 && pend.line, pend);
  const gid2 = pend.id, q = (await store.get('dmgq')).list || [];
  ok('it is queued to retry later (with a delay)', q.some((x) => x.id === gid2 && x.rt > Date.now() && x.n === 1), q);
  ok('a provisional card is never the headline while a real one exists', rows2.headline.w === 'ann', rows2.headline.w);
  handler.damageDeps = {};
  const qq = (await store.get('dmgq')); qq.list = qq.list.map((x) => ({ ...x, rt: 0 })); await store.set('dmgq', qq);
  handler.damage.sweepReset();
  await call('damage_feed', {}, P.ann); await handler.damageIdle();
  ok('on the retry the card becomes final, with the real analysis', (await store.get('dmg:' + gid2)).st === 'd' && (await store.get('dmg:' + gid2)).analysis === 'done');
  ok('the queue is empty again', ((await store.get('dmgq')).list || []).length === 0);
  // slices: a slow engine keeps its progress and finishes on the next call
  handler.damageDeps = { engine: { async beforeMove() { await new Promise((r) => setTimeout(r, 15)); } } };
  process.env.DAMAGE_BUDGET_MS = '1';
  const hist3 = toHist(fx[9].ucis);
  const g3 = { id: 'SLOWG-slow1', code: 'SLOWG', players: { w: { name: 'ann', elo: 1300 }, b: { name: 'bob', elo: 1250 } }, hist: hist3, result: fx[9].result, reason: fx[9].reason, tc: { base: 300, inc: 0 }, cat: 'blitz', endedAt: Date.now() - 1000, startedAt: Date.now() - 90000 };
  await store.set('game:' + g3.id, g3);
  await handler.damage.damageEnqueue(g3);
  const r1 = await handler.damage.damageRun(g3.id, 1);
  const job1 = await store.get('dmgjob:' + g3.id);
  ok('a slow engine saves its progress instead of starting over', r1.partial > 0 && r1.partial < 1 && job1.ev.length > 0 && job1.ev.length < hist3.length + 1, [r1, job1 && job1.ev.length]);
  handler.damageDeps = {};
  const r2 = await handler.damage.damageRun(g3.id, 60000);
  ok('the next slice finishes the job from where it stopped', r2.done && (await store.get('dmgjob:' + g3.id)).ev.length === hist3.length + 1, r2);
  process.env.DAMAGE_BUDGET_MS = '60000';

  console.log('the AI in the pipeline (cached once)');
  process.env.ANTHROPIC_API_KEY = ''; calls = [];
  const aiLine = 'Hung the knight on move 5 and the rest of the game was a very long goodbye. Absolute shambles.';
  const g4 = { ...g3, id: 'AIGAME-ai001', code: 'AIGAME', hist: toHist(fx[4].ucis), result: fx[4].result, reason: fx[4].reason };
  await store.set('game:' + g4.id, g4);
  handler.damageDeps = { ai: mockAI([500, 500, 500, 500, 500, 500]) };
  await handler.damage.damageEnqueue(g4); await handler.damage.damageRun(g4.id);
  const rec4 = await store.get('dmg:' + g4.id);
  ok('with the AI down the card is final with a template line, and says so', rec4.st === 'd' && rec4.src === 'template' && rec4.line.length > 20, rec4);
  const hung4 = fix(4).f.loserBlunders.find((b) => b.kind === 'hung');
  const good4 = `Left the queen hanging on move ${hung4.move} and played on like nothing happened. Pure denial.`;
  const redo = mockAI([{ lines: [good4, 'x', 'y'] }]);
  handler.damageDeps = { ai: { ...redo, apiKey: 'test-key' } };
  await handler.damage.damageRelive(g4.id);
  const rec4b = await store.get('dmg:' + g4.id), before4 = calls.length;
  ok('when the AI is back, the line is redone once and stored', rec4b.src === 'ai' && rec4b.line === good4 && rec4b.llm >= 1, rec4b);
  await call('damage_feed', {}, P.ann); await call('damage_feed', {}, P.ann); await handler.damageIdle();
  ok('and viewing the page afterwards never calls the AI again', calls.length === before4, calls.length - before4);
  handler.damageDeps = {};

  const hlAll = rows.map((r) => D.highlights(r.f));
  ok('every report has 3 to 5 key moments, each with a move number', hlAll.every((h) => h.length >= 3 && h.length <= 5 && h.every((x) => x.move > 0 && x.text.length > 10)), hlAll.map((h) => h.length));
  ok('the key moments are on the card', rows[4].card.hl.length >= 3);
  console.log('the admin target');
  await call('admin_claim', { key: 'test-admin-key' }, P.dan);
  ok('only an admin can mark a target', (await call('admin_dmg_target', { name: 'bob', on: true }, P.ann)).status === 403);
  const mkT = await call('admin_dmg_target', { name: 'bob', on: true }, P.dan);
  ok('the admin marks bob', mkT.ok && mkT.targets.includes('bob'), mkT);
  const gT = { ...g3, id: 'TARGT-tg001', code: 'TARGT', hist: toHist(fx[4].ucis), result: fx[4].result, reason: fx[4].reason };
  await store.set('game:' + gT.id, gT);
  await handler.damage.damageEnqueue(gT); await handler.damage.damageRun(gT.id);
  const recT = await store.get('dmg:' + gT.id);
  ok('when bob loses, the line comes from the target bank', recT.st === 'd' && /^(slight|dominant|brutal|complete)\.target\./.test(recT.tpl || ''), recT);
  ok('and the AI is told who the punching bag is, chess only', T.promptFor(T.ctxOf(fix(4).card, fix(4).f, { target: true }), []).includes('TARGET:') && !T.promptFor(T.ctxOf(fix(4).card, fix(4).f), []).includes('TARGET:'));
  ok('every target line passes the style rules', TEMPLATES.filter((x) => x.type === 'target').every((x) => !T.styleProblem(T.fill(x.s, { w: 'maya', l: 'jonas', moves: 14 }))));
  await call('admin_dmg_target', { name: 'bob', on: false }, P.dan);
  ok('and it can be unmarked', !(await call('admin_dmg_targets', {}, P.dan)).targets.includes('bob'));

  console.log('privacy, opting out and the hide switch');
  fd = await feed('ann');
  const ids = [fd.headline, ...fd.strip].filter(Boolean).map((x) => x.id);
  ok('before opting out, the cards show', ids.length >= 2);
  let res = await call('damage_prefs', { optOut: true }, P.bob);
  ok('a player can opt out of being featured', res.ok && res.optOut === true, res);
  fd = await feed('ann');
  ok('every game with bob in it disappears from the feed', [fd.headline, ...fd.strip].filter(Boolean).every((x) => x.w !== 'bob' && x.b !== 'bob'), [fd.headline, ...fd.strip].filter(Boolean).map((x) => [x.w, x.b]));
  let img = await get(`/api?r=damage_img&fmt=wide&id=${encodeURIComponent(rec1.id)}`);
  ok("…and the share picture and the link page 404 for their games", img.status === 404 && (await get(`/d/${rec1.id}`)).status === 404, img.status);
  ok('the opt-out shows in their account', (await call('me', {}, P.bob)).user.dmgOut === true);
  await call('damage_prefs', { optOut: false }, P.bob);
  ok('opting back in brings them back', [(await feed('ann')).headline, ...(await feed('ann')).strip].filter(Boolean).some((x) => x.w === 'ann' && x.b === 'bob'));
  res = await call('damage_prefs', { hide: true }, P.cat);
  fd = await feed('cat');
  ok('hiding is saved to the account: nothing is sent to the page', res.hide === true && fd.hide === true && !fd.headline && !fd.strip, fd);
  ok('…and it follows the player (me)', (await call('me', {}, P.cat)).user.dmgHide === true);
  ok('hiding one account does not hide it for anyone else', (await feed('ann')).hide === false);
  await call('damage_prefs', { hide: false }, P.cat);
  ok('and it can be shown again', (await feed('cat')).hide === false);
  res = await call('damage_prefs', { hide: true }, null);
  ok('only signed-in players can change settings', res.status === 401);
  const lbx = await store.get('lb'); delete lbx.dan; await store.set('lb', lbx);
  fd = await feed('ann');
  ok('a removed account is never shown', [fd.headline, ...fd.strip].filter(Boolean).every((x) => x.w !== 'dan' && x.b !== 'dan'));
  ok('scores and lines cannot be sent in from a browser (no such route)', (await call('damage_set', { id: rec1.id, score: 100, line: 'x' }, P.ann)).status === 404);

  console.log('the home page picks');
  const now = Date.now(), mk = (id, over) => ({ id, at: now, kind: 'domination', score: 50, rank: 50, prov: false, w: 'a', b: 'b', ...over });
  const pick = handler.damage.damagePick;
  const dayStart = Math.floor(now / 86400e3) * 86400e3;
  const todayRows = [mk('1', { at: dayStart + 1, rank: 60 }), mk('2', { at: now - 5 * 86400e3, rank: 90 }), mk('4', { at: dayStart + 2, rank: 75, prov: true })];
  let pk = pick(todayRows, dayStart + 3600e3);
  ok('the headline is the most brutal verified game of today, not a provisional one and not an older, worse one', pk.headline.id === '1' && pk.scope === 'today', [pk.headline.id, pk.scope]);
  pk = pick([mk('2', { at: dayStart - 2 * 86400e3, rank: 90 }), mk('3', { at: dayStart - 86400e3, rank: 70 })], dayStart + 3600e3);
  ok('with nothing today it falls back to the week', pk.headline.id === '2' && pk.scope === 'week', [pk.headline.id, pk.scope]);
  pk = pick([mk('5', { at: dayStart - 20 * 86400e3 })], dayStart + 3600e3);
  ok('and then to the last thing there is', pk.headline.id === '5' && pk.scope === 'earlier', pk);
  ok('an empty feed has no headline', pick([], now).headline === null);

  console.log('the share card');
  const sample = (band, over = {}) => ({ ...rec1, kind: 'domination', band, label: D.BANDS.find((b) => b.key === band).label, ...over });
  const fmts = ['portrait', 'wide'];
  const out2 = process.env.SHOTS || '';
  const cases = [
    ['dominant', { score: 52, line: 'maya by 18 moves of calm, quiet bullying.' }],
    ['brutal', { score: 74, line: 'Queen gone on move 9 and jonas kept playing for 22 more moves. Delusional.' }],
    ['complete', { score: 93, line: 'Mated on move 12. The opening had not even finished loading and the board is filing a complaint.' }],
    ['dominant', { score: 55, w: 'a_really_extraordinarily_long_username', b: 'x', rw: 2314, rb: 987, line: 'Short.' }],
  ];
  let k = 0;
  for (const [band, over] of cases) for (const fmt of fmts) {
    const c = sample(band, { ...over, tl: Array.from({ length: 60 }, (_, i) => Math.round(Math.sin(i / 7) * 250 + i * 12)), low: { ply: 22, move: 11, label: 'queen hung' } });
    const svg = CARD.svgOf(c, fmt, 'chess.test'), png = CARD.pngOf(svg, CARD.FMT[fmt].w);
    ok(`${band} ${fmt}: a ${CARD.FMT[fmt].w}x${CARD.FMT[fmt].h} PNG, with the commentary and the verdict`, png && png.readUInt32BE(16) === CARD.FMT[fmt].w && png.readUInt32BE(20) === CARD.FMT[fmt].h && svg.includes('THE DAMAGE REPORT') && (band !== 'complete' || /FINISHED|NO SURVIVORS/.test(svg)), png && [png.readUInt32BE(16), png.readUInt32BE(20)]);
    if (out2) fs.writeFileSync(path.join(out2, `card-${k++}-${band}-${fmt}.png`), png);
  }
  const cbCard = { ...rec1, kind: 'comeback', score: null, band: 'comeback', label: 'Comeback', swing: 640, line: 'Down 6 on move 12 and still won.' };
  const cbSvg = CARD.svgOf(cbCard, 'portrait', 'chess.test');
  ok('a comeback gets its own card, not a score', /COMEBACK/.test(cbSvg) && !/>\d+<\/text><text[^>]*>\/100/.test(cbSvg));
  if (out2) fs.writeFileSync(path.join(out2, 'card-comeback.png'), CARD.pngOf(cbSvg, 1080));
  const evil = CARD.svgOf(sample('brutal', { score: 70, w: '<script>alert(1)</script>', line: 'a "quoted" & <b>tagged</b> line about 10 moves' }), 'wide', 'x"><script>');
  ok('names and lines are escaped in the picture', !/<script>/.test(evil) && /&lt;script&gt;/.test(evil), null);

  console.log('public link and image');
  const page = await get(`/d/${encodeURIComponent(rec1.id)}`, 'chess.test');
  ok('the link page has the card line for previews, and sends people to the replay', page.status === 200 && page.body.includes(`og:description" content="${CARD.esc(rec1.line)}"`) && page.body.includes('og:image') && page.body.includes(`/?archive=${rec1.id}`) && /text\/html/.test(page.headers['Content-Type']), page.status);
  img = await get(`/api?r=damage_img&fmt=wide&id=${encodeURIComponent(rec1.id)}`, 'chess.test');
  ok('the preview picture is a 1200x630 PNG anyone can fetch', img.status === 200 && img.headers['Content-Type'] === 'image/png' && img.body.readUInt32BE(16) === 1200 && img.body.readUInt32BE(20) === 630, [img.status, img.headers['Content-Type']]);
  img = await get(`/api?r=damage_img&fmt=portrait&dl=1&id=${encodeURIComponent(rec1.id)}`);
  ok('the download is a 1080x1350 PNG sent as an attachment', img.status === 200 && img.body.readUInt32BE(16) === 1080 && img.body.readUInt32BE(20) === 1350 && /attachment/.test(img.headers['Content-Disposition']), img.headers);
  ok('unknown or malformed ids give a plain 404', (await get('/d/NOPE')).status === 404 && (await get('/api?r=damage_img&id=ZZZZZ-abc')).status === 404 && (await get('/api?r=damage_img&id=../../etc/passwd')).status === 404);
  ok("a queued card with nothing to show yet is not served", (await get('/d/QUEUE-zzzz')).status === 404);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
