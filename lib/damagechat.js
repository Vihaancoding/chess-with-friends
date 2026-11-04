// In-game chat for the Damage Report. Only messages stored server-side from this game, sent by its two authenticated players,
// that pass the safety filter below. Anything doubtful is dropped (never edited), and a quote must match a kept message exactly.

const MAX_LEN = 100, MAX_KEPT = 4;

// a friends-only site, so banter and swearing pass. Still never quoted: slurs, real threats, links and contact details
const UNSAFE = [
  /https?:|www\.|\b[\w-]+\.(com|net|org|gg|io|tv|me|co|ly|xyz|app)\b/i,                          // links
  /[\w.+-]+@[\w-]+|[:;#@]/,                                                                       // emails, handles, and characters the page style never allows
  /\d[\d\s().-]{5,}\d/,                                                                           // phone numbers and long digit runs
  /\b(my address|my phone|my number|i live (at|on)|dm me|add me)\b/i,                            // contact details
  /\b(kill (you|yourself)|kys|hang yourself|suicide|rape|raped|find you|swat|dox+|murder you|shoot you|stab you)\b/i,   // real threats
  /\b(n[i1!]gg|f[a@]gg?|r[e3]t[a@]rd|tr[a@]nn|kike|chink|spic|coon|dyke|paki|wetback|gook|negro|towelhead|sp[a@]stic)/i,   // slurs
];

const norm = (s) => String(s).toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const safe = (t) => typeof t === 'string' && t.length >= 2 && t.length <= MAX_LEN && !UNSAFE.some((re) => re.test(t)) && !/["“”]/.test(t);

// g: the archived game; msgs: its stored chat; muted: names of players who are muted or have opted out of the Damage Report
function pick(g, msgs, muted) {
  if (!g || !g.players || !Array.isArray(msgs) || !msgs.length) return [];
  const names = { w: g.players.w && g.players.w.name, b: g.players.b && g.players.b.name };
  if (!names.w || !names.b) return [];
  const bad = new Set((muted || []).map((x) => String(x).toLowerCase()));
  if (bad.has(names.w.toLowerCase()) || bad.has(names.b.toLowerCase())) return [];          // either side muted or opted out: no chat at all
  const t0 = g.startedAt || 0, t1 = (g.endedAt || 0) + 60e3;
  const out = [];
  for (const m of msgs) {
    if (!m || (m.s !== 'w' && m.s !== 'b') || m.n !== names[m.s]) continue;                  // players of this game only, no spectators
    if (!m.ts || m.ts < t0 || m.ts > t1) continue;                                           // this game only (room codes get reused)
    const t = String(m.t || '').trim();
    if (!safe(t)) continue;
    // roughly which move it was sent on, from the clock spent so far (null when unknown)
    let move = null;
    if (g.mt && g.mt.length) { let acc = 0, p = 0; const el = m.ts - t0; while (p < g.mt.length && acc + g.mt[p] < el) { acc += g.mt[p]; p++; } move = Math.min(g.mt.length, p) / 2; move = Math.floor(move) + 1; }
    out.push({ name: m.n, t, move });
  }
  return out.slice(-MAX_KEPT);
}

// a quote in a line has to be a message that was really sent
function chatProblem(line, chat) {
  const quotes = [...String(line).matchAll(/["“]([^"”]{1,80})["”]/g)].map((m) => norm(m[1]));
  if (!quotes.length) return null;
  const real = (chat || []).map((c) => norm(c.t));
  for (const q of quotes) if (!q || !real.some((r) => r === q || r.includes(q))) return 'quoted something nobody said';
  return null;
}
module.exports = { pick, chatProblem, safe, MAX_LEN };
