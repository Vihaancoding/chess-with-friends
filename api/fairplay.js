// The fair-play check, in its own function so that Stockfish never runs where moves and chat are served.
// api/index.js calls this after a move ({ code, srv }), when a game ends ({ post: gameId }) and from the lobby refresh ({ sweep: true }): POST /api/fairplay with the shared secret (env FAIR_SECRET) in x-fair-secret.
// It answers 202 straight away and does the work in the background, so the caller is never held up.
process.env.FAIR_WORKER = '1';                                           // this is the one function allowed to run the engine
process.env.FAIR_EVERY = process.env.FAIR_EVERY || '1';                  // check after every move
process.env.FAIR_SF_BUDGET_MS = process.env.FAIR_SF_BUDGET_MS || '25000'; // up to 25 s of engine time per side, so both sides fit in the 60 s the function may run
const crypto = require('crypto');
const app = require('../lib/app');

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { return {}; }
}
const send = (res, code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only.' });
  const secret = process.env.FAIR_SECRET;
  if (!secret || !same(req.headers['x-fair-secret'] || '', secret)) return send(res, 401, { error: 'No.' });
  const b = await readBody(req), code = b.code ? String(b.code).toUpperCase() : '';
  const what = code ? { code, srv: b.srv } : b.post && /^[A-Z0-9]{3,12}-[a-z0-9]{1,12}$/.test(String(b.post)) ? { post: String(b.post), srv: b.srv } : b.sweep ? { sweep: true, srv: b.srv } : null;
  if (!what || (code && !/^[A-Z0-9]{3,12}$/.test(code))) return send(res, 400, { error: 'Bad request.' });
  const bg = app.fairBackground(what);                            // registers the background work first, then answers
  send(res, 202, { ok: true });
  if (bg) await bg;                                                      // where there is no waitUntil the work finishes before the function ends
};
