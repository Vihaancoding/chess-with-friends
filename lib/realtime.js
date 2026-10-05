// Push events to browsers so opponents see moves immediately instead of waiting for a poll.
//  - "supabase": Supabase Realtime broadcast (production on Vercel; needs SUPABASE_ANON_KEY for the browser).
//                One websocket per browser; channels are joined/left on that same socket.
//  - "sse":      Server-Sent Events from this process (local `node server.js`). One connection per browser,
//                topics are added/removed on it without reconnecting.
//  - "none":     no push; the client polls.
// Events are hints: the server state is authoritative and clients resync on any gap.
const crypto = require('crypto');
const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ANON = process.env.SUPABASE_ANON_KEY || '';
const mode = URL_ && KEY && ANON ? 'supabase' : process.env.VERCEL ? 'none' : 'sse';

const TOPIC_RE = /^(room|u|lobby)[:\w-]*$/;
const conns = new Map();   // connId -> { res, topics:Set, gc }
const byTopic = new Map(); // topic -> Set<connId>

function publish(topic, event, payload) {
  const msg = JSON.stringify(payload || {});
  if (mode === 'sse') {
    const ids = byTopic.get(topic);
    if (ids) { const frame = `event: ${event}\ndata: ${msg}\n\n`; for (const id of ids) { const c = conns.get(id); if (c && c.res) c.res.write(frame); } }
    return Promise.resolve();
  }
  if (mode !== 'supabase') return Promise.resolve();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  return fetch(`${URL_}/realtime/v1/api/broadcast`, {
    method: 'POST', signal: ctl.signal,
    headers: { apikey: KEY, ...(KEY.startsWith('eyJ') ? { Authorization: 'Bearer ' + KEY } : {}), 'Content-Type': 'application/json' },
    body: `{"messages":[{"topic":${JSON.stringify(topic)},"event":${JSON.stringify(event)},"payload":${msg},"private":false}]}`,
  }).catch(() => {}).finally(() => clearTimeout(timer));   // push is best-effort; heartbeats still deliver the change
}

function addTopic(id, t) { if (!TOPIC_RE.test(t)) return; const c = conns.get(id); c.topics.add(t); if (!byTopic.has(t)) byTopic.set(t, new Set()); byTopic.get(t).add(id); }
function delTopic(id, t) { const c = conns.get(id); if (c) c.topics.delete(t); const s = byTopic.get(t); if (s) { s.delete(id); if (!s.size) byTopic.delete(t); } }

// GET  /api/events?conn=ID&topics=a,b   -> the stream (reconnecting with the same conn keeps its topics)
// POST /api/events?conn=ID&add=a&remove=b -> change topics on the open stream
function sseHandler(req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  if (mode !== 'sse') { res.writeHead(404); return res.end(); }
  const id = (q.get('conn') || crypto.randomUUID()).slice(0, 40);
  if (!conns.has(id)) conns.set(id, { res: null, topics: new Set(), gc: null });
  const c = conns.get(id);
  const list = (k) => (q.get(k) || '').split(',').filter(Boolean);
  if (req.method === 'POST') {
    list('add').forEach((t) => addTopic(id, t)); list('remove').forEach((t) => delTopic(id, t));
    res.writeHead(204); return res.end();
  }
  [...list('topics'), ...list('topic')].forEach((t) => addTopic(id, t));
  clearTimeout(c.gc);
  if (c.res) c.res.end();
  c.res = res;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  if (res.socket) res.socket.setNoDelay(true);
  res.write('retry: 1000\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    if (c.res === res) c.res = null;
    c.gc = setTimeout(() => { for (const t of [...c.topics]) delTopic(id, t); conns.delete(id); }, 30000);   // keep topics for a quick reconnect
  });
}

const userTopic = (u) => 'u:' + crypto.createHash('sha256').update(u.token + ':' + u.name).digest('hex').slice(0, 24);
const config = () => ({ rt: mode, url: mode === 'supabase' ? URL_ : null, anon: mode === 'supabase' ? ANON : null });
const stats = () => ({ conns: conns.size, topics: byTopic.size });

module.exports = { mode, publish, sseHandler, userTopic, config, stats };
