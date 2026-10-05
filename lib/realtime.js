// Push events to browsers so opponents see moves immediately instead of waiting for a poll.
//  - "supabase": Supabase Realtime broadcast (production on Vercel; needs SUPABASE_ANON_KEY for the browser)
//  - "sse":      Server-Sent Events from this process (local `node server.js`)
//  - "none":     no push; the client simply polls
// Events are hints: clients still verify against the authoritative game state on the server.
const crypto = require('crypto');
const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ANON = process.env.SUPABASE_ANON_KEY || '';
const mode = URL_ && KEY && ANON ? 'supabase' : process.env.VERCEL ? 'none' : 'sse';

const subs = new Map(); // topic -> Set<res> (sse mode)

async function publish(topic, event, payload) {
  if (mode === 'sse') {
    const set = subs.get(topic);
    if (set) for (const res of set) res.write(`event: ${event}\ndata: ${JSON.stringify(payload || {})}\n\n`);
    return;
  }
  if (mode !== 'supabase') return;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1500);
    await fetch(`${URL_}/realtime/v1/api/broadcast`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { apikey: KEY, ...(KEY.startsWith('eyJ') ? { Authorization: 'Bearer ' + KEY } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ topic, event, payload: payload || {}, private: false }] }),
    });
    clearTimeout(timer);
  } catch (e) { /* push is best-effort; polling still delivers the change */ }
}

// GET /api/events?topic=... (sse mode only)
function sseHandler(req, res) {
  const topic = new URL(req.url, 'http://x').searchParams.get('topic') || '';
  if (mode !== 'sse' || !/^(room|u|lobby)[:\w-]*$/.test(topic)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  if (res.socket) res.socket.setNoDelay(true);               // small event packets must not wait for TCP batching
  res.write('retry: 1500\n\n');
  if (!subs.has(topic)) subs.set(topic, new Set());
  subs.get(topic).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); const s = subs.get(topic); if (s) { s.delete(res); if (!s.size) subs.delete(topic); } });
}

// A private-ish channel name per user, derived from their secret token.
const userTopic = (u) => 'u:' + crypto.createHash('sha256').update(u.token + ':' + u.name).digest('hex').slice(0, 24);
const config = () => ({ rt: mode, url: mode === 'supabase' ? URL_ : null, anon: mode === 'supabase' ? ANON : null });

module.exports = { mode, publish, sseHandler, userTopic, config };
