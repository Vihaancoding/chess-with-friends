// The puzzle trainer on the real Lichess data (data/puzzles.tsv.gz): retrieval, filters, themes, move checking, progress, the
// AI request parser and adaptive difficulty. Run: node scripts/test-puzzles.js
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY; process.env.ADMIN_KEY = 'k'; delete process.env.ANTHROPIC_API_KEY; delete process.env.LLAMA_API_KEY; delete process.env.PUZZLE_LLM;
const handler = require('../lib/app'), PZ = require('../lib/puzzles'), AI = require('../lib/puzzleai'), Chess = require('../public/chess.js');
let failed = 0, passed = 0;
const ok = (n, c, g) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n, '\n      got:', JSON.stringify(g)); } };
const call = (route, body, who) => new Promise((resolve) => handler({ method: 'POST', url: '/api?r=' + route, headers: who ? { 'x-name': who.name, 'x-token': who.token } : {}, body }, { setHeader() {}, writeHead(c) { this.code = c; }, end(b) { let j = {}; try { j = JSON.parse(b || '{}'); } catch {} resolve({ status: this.code, ...j }); } }));
const nf = (raw) => PZ.normalizeFilter(raw).filter;
(async () => {
  const D = PZ.load();

  console.log('the data: authentic Lichess puzzles, all verified');
  ok('the index holds tens of thousands of puzzles', D.rows.length > 40000, D.rows.length);
  ok('every one has a legal solution line with the Lichess shape (opponent move, then pairs) and consistent mate themes', D.rows.every((r) => !PZ.verifyRow(r)), D.rows.filter((r) => PZ.verifyRow(r)).slice(0, 3).map((r) => r.id));
  const known = D.byId.get('00008');
  ok('original Lichess fields are kept as they are (id, FEN, moves, rating, themes)', !known || (known.fen === 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24' && known.moves === 'f2g3 e6e7 b2b1 b3c1 b1c1 h6c1' && known.rating === 1819 && known.themes.join(' ') === 'crushing hangingPiece long middlegame'), known);
  ok('every theme in the picker is a Lichess theme id that exists in the data', PZ.THEMES.filter((t) => D.counts[t.id]).length >= 55 && Object.keys(D.counts).filter((t) => PZ.KNOWN_THEMES.includes(t)).length >= 55, Object.keys(D.counts).length);
  const bad = PZ.verifyRow({ fen: known ? known.fen : D.rows[0].fen, moves: 'a1a1 h1h1', themes: [] });
  ok('a puzzle whose moves are not legal is rejected', !!bad, bad);
  const r0 = D.rows.find((r) => r.themes.includes('mateIn2'));
  ok('a mate theme that disagrees with the final position is rejected', !!PZ.verifyRow({ ...r0, moves: r0.moves.split(' ').slice(0, 2).join(' '), themes: r0.themes }), null);

  console.log('rating filters');
  for (const [id, b] of Object.entries(PZ.BANDS)) {
    const f = nf({ band: id }), idx = PZ.find(f);
    ok(`${b.label}: ${b.min}–${b.max} only, and there are puzzles in it`, idx.length > 1000 && idx.every((i) => D.rows[i].rating >= b.min && D.rows[i].rating <= b.max), idx.length);
  }
  const rg = PZ.find(nf({ min: 1750, max: 1800 }));
  ok('a custom range is respected at both ends', rg.length > 100 && rg.every((i) => D.rows[i].rating >= 1750 && D.rows[i].rating <= 1800), rg.length);
  ok('a reversed range is put the right way round, and silly numbers are clamped', nf({ min: 2000, max: 1500 }).min === 1500 && nf({ min: -50, max: 99999 }).min === 0 && nf({ min: -50, max: 99999 }).max === 4000, nf({ min: 2000, max: 1500 }));

  console.log('theme combinations');
  const forkAdv = PZ.find(nf({ themes: ['fork', 'discoveredAttack'], band: 'advanced' }));
  ok('Fork + Discovered attack + Advanced: only puzzles that have both themes, in that band', forkAdv.length > 20 && forkAdv.every((i) => D.rows[i].ts.has('fork') && D.rows[i].ts.has('discoveredAttack') && D.rows[i].rating >= 1500 && D.rows[i].rating < 2000), forkAdv.length);
  const any = PZ.find(nf({ themes: ['skewer', 'pin'], match: 'any' })), all = PZ.find(nf({ themes: ['skewer', 'pin'], match: 'all' }));
  ok('"any" is the union and "all" the intersection', any.length > all.length && all.every((i) => D.rows[i].ts.has('skewer') && D.rows[i].ts.has('pin')) && any.every((i) => D.rows[i].ts.has('skewer') || D.rows[i].ts.has('pin')), [any.length, all.length]);
  const knightFork = PZ.find(nf({ themes: ['fork'], firstPiece: 'N' }));
  ok('a first-move piece filter works (knight forks)', knightFork.length > 200 && knightFork.every((i) => D.rows[i].first === 'N' && D.rows[i].ts.has('fork')), knightFork.length);
  const several = PZ.find(nf({ themes: ['mate'], minLen: 3 }));
  ok('"several moves" means three or more of your own moves', several.length > 100 && several.every((i) => D.rows[i].len >= 3), several.length);
  const un = nf({ themes: ['fork', 'notATheme', '__proto__', 'pin'] });
  ok('an unsupported theme id is dropped and reported, never used', un.themes.join() === 'fork,pin' && PZ.normalizeFilter({ themes: ['notATheme'] }).dropped[0] === 'notATheme', un);
  const cached = PZ.find(nf({ themes: ['fork'], band: 'expert' })), again = PZ.find(nf({ band: 'expert', themes: ['fork'] }));
  ok('the same query is answered from the cache', cached === again, null);

  console.log('reading a request in words (the built-in parser; no AI key set)');
  const ask = async (t, deps) => AI.interpret(t, { noCache: true, ...(deps || {}) });
  let a = await ask('Give me difficult knight fork puzzles.');
  ok('"difficult knight fork puzzles": Fork, first move by a knight, rated 1900+', a.filter.themes.join() === 'fork' && a.filter.firstPiece === 'N' && a.filter.min >= 1900 && a.src === 'builtin', a.filter);
  ok('it says what it understood, and that "knight" is about the first move', /Fork/.test(a.understood.join(' ')) && a.limits.some((x) => /first move/.test(x)), a);
  a = await ask('I want to practise rook sacrifices.');
  ok('"rook sacrifices": Sacrifice with a rook making the first move', a.filter.themes.join() === 'sacrifice' && a.filter.firstPiece === 'R', a.filter);
  a = await ask('Find puzzles involving zwischenzugs.');
  ok('"zwischenzugs": the Lichess theme intermezzo', a.filter.themes.join() === 'intermezzo', a.filter);
  a = await ask('Give me checkmate puzzles that require calculating several moves.');
  ok('checkmate that needs calculating: Checkmate, 3+ moves', a.filter.themes.join() === 'mate' && a.filter.minLen === 3, a.filter);
  a = await ask('I want to practise defensive tactics.');
  ok('"defensive tactics": Defensive move', a.filter.themes.join() === 'defensiveMove', a.filter);
  a = await ask('Show me difficult endgame puzzles.');
  ok('"difficult endgame puzzles": Endgame, 1900+', a.filter.themes.join() === 'endgame' && a.filter.min >= 1900, a.filter);
  a = await ask('Give me puzzles where I have to sacrifice material to win.');
  ok('"sacrifice material to win": Sacrifice', a.filter.themes.join() === 'sacrifice', a.filter);
  a = await ask('easy back rank mates under 1200');
  ok('a rating cap in words ("under 1200") and a back rank mate', a.filter.themes.includes('backRankMate') && a.filter.max === 1200, a.filter);
  a = await ask('mate in three, around 1600');
  ok('"mate in three" and "around 1600"', a.filter.themes.join() === 'mateIn3' && a.filter.min === 1450 && a.filter.max === 1750, a.filter);
  a = await ask('rook endgames and pawn endgames');
  ok('specific endgames do not also add the general Endgame theme', a.filter.themes.sort().join() === 'pawnEndgame,rookEndgame', a.filter);
  a = await ask('puzzles about pawn structure and prophylaxis');
  ok('something no Lichess theme can express is explained, not silently replaced', a.empty && a.limits.some((x) => /positional/.test(x)), a);
  a = await ask('Sicilian Najdorf tactics');
  ok('a named opening is reported as a limitation', a.limits.some((x) => /named opening/.test(x)), a.limits);
  a = await ask('asdf qwerty');
  ok('gibberish gives an empty result with a helpful message', a.empty && a.limits.length > 0, a);

  console.log('the AI path: its JSON is validated before anything is used');
  const fake = (obj) => ({ apiKey: 'test', provider: 'claude', baseUrl: 'http://x', fetch: async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify(obj) }] }) }) });
  a = await ask('anything', fake({ themes: ['fork', 'madeUpTheme', 'pin'], match: 'any', band: 'expert', min: 2100, max: 99999, firstPiece: 'N', minLen: 2, unsupported: ['named opening'] }));
  ok('themes the AI invents are dropped and reported; valid ones kept', a.src === 'ai' && a.filter.themes.join() === 'fork,pin' && a.limits.some((x) => /madeUpTheme/.test(x)) && a.limits.some((x) => /named opening/.test(x)), a);
  ok('numbers are clamped and the filter is the validated one', a.filter.match === 'any' && a.filter.min === 2100 && a.filter.max === 4000 && a.filter.minLen === 2 && a.filter.firstPiece === 'N', a.filter);
  a = await ask('anything', fake({ themes: ['totallyMadeUp'], unsupported: [] }));
  ok('an AI answer with nothing valid falls back to the built-in parser', a.src === 'builtin', a);
  a = await ask('fork puzzles', { apiKey: 'test', provider: 'claude', baseUrl: 'http://x', fetch: async () => { throw new Error('down'); } });
  ok('if the AI is down the built-in parser answers', a.src === 'builtin' && a.filter.themes.join() === 'fork', a);
  let sent = null; await ask('pin puzzles', { apiKey: 'test', provider: 'claude', baseUrl: 'http://x', fetch: async (u, o) => { sent = JSON.parse(o.body); return { ok: true, json: async () => ({ content: [{ text: '{}' }] }) }; } });
  ok('the AI is shown the theme list and the request, never any puzzle data', /fork = Fork/.test(sent.system) && sent.messages[0].content === 'pin puzzles' && !/ 0 24|moves/.test(JSON.stringify(sent.messages)), null);

  console.log('playing: move checking, multi-move puzzles, retry');
  const su = async (n) => { const r = await call('signup', { email: n + '@x.io', password: 'password1', username: n }); return { name: r.name, token: r.token }; };
  const U = await su('ann');
  const next = (filter, extra) => call('puzzle_next', { mode: 'custom', filter, ...(extra || {}) }, U);
  let n = await next({ themes: ['mateIn3'], band: 'intermediate' });
  const row = D.byId.get(n.puzzle.id);
  ok('puzzle_next gives a verified Lichess puzzle without its solution', n.puzzle && row && !PZ.verifyRow(row) && n.puzzle.steps === 3 && n.puzzle.side === (Chess.fromFEN(row.fen).turn === 'w' ? 'b' : 'w'), n.puzzle);
  const body = JSON.stringify(n);
  ok('nothing in the response contains the solution moves', row.mv.slice(1).every((m) => !body.includes(m)) && !/"solution"|"moves"|"rating"/.test(body) && !('themes' in n.puzzle), body.slice(0, 200));
  ok('the solver plays the side that was not on move in the FEN (the opponent moves first)', n.puzzle.setup === row.mv[0], n.puzzle.setup);
  ok('the review is refused until the puzzle is finished', (await call('puzzle_review', { id: row.id }, U)).status === 403 && (await call('puzzle_explain', { id: row.id }, U)).status === 403, null);
  ok('an illegal move is an error, not a wrong answer', (await call('puzzle_move', { id: row.id, step: 1, move: 'a1a1' }, U)).status === 400, null);
  const wrong = (() => { const st = PZ.stateAfter(row, 1); return Chess.legalMoves(st).map((m) => Chess.sqName(m.from) + Chess.sqName(m.to) + (m.promo ? m.promo.toLowerCase() : '')).find((u) => u !== row.mv[1] && Chess.status(Chess.apply(st, Chess.findUci(st, u))).reason !== 'checkmate'); })();
  let m = await call('puzzle_move', { id: row.id, step: 1, move: wrong }, U);
  ok('a wrong move is reported as wrong, once counted as a failed puzzle', m.correct === false && m.counted === true && m.delta < 0, m);
  m = await call('puzzle_move', { id: row.id, step: 1, move: wrong }, U);
  ok('a second wrong move on the same puzzle is not counted again', m.correct === false && m.counted === false, m);
  m = await call('puzzle_move', { id: row.id, step: 1, move: row.mv[1] }, U);
  ok('after a wrong move the right one is still accepted (a retry cannot corrupt anything)', m.correct === true && !m.done && m.reply === row.mv[2] && m.next === 3, m);
  m = await call('puzzle_move', { id: row.id, step: 3, move: row.mv[3] }, U);
  ok('the second correct move gets the opponent\'s reply and the puzzle is still open', m.correct === true && !m.done && m.reply === row.mv[4] && m.next === 5, m);
  ok('a move for a step the player has not reached is refused', (await call('puzzle_move', { id: row.id, step: 2, move: row.mv[2] }, U)).status === 400, null);
  m = await call('puzzle_move', { id: row.id, step: 5, move: row.mv[5] }, U);
  ok('only the last move completes the puzzle (3 moves needed here)', m.correct === true && m.done === true && m.themes.some((t) => t.id === 'mateIn3') && m.puzzleRating === row.rating, m);
  ok('a retry that succeeds does not count as a clean solve', m.clean === false && m.counted === false, m);
  const rv = await call('puzzle_review', { id: row.id }, U);
  ok('now the verified facts are available', rv.facts && rv.facts.mate === true && rv.facts.solution.length === 3 && rv.facts.themes.length > 0, rv);
  const ex = await call('puzzle_explain', { id: row.id }, U);
  ok('and an explanation, built in when there is no AI key', ex.src === 'template' && /checkmate/i.test(ex.text), ex);

  // a clean solve of a one-move mate; an alternative mating move is accepted too
  const alt = D.rows.find((r) => r.themes.includes('mateIn1') && (() => { const st = PZ.stateAfter(r, 1); return Chess.legalMoves(st).filter((x) => Chess.status(Chess.apply(st, x)).reason === 'checkmate').length > 1; })());
  U.alt = alt;
  await call('puzzle_next', { mode: 'custom', filter: { themes: ['mateIn1'] } }, U);   // (starts some puzzle; the next call switches to the one under test)
  const st1 = PZ.stateAfter(alt, 1), mates = Chess.legalMoves(st1).filter((x) => Chess.status(Chess.apply(st1, x)).reason === 'checkmate').map((x) => Chess.sqName(x.from) + Chess.sqName(x.to) + (x.promo ? x.promo.toLowerCase() : ''));
  const other = mates.find((x) => x !== alt.mv[1]);
  m = await call('puzzle_move', { id: alt.id, step: 1, move: other }, U);
  ok('any move that gives checkmate is accepted, like on Lichess', m.correct === true && m.done === true && m.alt === true && m.mate === true, m);

  const clean = D.rows.find((r) => r.themes.includes('mateIn1') && r.id !== alt.id && r.rating < 1000);
  m = await call('puzzle_move', { id: clean.id, step: 1, move: clean.mv[1] }, U);
  ok('a clean solve is counted and raises the rating', m.done && m.clean === true && m.counted === true && m.delta > 0, m);

  console.log('hints and the solution');
  const h = D.rows.find((r) => r.themes.includes('fork') && r.len === 2);
  let hint = await call('puzzle_hint', { id: h.id, step: 1, level: 1 }, U);
  ok('hint 1 names the piece to move (the square), not the target', hint.hint.from === h.mv[1].slice(0, 2) && !hint.hint.to, hint);
  hint = await call('puzzle_hint', { id: h.id, step: 1, level: 2 }, U);
  ok('hint 2 shows the move', hint.hint.to === h.mv[1].slice(2, 4), hint);
  m = await call('puzzle_move', { id: h.id, step: 1, move: h.mv[1] }, U);
  m = await call('puzzle_move', { id: h.id, step: 3, move: h.mv[3] }, U);
  ok('solving with hints is a finished puzzle but not a clean one', m.done && m.clean === false, m);
  const g = D.rows.find((r) => r.themes.includes('pin') && r.len === 2 && r.id !== h.id);
  await call('puzzle_next', { mode: 'custom', filter: { themes: ['pin'] } }, U);
  const sol = await call('puzzle_solution', { id: g.id }, U);
  ok('"show the solution" reveals the line and counts as a failed puzzle', sol.facts.solution.length === 2 && sol.counted === true && sol.delta < 0, sol);
  ok('afterwards the review is open', (await call('puzzle_review', { id: g.id }, U)).facts.id === g.id, null);

  console.log('progress tracking');
  const st = await call('puzzle_stats', {}, U);
  ok('attempts, solved, accuracy and average time are tracked', st.n === 5 && st.ok === 2 && Math.abs(st.accuracy - 0.4) < 1e-9 && (st.avgMs == null || st.avgMs >= 0), st);
  ok('performance by theme is tracked', st.themes.some((t) => t.id === 'mateIn1') && st.themes.find((t) => t.id === 'mate').n >= 3, st.themes.map((t) => t.id + ':' + t.n));
  ok('recent mistakes are listed and can be loaded again', st.misses.length >= 2 && (await call('puzzle_load', { id: st.misses[0].id }, U)).puzzle.id === st.misses[0].id, st.misses);
  ok('only a missed puzzle can be loaded again (no peeking at others)', (await call('puzzle_load', { id: D.rows[5].id }, U)).status === 403, null);
  ok('the rating history is kept', st.rhist.length === 5, st.rhist);

  console.log('weakness training and adaptive difficulty');
  const W = await su('wes');
  for (let i = 0; i < 4; i++) {
    const x = await call('puzzle_next', { mode: 'custom', filter: { themes: ['fork'], band: 'intermediate' } }, W);
    const r = D.byId.get(x.puzzle.id), s1 = PZ.stateAfter(r, 1);
    const bad = Chess.legalMoves(s1).map((q) => Chess.sqName(q.from) + Chess.sqName(q.to) + (q.promo ? q.promo.toLowerCase() : '')).find((u) => u !== r.mv[1] && Chess.status(Chess.apply(s1, Chess.findUci(s1, u))).reason !== 'checkmate');
    await call('puzzle_move', { id: r.id, step: 1, move: bad }, W);
  }
  const ws = await call('puzzle_stats', {}, W);
  ok('failing fork puzzles makes Fork a weak theme', ws.weak.some((x) => x.id === 'fork'), ws.weak);
  const wk = await call('puzzle_next', { mode: 'weakness' }, W);
  ok('Weakness training serves puzzles for the weak themes, near the player\'s level', wk.weak.some((x) => x.id === 'fork') && wk.filter.themes.length === 1 && wk.puzzle, wk.filter);
  ok('every puzzle it picks really has that theme', (() => { const r = D.byId.get(wk.puzzle.id); return wk.filter.themes.every((t) => r.ts.has(t)); })(), null);
  const base = PZ.newProgress(); base.rating = 1500;
  const good = { ...base, hist: Array.from({ length: 10 }, () => ({ ok: 1 })) }, poor = { ...base, hist: Array.from({ length: 10 }, (_, i) => ({ ok: i < 2 ? 1 : 0 })) }, mid = { ...base, hist: Array.from({ length: 10 }, (_, i) => ({ ok: i % 4 ? 1 : 0 })) }, none = { ...base, hist: [] };
  ok('adaptive difficulty goes up after a good run, down after a bad one, stays put without data', PZ.adaptiveTarget(good) > 1500 && PZ.adaptiveTarget(poor) < 1500 && PZ.adaptiveTarget(none) === 1500 && PZ.adaptiveTarget(mid) <= 1550, [PZ.adaptiveTarget(good), PZ.adaptiveTarget(poor), PZ.adaptiveTarget(mid)]);
  const ad = await call('puzzle_next', { mode: 'custom', adaptive: true, filter: { themes: ['pin'] } }, W);
  ok('adaptive mode is optional and picks a puzzle near the target rating', ad.puzzle && ad.target > 0 && Math.abs(D.byId.get(ad.puzzle.id).rating - ad.target) < 400, ad.target);
  const mx = await call('puzzle_next', { mode: 'mixed', filter: { relative: 'harder' } }, W);
  ok('Mixed training with a relative difficulty gives a puzzle without choosing themes', mx.puzzle && mx.filter.themes.length === 0, mx.filter);
  const win = (rt, ok1, n0) => { const p = PZ.newProgress(); p.rating = 1500; p.n = n0 || 0; return PZ.record(p, { id: 'x', rating: rt, themes: [], ok: ok1, ms: 1000 }).delta; };
  ok('rating moves more for an upset than for an expected result', win(1900, true) > win(1100, true) && win(1100, false) < win(1900, false), [win(1900, true), win(1100, true)]);

  console.log('empty results and limits');
  const e = await call('puzzle_next', { mode: 'custom', filter: { themes: ['underPromotion', 'zugzwang'], band: 'beginner' } }, U);
  ok('no match: an empty answer with what you could loosen, never an unrelated puzzle', e.empty === true && !e.puzzle && Array.isArray(e.relax) && e.relax.length > 0 && e.relax.every((x) => x.count > 0), e);
  const ce = await call('puzzle_count', { filter: { themes: ['underPromotion', 'zugzwang'], band: 'beginner' } }, U);
  ok('the live count says 0 and offers the same suggestions', ce.count === 0 && ce.relax.length > 0, ce);
  const ae = await call('puzzle_ai', { text: 'asdf' }, U);
  ok('an AI search that means nothing is empty and explains itself', ae.empty === true && ae.limits.length > 0 && ae.count === 0, ae);
  const ak = await call('puzzle_ai', { text: 'I want to practise knight forks, difficult' }, U);
  ok('an AI search returns the understood filter and how many puzzles match', ak.filter.themes.join() === 'fork' && ak.count > 0 && ak.understood.length >= 2, ak);
  ok('the theme list API only has real Lichess themes with counts', (await call('puzzle_meta', {}, U)).themes.every((t) => PZ.THEME_BY_ID.has(t.id) && t.n > 0), null);
  ok('puzzles need an account', (await call('puzzle_next', { mode: 'custom' })).status === 401, null);

  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
