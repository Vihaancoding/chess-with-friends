// Tiny JSON key-value store. Uses Upstash Redis (REST) when configured, else process memory.
const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const mem = new Map(); // key -> { v: json string, exp }

async function cmd(args) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(args) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

exports.persistent = !!(URL_ && TOKEN);

exports.get = async (key) => {
  if (exports.persistent) {
    const v = await cmd(['GET', key]);
    return v == null ? null : JSON.parse(v);
  }
  const e = mem.get(key);
  if (!e) return null;
  if (e.exp && e.exp < Date.now()) { mem.delete(key); return null; }
  return JSON.parse(e.v);
};

exports.set = async (key, val, ttlSec) => {
  const s = JSON.stringify(val);
  if (exports.persistent) return cmd(ttlSec ? ['SET', key, s, 'EX', ttlSec] : ['SET', key, s]);
  mem.set(key, { v: s, exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
};

exports.del = async (key) => {
  if (exports.persistent) return cmd(['DEL', key]);
  mem.delete(key);
};
