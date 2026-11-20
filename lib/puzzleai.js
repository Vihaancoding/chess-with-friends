// The AI side of the puzzle trainer. It only ever does two things, and application code checks both:
//   1. interpret(): turn a request in words into a filter. The AI answers with JSON, which is validated against the real Lichess theme
//      list and filter limits (lib/puzzles.js); the sentence shown to the player is built from the validated filter, not from the AI.
//   2. explain(): put the verified facts about a finished puzzle into a short explanation. Any move or evaluation the facts do not
//      contain makes the text invalid and the built-in explanation is used instead.
// The AI never supplies puzzles, solutions or variations. The provider is the one the damage report uses (lib/damagetext.js):
// ANTHROPIC_API_KEY, or LLAMA_API_KEY (any OpenAI-compatible host). PUZZLE_MODEL overrides the model, PUZZLE_LLM=off turns the AI off.
const P = require('./puzzles');
const Text = require('./damagetext');

const providerFor = (deps = {}) => { const pv = Text.providerOf(deps); return process.env.PUZZLE_MODEL && !deps.model ? { ...pv, model: process.env.PUZZLE_MODEL } : pv; };
const enabled = (deps) => process.env.PUZZLE_LLM !== 'off' && !!providerFor(deps).key;

async function askJSON(system, user, maxTokens, deps = {}) {
  if (!enabled(deps)) return null;
  const pv = providerFor(deps), ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), deps.timeoutMs || 9000);
  try {
    const llama = pv.kind === 'llama';
    const r = await (deps.fetch || fetch)(llama ? `${pv.base}/chat/completions` : `${pv.base}/v1/messages`, {
      method: 'POST', signal: ctl.signal,
      headers: llama ? { 'content-type': 'application/json', authorization: `Bearer ${pv.key}` } : { 'content-type': 'application/json', 'x-api-key': pv.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(llama
        ? { model: pv.model, max_tokens: maxTokens, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }
        : { model: pv.model, max_tokens: maxTokens, temperature: 0, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!r.ok) throw new Error('AI ' + r.status);
    const j = await r.json();
    const text = llama ? (((j.choices || [])[0] || {}).message || {}).content || '' : (j.content || []).map((c) => c.text || '').join('');
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

// ---------- 1. a request in words -> a validated filter ----------
const THEME_LIST = P.THEMES.map((t) => `${t.id} = ${t.label}`).join('; ');
const SYSTEM = `You turn a chess student's request into a filter for the Lichess puzzle database. Reply with one JSON object only:
{"themes": [theme ids], "match": "all" | "any", "band": "beginner" | "intermediate" | "advanced" | "expert" | "master" | null, "min": number | null, "max": number | null, "firstPiece": "K" | "Q" | "R" | "B" | "N" | "P" | null, "minLen": number | null, "maxLen": number | null, "unsupported": [short phrases for parts of the request that no theme can express]}
Rules: use only theme ids from this list: ${THEME_LIST}. "min"/"max" are puzzle ratings. "firstPiece" is the piece that makes the first move of the solution; use it only when the student names a piece for the tactic (for example "knight forks"). "minLen"/"maxLen" count the student's own moves in the solution (several moves to calculate = minLen 3). Put anything that is not a Lichess theme (named openings, positional ideas, time pressure) in "unsupported" instead of guessing a theme. Never write puzzles, moves or solutions.`;

const cache = new Map();
function finish(raw, src, extraLimits = []) {
  const { filter, dropped } = P.normalizeFilter(raw);
  const limits = [...extraLimits];
  if (dropped.length) limits.push('Not Lichess themes, ignored: ' + dropped.join(', '));
  const understood = P.describe(filter);
  const empty = !filter.themes.length && filter.min <= 0 && filter.max >= 4000 && !filter.firstPiece && !filter.minLen && !filter.maxLen;
  return { src, filter, understood, limits, empty };
}
async function interpret(text, deps = {}) {
  const q = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!q) return { empty: true, src: 'builtin', filter: P.normalizeFilter({}).filter, understood: [], limits: ['Say what you want to practise.'] };
  const k = q.toLowerCase();
  if (!deps.noCache && cache.has(k)) return cache.get(k);
  const built = P.parseRequest(q);
  let out = null;
  if (enabled(deps)) {
    const j = await askJSON(SYSTEM, q, 400, deps);
    if (j && typeof j === 'object') {
      const lim = (Array.isArray(j.unsupported) ? j.unsupported : []).slice(0, 4).map((x) => String(x).replace(/[<>]/g, '').slice(0, 80)).filter(Boolean);
      const r = finish({ themes: j.themes, match: j.match, band: j.band, min: j.min, max: j.max, firstPiece: j.firstPiece, minLen: j.minLen, maxLen: j.maxLen }, 'ai', lim.map((x) => `Cannot be expressed with Lichess themes: ${x}`));
      if (!r.empty) out = r;
    }
  }
  if (!out) {
    out = finish(built.raw, 'builtin', built.limits.map((x) => `Not available: ${x}`));
  }
  if (out.empty && !out.limits.length) out.limits.push('That did not match any Lichess theme, rating or length. Try naming a tactic (fork, pin, skewer, back rank mate...), a difficulty or an endgame.');
  // "knight fork" style filters are approximate: the piece is the one making the solution's first move
  if (out.filter.firstPiece) out.limits.push(`"${P.PIECES[out.filter.firstPiece]}" means the first move of the solution is made by a ${P.PIECES[out.filter.firstPiece]}; Lichess themes do not say which piece does the tactic.`);
  cache.set(k, out); if (cache.size > 200) cache.delete(cache.keys().next().value);
  return out;
}

// ---------- 2. the explanation ----------
const MOVE_RE = /\b(O-O-O|O-O|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?(?![a-z0-9])/g;
const clean = (s) => String(s).replace(/[+#?!]+$/, '');
// every move named in the text must be one of the puzzle's own moves; no evaluations or numbers the facts do not contain
function explanationProblem(text, facts) {
  if (typeof text !== 'string' || text.length < 20 || text.length > 700) return 'length';
  const ok = new Set(facts.line.map((x) => clean(x.san)));
  const words = text.replace(/\b(Rook|Queen|Knight|Bishop|King|Pawn)\b/g, '');
  for (const m of words.matchAll(MOVE_RE)) {
    const t = clean(m[0]);
    if (/^[a-h][1-8]$/.test(t)) continue;                  // a square on its own is fine
    if (!ok.has(t)) return 'move ' + t;
  }
  if (/[+-]\s?\d+(\.\d+)?\s*(pawns?|cp|centipawns)?|\b\d+(\.\d+)?\s*(centipawns|cp)\b|\bforced mate in \d/i.test(text.replace(/\d+\.\.?\.?/g, ''))) return 'evaluation';
  if (facts.mate === false && /checkmate|mates?\b/i.test(text)) return 'mate';
  return null;
}
const ordinal = (san, i, side) => san;
function templateExplain(f) {
  const specific = f.themes.filter((t) => !['mate', 'short', 'long', 'veryLong', 'oneMove', 'advantage', 'crushing', 'equality', 'opening', 'middlegame', 'endgame'].some((g) => t.id === g) && !/^mateIn\d$/.test(t.id));
  const parts = [];
  if (specific.length) parts.push(`The idea is ${specific.slice(0, 2).map((t) => `${t.label.toLowerCase()}: ${t.meaning.charAt(0).toLowerCase()}${t.meaning.slice(1)}`.replace(/\.$/, '')).join('; and ')}.`);
  else if (f.themes.length) parts.push(`This is a ${f.themes[0].label.toLowerCase()} puzzle: ${f.themes[0].meaning.charAt(0).toLowerCase()}${f.themes[0].meaning.slice(1)}`);
  parts.push(`The solution is ${f.solution.join(', ')}.`);
  if (f.mate) parts.push(f.mateIn ? `It ends in checkmate on your move ${f.mateIn}.` : 'It ends in checkmate.');
  else if (f.material.net > 0) parts.push(`You finish ${f.material.net} point${f.material.net > 1 ? 's' : ''} of material ahead (pawn = 1, minor piece = 3, rook = 5, queen = 9).`);
  if (f.material.sacrifice) parts.push(`On the way you give up material (down ${-f.material.low} at the lowest point), which is why the idea is hard to see.`);
  if (f.promotion) parts.push(`A pawn promotes to a ${f.promotion}.`);
  return parts.join(' ');
}
const EXPLAIN_SYSTEM = `You write a short explanation (2 to 3 sentences, plain language) of a chess puzzle for a student who just finished it. You are given verified facts. Use only those facts: name only moves from "line" exactly as written there, give no evaluations, no numbers other than move numbers, no other variations, and do not claim anything about the position that the facts do not state. Reply as JSON: {"text": "..."}`;
async function explain(facts, deps = {}) {
  const base = { text: templateExplain(facts), src: 'template' };
  if (!enabled(deps)) return base;
  const brief = { side: facts.side, themes: facts.themes.map((t) => ({ label: t.label, meaning: t.meaning })), line: facts.line.map((x) => ({ by: x.by, san: x.san })), endsInCheckmate: facts.mate, material: { net: facts.material.net, sacrifice: facts.material.sacrifice }, promotion: facts.promotion };
  const j = await askJSON(EXPLAIN_SYSTEM, JSON.stringify(brief), 300, deps);
  const text = j && typeof j.text === 'string' ? j.text.trim() : '';
  if (text && !explanationProblem(text, facts)) return { text, src: 'ai' };
  return base;
}

module.exports = { enabled, interpret, explain, templateExplain, explanationProblem, askJSON, SYSTEM };
