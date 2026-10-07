// Tiny JSON key-value store. Uses Supabase (PostgREST) when SUPABASE_URL + SUPABASE_SERVICE_KEY are set,
// otherwise process memory (fine for local dev; resets on restart).
const BASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';
const mem = new Map(); // key -> { v: json string, exp }
const DBL = +process.env.DEV_DB_LATENCY_MS || 0;                       // dev only: simulate database round trips
const dbWait = () => (DBL ? new Promise((r) => setTimeout(r, DBL)) : null);

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
  await dbWait();
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

// Several keys in one round trip; returns their values in the same order (null when missing/expired).
// With `field`, returns only that top-level field of each value (fetched alone, so big values stay on the server).
exports.getMany = async (keys, field) => {
  if (field && !/^\w+$/.test(field)) throw new Error('bad field');
  const one = async (k) => { const v = await exports.get(k); return v && field ? v[field] : v; };
  if (!exports.persistent) return Promise.all(keys.map(one));
  await dbWait();
  const list = keys.map((k) => '"' + String(k).replace(/["\\]/g, '') + '"').join(',');
  let rows;
  try { rows = (await rest(`?key=in.(${encodeURIComponent(list)})&select=key,value${field ? ':value->' + field : ''},expires_at`)) || []; }
  catch (e) { console.error('getMany failed, reading keys one by one:', e.message); return Promise.all(keys.map(one)); }
  const now = new Date(), by = new Map(rows.map((r) => [r.key, r]));
  return keys.map((k) => { const r = by.get(k); return !r || (r.expires_at && new Date(r.expires_at) < now) ? null : r.value; });
};

exports.set = async (key, val, ttlSec) => {
  await dbWait();
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
  await dbWait();
  if (exports.casBroken) { await exports.set(key, val, ttlSec); return true; }
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

// Insert only if the key does not exist yet (no read-before-write needed). Returns false on a clash.
exports.create = async (key, val, ttlSec) => {
  await dbWait();
  const expires_at = ttlSec ? new Date(Date.now() + ttlSec * 1000).toISOString() : null;
  if (exports.persistent) {
    try { await rest('', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ key, value: val, expires_at }) }); return true; }
    catch (e) { if (/ 409:/.test(e.message)) return false; throw e; }
  }
  const e = mem.get(key);
  if (e && !(e.exp && e.exp < Date.now())) return false;
  mem.set(key, { v: JSON.stringify(val), exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
  return true;
};

exports.del = async (key) => {
  await dbWait();
  if (exports.persistent) return rest(`?key=eq.${encodeURIComponent(key)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  mem.delete(key);
};
