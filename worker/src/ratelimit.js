// Request-rate limits: the Cloudflare rate-limit bindings (RL_IP, RL_GLOBAL)
// plus an in-memory sliding window per Worker isolate as a backstop. Both are
// per Cloudflare location and approximate; the daily KV cap in chat.js and the
// prepaid OpenAI balance (auto-recharge off) are the budget ceiling.

const windows = new Map(); // key -> timestamps (ms) within the last minute

function slide(key, limit, now) {
  const recent = (windows.get(key) || []).filter((t) => now - t < 60_000);
  windows.set(key, recent);
  return recent.length < limit ? recent : null;
}

export function resetRateLimits() {
  windows.clear();
}

// Returns null if allowed, otherwise a short reason for the logs.
export async function checkRateLimits(env, cfg, ip, now = Date.now()) {
  const ipWin = slide(`ip:${ip}`, cfg.RATE_LIMIT_PER_IP_PER_MIN, now);
  if (!ipWin) return "per-IP limit (memory)";
  const globalWin = slide("global", cfg.RATE_LIMIT_GLOBAL_PER_MIN, now);
  if (!globalWin) return "global limit (memory)";
  if (env.RL_IP && !(await env.RL_IP.limit({ key: `ip:${ip}` })).success) return "per-IP limit (binding)";
  if (env.RL_GLOBAL && !(await env.RL_GLOBAL.limit({ key: "chat" })).success) return "global limit (binding)";
  ipWin.push(now);
  globalWin.push(now);
  if (windows.size > 5000) {
    for (const [k, ts] of windows) if (!ts.length || now - ts[ts.length - 1] >= 60_000) windows.delete(k);
  }
  return null;
}

// DORMANT. Not bound or used. A staging deploy on 9 Oct 2026 created a
// Durable Object namespace for this class before that approach was paused;
// Cloudflare requires the class to stay exported until the namespace is
// removed with a `deleted_classes` migration. Production never had it.
export class Limiter {
  async fetch() {
    return new Response("unused", { status: 410 });
  }
}
