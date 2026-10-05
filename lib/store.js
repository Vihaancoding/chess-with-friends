// Tiny JSON key-value store. Uses Supabase (PostgREST) when SUPABASE_URL + SUPABASE_SERVICE_KEY are set,
// otherwise process memory (fine for local dev; resets on restart).
const BASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';
const mem = new Map(); // key -> { v: json string, exp }

exports.persistent = !!(BASE && KEY);

async function rest(path, opts = {}) {
  const r = await fetch(`${BASE}/rest/v1/kv${path}`, {
    ...opts,
    // New-style sb_secret_… keys go in `apikey` only; legacy JWT service_role keys also go in Authorization.
    headers: { apikey: KEY, ...(KEY.startsWith('eyJ') ? { Authorization: 'Bearer ' + KEY } : {}), 'Content-Type': 'application/json', ...opts.headers },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

exports.get = async (key) => {
  if (exports.persistent) {
    const rows = await rest(`?key=eq.${encodeURIComponent(key)}&select=value,expires_at`);
    const row = rows && rows[0];
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
    return row.value;
  }
  const e = mem.get(key);
  if (!e) return null;
  if (e.exp && e.exp < Date.now()) { mem.delete(key); return null; }
  return JSON.parse(e.v);
};

exports.set = async (key, val, ttlSec) => {
  if (exports.persistent) {
    return rest('', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key, value: val, expires_at: ttlSec ? new Date(Date.now() + ttlSec * 1000).toISOString() : null }),
    });
  }
  mem.set(key, { v: JSON.stringify(val), exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
};

// Compare-and-swap: write only if the stored value's "v" still equals prevV (undefined = no version yet).
// Returns false when someone else wrote first; the caller re-reads and retries.
exports.cas = async (key, val, prevV, ttlSec) => {
  const expires_at = ttlSec ? new Date(Date.now() + ttlSec * 1000).toISOString() : null;
  if (exports.persistent) {
    const vf = encodeURIComponent('value->>v') + (prevV == null ? '=is.null' : `=eq.${prevV}`);
    let rows;
    try {
      rows = await rest(`?key=eq.${encodeURIComponent(key)}&${vf}&select=key`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ value: val, expires_at }),
      });
    } catch (e) {
      // never let the safety check itself break games: fall back to a plain write
      console.error('cas failed, falling back to plain write:', e.message);
      await exports.set(key, val, ttlSec);
      return true;
    }
    return Array.isArray(rows) && rows.length === 1;
  }
  const e = mem.get(key);
  if (!e || (e.exp && e.exp < Date.now())) return false;
  const cur = JSON.parse(e.v);
  if ((cur.v == null ? null : cur.v) !== (prevV == null ? null : prevV)) return false;
  mem.set(key, { v: JSON.stringify(val), exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
  return true;
};

exports.del = async (key) => {
  if (exports.persistent) return rest(`?key=eq.${encodeURIComponent(key)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  mem.delete(key);
};
