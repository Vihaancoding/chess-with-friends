// The commentary for The Damage Report. The AI writes the line; nothing it says is trusted:
//   1. it is given only real facts from the game and the last lines already on the page,
//   2. it writes 3 candidates, and every one is checked here (style rules, repeated phrasing, and that every number,
//      piece and ending it mentions is in the facts),
//   3. a second pass picks the funniest of the ones that survived,
//   4. if the AI is down, slow or everything is rejected, a bank of templates filled with the same facts is used.
// The result is stored with the card, so a page view never calls the AI.
const { TEMPLATES } = require('./damagebank');
const { NAME } = require('./damage');

const PIECE_WORDS = { queen: 'Q', rook: 'R', bishop: 'B', knight: 'N', pawn: 'P', king: 'K' };
const NUM_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const stats = { llmCalls: 0, llmFails: 0, templated: 0 };

// ---------- what the line is allowed to talk about ----------
function ctxOf(card, f, opts = {}) {
  const W = f.wc, L = f.lc, loser = f.loser, winner = f.winner;
  const lb = (f.loserBlunders || []).slice();
  const hungs = lb.filter((b) => b.kind === 'hung').sort((a, b) => b.drop - a.drop);
  const forks = lb.filter((b) => b.kind === 'fork');
  const mmL = (f.missed || []).find((m) => m.kind === 'mate' && m.side === L), mmW = (f.missed || []).find((m) => m.kind === 'mate' && m.side === W);
  const tac = (f.tactics || [])[0];
  const queen = f.mat.queenLost && f.moves - f.mat.queenLost.move >= 2 ? f.mat.queenLost : null;
  const flags = new Set(['gen']);
  if (opts.target) flags.add('target');
  const t = { w: winner, l: loser, moves: f.moves };
  if (queen) { flags.add('queen'); t.qm = queen.move; t.surv = f.moves - queen.move; }
  if (hungs[0]) { flags.add('hung'); t.hm = hungs[0].move; t.hp = NAME[hungs[0].piece].toLowerCase(); }
  if (forks[0]) { flags.add('fork'); t.fm = forks[0].move; }
  if (lb.length >= 2) { flags.add('blunders'); t.bn = lb.length; }
  if (mmL) { flags.add('mmL'); t.mn = mmL.n; t.mm = mmL.move; }
  else if (mmW) { flags.add('mmW'); t.mn = mmW.n; t.mm = mmW.move; }
  if (f.reason === 'checkmate') { flags.add('mate'); if (f.moves <= 22) flags.add('early'); }
  if (f.reason === 'resignation') flags.add('resign');
  if (f.reason === 'timeout') flags.add('timeout');
  if (f.king && f.king.checks >= 3 && f.king.kingMoves >= 2) { flags.add('king'); t.ck = f.king.checks; t.km = f.king.kingMoves; }
  if (tac) { flags.add('tactic'); t.tm = tac.move; t.tk = tac.kind; t.tp = NAME[tac.piece].toLowerCase(); }
  if (f.moves >= 45) flags.add('long');
  if (f.moves <= 25) flags.add('short');
  if (f.mat.finalLead >= 9) { flags.add('lead'); t.lead = Math.round(f.mat.finalLead); }
  if (f.mat.lostPieces >= 4) { flags.add('lost'); t.lost = f.mat.lostPieces; }
  if (f.comeback) { t.down = Math.max(1, Math.round(-f.comeback.low / 100)); t.lowm = f.comeback.lowMove; }
  // the facts the AI sees, in plain words, each with the numbers it may use
  const facts = {
    result: `${winner} beat ${loser}`, ending: f.reason === 'checkmate' ? `checkmate on move ${f.moves}` : f.reason === 'resignation' ? `${loser} resigned on move ${f.moves}` : `${loser} lost on time on move ${f.moves}`,
    moves: f.moves, ratings: { [winner]: f.ratingW, [loser]: f.ratingL }, score: card.score, band: card.label, shape: f.shape,
  };
  const items = [];
  if (queen) items.push(`${loser} lost their queen for nothing on move ${queen.move} and played ${t.surv} more moves after that`);
  for (const b of lb.slice(0, 4)) items.push(`${loser} blundered on move ${b.move} (${b.kind === 'hung' ? `hung a ${NAME[b.piece].toLowerCase()}` : b.kind === 'fork' ? 'walked into a fork' : 'threw away the position'}, evaluation dropped about ${Math.round(b.drop / 100)} pawns)`);
  if (lb.length) facts.loserBlunders = lb.length;
  if (mmL) items.push(`${loser} missed a forced mate in ${mmL.n} on move ${mmL.move}`);
  if (mmW) items.push(`${winner} missed a forced mate in ${mmW.n} on move ${mmW.move} and won anyway`);
  for (const x of (f.missed || []).filter((m) => m.kind === 'win').slice(0, 1)) items.push(`${x.side === L ? loser : winner} let a winning position slip on move ${x.move}`);
  for (const x of (f.tactics || []).slice(0, 2)) items.push(`${winner} played an engine-confirmed ${x.kind}${x.kind === 'fork' ? '' : ' (a piece sacrifice that wins)'} with a ${NAME[x.piece].toLowerCase()} on move ${x.move}`);
  if (flags.has('king')) items.push(`${winner} gave ${t.ck} checks in the last stretch while ${loser}'s king made ${t.km} moves`);
  if (f.comeback) items.push(`${winner} was down about ${t.down} pawns on move ${t.lowm} and came back to win`);
  if (f.mat.finalLead >= 3) items.push(`${winner} finished ${Math.round(f.mat.finalLead)} points of material ahead`);
  if (f.mat.lostPieces >= 3) items.push(`${loser} lost ${f.mat.lostPieces} pieces (not counting pawns) over the game`);
  if (f.acc && f.acc.w != null) facts.accuracy = { [winner]: Math.round(f.acc[W]), [loser]: Math.round(f.acc[L]) };
  facts.lossesOf = { [loser]: f.lossesL || {}, [winner]: f.lossesW || {} };
  facts.moments = items;
  // numbers and pieces a line may mention
  const nums = new Set([0, 1]), moveNums = new Set([f.moves]);
  const addNums = (o) => { if (typeof o === 'number') nums.add(Math.round(o)); else if (o && typeof o === 'object') Object.values(o).forEach(addNums); };
  addNums({ moves: f.moves, t: Object.fromEntries(Object.entries(t).filter(([, v]) => typeof v === 'number')), r: facts.ratings, acc: facts.accuracy, bl: facts.loserBlunders, score: card.score });
  for (const x of items) for (const m of x.matchAll(/\d+/g)) { nums.add(+m[0]); if (/move \d+/.test(x)) for (const mm of x.matchAll(/move (\d+)/g)) moveNums.add(+mm[1]); }
  for (const x of [...(f.loserBlunders || []), ...(f.missed || []), ...(f.tactics || [])]) if (x.move) { moveNums.add(x.move); nums.add(x.move); }
  if (queen) { moveNums.add(queen.move); nums.add(queen.move); }
  for (const k of ['surv', 'lowm', 'qm']) if (t[k] != null) nums.add(t[k]);
  nums.add(f.moves); nums.add(Math.abs(f.ratingW - f.ratingL));
  const pieces = new Set();
  for (const [name, code] of Object.entries(PIECE_WORDS)) if ((f.lossesL && f.lossesL[code]) || (f.lossesW && f.lossesW[code])) pieces.add(name);
  if (queen) pieces.add('queen');
  for (const b of lb) if (b.piece) pieces.add(NAME[b.piece].toLowerCase());
  for (const x of f.tactics || []) pieces.add(NAME[x.piece].toLowerCase());
  if (f.reason === 'checkmate' || f.king.hunted || mmL || mmW) pieces.add('king');
  return { target: !!opts.target, band: card.kind === 'comeback' ? 'comeback' : card.band, flags, t, facts, nums, moveNums, pieces, reason: f.reason, mateOk: f.reason === 'checkmate' || !!mmL || !!mmW, comeback: !!f.comeback, loser, winner };
}

