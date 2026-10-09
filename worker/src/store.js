// Thin wrappers around the optional KV binding `CACHE`.
// KV holds only last-good snapshots (profile, website) and a daily usage
// counter. The Worker still runs without it, with in-memory caching only.

export async function kvGet(env, key) {
  if (!env.CACHE) return null;
  try {
    return await env.CACHE.get(key, "json");
  } catch (err) {
    log("kv_read_error", { key, error: String(err) });
    return null;
  }
}

export async function kvPut(env, key, value, options) {
  if (!env.CACHE) return false;
  try {
    await env.CACHE.put(key, JSON.stringify(value), options);
    return true;
  } catch (err) {
    log("kv_write_error", { key, error: String(err) });
    return false;
  }
}

// --- Daily usage counter (approximate) ---
// KV is eventually consistent, so concurrent requests can undercount. The
// in-memory counter keeps a single busy isolate accurate.

const memUsage = { day: "", requests: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0 };

export function today(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function emptyUsage(day) {
  return { day, requests: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0 };
}

export async function getUsage(env, now = Date.now()) {
  const day = today(now);
  if (memUsage.day !== day) Object.assign(memUsage, emptyUsage(day));
  const stored = (await kvGet(env, `usage:${day}`)) || emptyUsage(day);
  return stored.requests >= memUsage.requests ? { ...stored, day } : { ...memUsage };
}

export async function addUsage(env, usage, now = Date.now()) {
  const current = await getUsage(env, now);
  const next = {
    day: current.day,
    requests: current.requests + 1,
    input_tokens: current.input_tokens + (usage.input_tokens || 0),
    cached_tokens: current.cached_tokens + (usage.cached_tokens || 0),
    output_tokens: current.output_tokens + (usage.output_tokens || 0),
  };
  Object.assign(memUsage, next);
  await kvPut(env, `usage:${next.day}`, next, { expirationTtl: 60 * 60 * 24 * 40 });
  return next;
}

export function resetMemoryUsage() {
  Object.assign(memUsage, emptyUsage(""));
}

// Constant-time string comparison for tokens.
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Structured log line. Never pass secrets or message contents here.
export function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}