// ---------- rules every line has to pass (the AI's and the bank's) ----------
const BANNED = [
  /[—–]/, /[:;#@]/, /\p{Extended_Pictographic}/u,
  /\bit'?s not\b.*\bit'?s\b/i, /\bnot (just|only|merely)\b/i, /\bnot a \w+,? but\b/i, /\bless a \w+ and more\b/i, /\bnot so much\b/i,
  /masterclass|testament|symphony|tapestry|\bjourney\b|\bdance\b|in the world of|\brealm\b|\bdelve\b|navigate|landscape|elevate|unleash|showcase|crucial|vibrant|\bepic\b|buckle up|strap in|ladies and gentlemen|at the end of the day|reminder that|lesson in|a lesson|let'?s\b|oops|whoops|remember\b|furthermore|moreover|however|ultimately|in conclusion|unfortunately|thankfully|hopefully|stay tuned|plot twist|and just like that|truly|literally/i,
  /,[^,.]*,\s*(and|or)\s/i,                                     // a tidy list of three
  /\b(he|she|his|her|hers|him|himself|herself)\b/i,          // nobody gets assumed a gender
  /\bAI\b|\bas an\b|\blanguage model\b/,
];
const wordsOf = (s) => (s.toLowerCase().match(/[a-z0-9']+/g) || []);
function styleProblem(line) {
  if (typeof line !== 'string') return 'not text';
  const s = line.trim();
  if (s.length < 24 || s.length > 240) return 'length';
  if (wordsOf(s).length < 5) return 'too short';
  const sentences = s.split(/(?<=[.?!])\s+/).filter(Boolean);
  if (sentences.length > 2) return 'more than two sentences';
  if ((s.match(/!/g) || []).length > 1) return 'shouting';
  for (const re of BANNED) if (re.test(s)) return `banned: ${re}`;
  if (/^\s*["'(\[]/.test(s) && /["')\]]\s*$/.test(s)) return 'quoted';
  return null;
}
// every claim is backed by the facts
function factProblem(line, ctx) {
  const low = line.toLowerCase();
  for (const m of line.matchAll(/\bmoves?\s+(\d+)/gi)) if (!ctx.moveNums.has(+m[1])) return `invented move number ${m[1]}`;
  for (const m of line.matchAll(/(?<![\w.])\d+(?![\w.])/g)) if (!ctx.nums.has(+m[0])) return `invented number ${m[0]}`;
  for (const m of low.matchAll(/\b(two|three|four|five|six|seven|eight|nine|ten|twelve)\b(?!\s*(?:or|of)\b)/g)) if (!ctx.nums.has(NUM_WORDS[m[1]])) return `invented count "${m[1]}"`;
  for (const [name] of Object.entries(PIECE_WORDS)) if (new RegExp(`\\b${name}s?\\b`).test(low) && !ctx.pieces.has(name)) return `${name} never happened`;
  if (/\bmat(e|ed|es)\b|checkmate/.test(low) && !ctx.mateOk) return 'no mate in this game';
  if (/\bresign/.test(low) && ctx.reason !== 'resignation') return 'nobody resigned';
  if (/\bflag(ged)?\b|clock|timed out|time ?out|ran out of time|lost on time/.test(low) && ctx.reason !== 'timeout') return 'nobody lost on time';
  if (/comeback|came back|come back|from the dead/.test(low) && !ctx.comeback) return 'no comeback happened';
  if (/\bfork/.test(low) && !ctx.flags.has('fork') && !ctx.flags.has('tactic')) return 'no fork happened';
  if (/\bsacrific/.test(low) && !(ctx.facts.moments || []).some((x) => /sacrifice/.test(x))) return 'no sacrifice happened';
  if (!/\d/.test(line) && !ctx.pieces.size) return 'nothing specific';
  if (!/\d/.test(line) && !/\b(queen|rook|bishop|knight|mate|king|pawn|fork)/.test(low)) return 'nothing specific';
  return null;
}
// the same joke twice in a row is not a joke
function repeatProblem(line, recent) {
  const w = wordsOf(line), open = w.slice(0, 3).join(' '), grams = new Set(); for (let i = 0; i + 3 < w.length; i++) grams.add(w.slice(i, i + 4).join(' '));
  for (const r of (recent || []).slice(0, 12)) {
    const rw = wordsOf(r.line || r);
    if (rw.slice(0, 3).join(' ') === open) return 'same opening as a recent line';
    let hit = 0; for (let i = 0; i + 3 < rw.length; i++) if (grams.has(rw.slice(i, i + 4).join(' '))) hit++;
    if (hit >= 2) return 'shares a phrase with a recent line';
    const a = new Set(w), b = new Set(rw); let inter = 0; for (const x of a) if (b.has(x)) inter++;
    if (inter / (a.size + b.size - inter) >= 0.6) return 'too close to a recent line';
  }
  return null;
}
const problemWith = (line, ctx, recent) => styleProblem(line) || factProblem(line, ctx) || repeatProblem(line, recent);

// ---------- the bank ----------
function hashOf(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rngOf(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const fill = (s, t) => { let ok = true; const out = s.replace(/\{(\w+)\}/g, (m, k) => { if (t[k] == null) { ok = false; return m; } return String(t[k]); }); return ok ? out : null; };
const TYPE_W = { queen: 9, hung: 8, mmL: 9, mmW: 7, fork: 6, blunders: 5, tactic: 6, king: 6, early: 6, mate: 3, resign: 2, timeout: 2, long: 3, short: 3, lead: 3, lost: 3, gen: 1, target: 40 };
function fromBank(ctx, recent, seedKey) {
  const rnd = rngOf(hashOf(seedKey || JSON.stringify(ctx.t)));
  const recentIds = (recent || []).map((r) => r.tpl).filter(Boolean), recentTypes = (recent || []).map((r) => r.type).filter(Boolean);
  const pool = TEMPLATES.filter((x) => x.band === ctx.band && x.need.every((n) => ctx.flags.has(n)));
  const rendered = pool.map((x) => ({ x, line: fill(x.s, ctx.t) })).filter((r) => r.line);
  const tryList = (list) => list.filter((r) => !styleProblem(r.line) && !factProblem(r.line, ctx));
  let ok = tryList(rendered);
  if (ctx.target) { const tg = ok.filter((r) => r.x.type === 'target'); if (tg.length && rnd() < 0.8) ok = tg; }   // the marked player always gets the mean ones
  const fresh = ok.filter((r) => !recentIds.includes(r.x.id) && !repeatProblem(r.line, recent));
  if (fresh.length) ok = fresh;
  else { const lessStale = ok.filter((r) => !recentIds.slice(0, 20).includes(r.x.id)); if (lessStale.length) ok = lessStale; }
  const varied = ok.filter((r) => !recentTypes.slice(0, 2).includes(r.x.type));       // a different kind of joke from the last two
  if (varied.length) ok = varied;
  if (!ok.length) return null;
  // the more notable the moment, the better: a hung queen beats "up 9 points". Generic lines are the last resort
  const weighted = ok.map((r) => ({ r, w: (TYPE_W[r.x.type] || 1) * (r.x.type === 'hung' && ctx.t.hp === 'queen' ? 1.3 : 1) }));
  let pick = rnd() * weighted.reduce((a, b) => a + b.w, 0);
  for (const e of weighted) { pick -= e.w; if (pick <= 0) return { line: e.r.line, tpl: e.r.x.id, type: e.r.x.type, src: 'template' }; }
  const e = weighted[weighted.length - 1];
  return { line: e.r.line, tpl: e.r.x.id, type: e.r.x.type, src: 'template' };
}

// ---------- the AI ----------
const SYSTEM = `You write one-liners for a chess site's "Damage Report", the card that roasts the loser of a game that was a total mismatch.
Voice: a funny friend in a group chat roasting a mate after a game. Unfiltered gaming banter. Swear a lot, naturally, in most lines from Dominant up (fuck, fucking, shit, bullshit, arse, dogshit, bollocks, cunt, dumbass, pissed, cooked, rinsed). Brutal and Complete should be properly filthy. Never use slurs, never mention rape, genocide or real-world violence, and never aim insults at anything except the chess. Dry, specific, a bit rude.
Hard rules
- One or two sentences. The punchline comes last.
- Every line must reference something specific that really happened in the facts you are given: a move number, the piece, how long the game lasted, how long the loser survived, the eval swing, how it ended. Specific beats generic every time.
- Use only the facts given. Never invent a move, a piece, a number, an opponent or an event. If the facts do not mention a queen being lost, do not mention a queen. If nobody missed a mate, do not mention mate.
- You can wonder what the loser was thinking, but keep it to what the facts support.
- Refer to players by their username, or "they". Never he, she, his or her.
- Match the heat to the band. Slight edge is light teasing. Dominant is cheeky. Brutal is savage. Complete domination is absurd and over the top.
- Mix the technique: deadpan understatement, sports commentator exaggeration, mock sympathy, a fake news report voice, an absurd comparison, a callback to the exact move.
- Never start the way a recent line started and never reuse a joke, phrase or structure from the recent lines.
Do not sound like an AI
- No em dashes or en dashes. No colons or semicolons. No hashtags, no emojis, no hyphen used as a dash.
- No "it's not X, it's Y" constructions, no "not just X but Y". No lists of three. No "in the world of". Never say masterclass, testament, symphony, tapestry, journey, dance, "buckle up", "plot twist" or "literally".
- No moral at the end. Do not explain the joke. Do not summarise the game before the punchline.
- Vary sentence length. Fragments are fine. Lowercase is fine sometimes. It should never read like a press release, a motivational quote or a polished essay.
Avoid polite, cute or theatrical wording (never "politely", "nods", "dedication", "cinema", "charity"). Plain blunt roasts land better, like "plays like their dog is on the mouse". Use "they" and "their" for people.
Tone references only, never copy these or their structure
"Queen gone on move 9 and he kept playing for 31 more moves." "Had mate in 2 on move 22 and played a rook move instead." "Lasted 14 moves. The opening theory he ignored was longer than his resistance." "Three blunders in four moves. At that point the board was just taking donations."
Reply with JSON only.`;

function promptFor(ctx, recent) {
  const heat = { slight: 'Slight edge (light teasing)', dominant: 'Dominant (cheeky)', brutal: 'Brutal (savage)', complete: 'Complete domination (absurd and over the top)', comeback: 'A comeback: the winner was lost and turned it around (the loser threw it)' }[ctx.band];
  return `Band: ${heat}${ctx.target ? `\nTARGET: ${ctx.loser} is the group's designated punching bag. Be as vicious and cruel as you can, about their chess only. No slurs, nothing about family, body, race, health or real life.` : ''}
Facts (all of them are real, use no others):
${JSON.stringify(ctx.facts, null, 1)}

Recent lines already on the page. Do not reuse their openings, jokes, phrases or structure:
${(recent || []).slice(0, 10).map((r) => `- ${r.line || r}`).join('\n') || '(none yet)'}

Write 3 different candidate lines, each built on a different real moment where the facts allow it.
Reply as {"lines":["...","...","..."]}`;
}
function pickPrompt(ctx, lines) {
  return `Here are real facts from a chess game and ${lines.length} candidate roast lines. Pick the one that is funniest AND completely accurate to the facts, and that sounds like a mate in a group chat rather than an AI. If a line states anything the facts do not support, never pick it.
Facts:
${JSON.stringify(ctx.facts, null, 1)}
Candidates:
${lines.map((l, i) => `${i}. ${l}`).join('\n')}
Reply as {"pick": <number>}`;
}
// which AI writes the lines: Llama (any OpenAI-compatible host: Groq, Together, Ollama...) when LLAMA_API_KEY or
// DAMAGE_PROVIDER=llama is set, otherwise Claude. No key for the chosen one means no AI: the template bank is used.
function providerOf(deps = {}) {
  const llama = deps.provider ? deps.provider === 'llama' : process.env.DAMAGE_PROVIDER === 'llama' || (!process.env.DAMAGE_PROVIDER && !!process.env.LLAMA_API_KEY && !process.env.ANTHROPIC_API_KEY);
  if (llama) return { kind: 'llama', key: deps.apiKey !== undefined ? deps.apiKey : process.env.LLAMA_API_KEY, base: (deps.baseUrl || process.env.LLAMA_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''), model: deps.model || process.env.LLAMA_MODEL || 'llama-3.3-70b-versatile' };
  return { kind: 'claude', key: deps.apiKey !== undefined ? deps.apiKey : process.env.ANTHROPIC_API_KEY, base: (deps.baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''), model: deps.model || process.env.DAMAGE_MODEL || 'claude-haiku-5-5' };
}
const aiEnabled = (deps) => !!providerOf(deps).key && process.env.DAMAGE_LLM !== 'off';
async function ask(deps, system, user, maxTokens) {
  const pv = providerOf(deps);
  if (!pv.key || process.env.DAMAGE_LLM === 'off') return null;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), deps.timeoutMs || 9000);
  stats.llmCalls++;
  try {
    const llama = pv.kind === 'llama';
    const r = await (deps.fetch || fetch)(llama ? `${pv.base}/chat/completions` : `${pv.base}/v1/messages`, {
      method: 'POST', signal: ctl.signal,
      headers: llama ? { 'content-type': 'application/json', authorization: `Bearer ${pv.key}` } : { 'content-type': 'application/json', 'x-api-key': pv.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(llama
        ? { model: pv.model, max_tokens: maxTokens, temperature: 1, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }
        : { model: pv.model, max_tokens: maxTokens, temperature: 1, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!r.ok) throw new Error('AI ' + r.status);
    const j = await r.json();
    const text = llama ? (((j.choices || [])[0] || {}).message || {}).content || '' : (j.content || []).map((c) => c.text || '').join('');
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) { stats.llmFails++; return null; } finally { clearTimeout(timer); }
}
// three candidates, every one checked, then the funniest accurate one
async function fromAI(ctx, recent, deps) {
  const first = await ask(deps, SYSTEM, promptFor(ctx, recent), 700);
  const cands = ((first && first.lines) || []).filter((x) => typeof x === 'string').map((x) => x.trim().replace(/^["“]|["”]$/g, '')).slice(0, 3);
  const good = cands.filter((c) => !problemWith(c, ctx, recent));
  if (!good.length) return { rejected: cands.length ? cands.map((c) => [c, problemWith(c, ctx, recent)]) : null };
  let line = good[0];
  if (good.length > 1) {
    const second = await ask(deps, 'You judge roast lines for a chess site. Reply with JSON only.', pickPrompt(ctx, good), 80);
    if (second && Number.isInteger(second.pick) && good[second.pick]) line = good[second.pick];
  }
  return { line, src: 'ai', candidates: cands.length };
}

// the line for a card: the AI if it can, the bank if it can't
async function commentary(card, f, recent, deps = {}, opts = {}) {
  const ctx = ctxOf(card, f, opts);
  let out = null;
  try { out = await fromAI(ctx, recent, deps); } catch (e) { out = null; }
  if (out && out.line) return { line: out.line, src: 'ai', tpl: null, type: 'ai' };
  const t = fromBank(ctx, recent, f.id);
  stats.templated++;
  if (t) return { ...t, rejected: out && out.rejected ? out.rejected.length : 0 };
  return { line: `${f.winner} beat ${f.loser} in ${f.moves} moves.`, src: 'template', tpl: 'plain', type: 'gen' };       // never blank
}

module.exports = { aiEnabled, providerOf, ctxOf, styleProblem, factProblem, repeatProblem, problemWith, fromBank, fromAI, commentary, stats, SYSTEM, promptFor, fill, hashOf, TEMPLATES };
