// Safe Return reader-feedback Worker.
// Separate from the "Ask Sergey AI" Worker in /worker: own code, own KV namespace, own secrets.
//
// Public surface : POST /feedback, GET /health. There is NO public read endpoint,
//                  so nothing submitted can appear on the website.
// Moderation     : GET/POST/DELETE /admin/feedback... with a bearer token. "approved" only
//                  marks a record as reviewed; publishing, if ever wanted, is a manual act.
// Privacy        : no IP address or User-Agent is stored. The IP is only hashed together with a
//                  secret salt and the current date, to count requests for rate limiting (1 hour TTL).
//                  Email is stored only when the reader opts in. Records expire automatically.

const MAX_BODY = 8 * 1024;
const MAX_COMMENTS = 2000;
const MAX_STOPPED = 200;
const CHOICES = new Set(['yes', 'maybe', 'no']);
const CONSENT_TEXT = 'Email me about this novel\u2019s progress'; // must match the checkbox label in index.html
const CONSENT_VERSION = 1;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra },
  });

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || 'https://www.alexeev.pw').split(',').map((s) => s.trim()).filter(Boolean);
}

function cors(request, env) {
  const origin = request.headers.get('origin');
  if (origin && allowedOrigins(env).includes(origin)) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'origin',
    };
  }
  return {};
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Spam controls fail closed: outside local dev (DEV=1) the Worker refuses to accept
// submissions unless Turnstile and the rate-limit salt are configured.
const misconfigured = (env) => env.DEV !== '1' && (!env.TURNSTILE_SECRET || !env.RATE_SALT);

async function rateLimited(request, env) {
  const limit = Number(env.RATE_LIMIT_PER_HOUR || 5);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  const key = 'rl:' + (await sha256Hex(`${env.RATE_SALT || 'dev'}|${day}|${ip}`));
  // Preferred: Workers Rate Limiting binding (add "ratelimits" to wrangler.jsonc). KV counter is the fallback;
  // it is eventually consistent and best-effort only.
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === 'function') {
    return !(await env.RATE_LIMITER.limit({ key })).success;
  }
  const used = Number((await env.FEEDBACK.get(key)) || 0);
  if (used >= limit) return true;
  await env.FEEDBACK.put(key, String(used + 1), { expirationTtl: 3600 });
  return false;
}

async function turnstileOk(token, request, env) {
  if (!env.TURNSTILE_SECRET) return env.DEV === '1'; // only skippable in local dev
  if (!token) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) form.append('remoteip', ip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const j = await r.json();
    if (!j.success) return false;
    if (env.TURNSTILE_HOSTNAME && j.hostname !== env.TURNSTILE_HOSTNAME) return false;
    return true;
  } catch {
    return false;
  }
}

function clean(s, max) {
  return String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '').trim().slice(0, max);
}

async function handleSubmit(request, env, headers) {
  if (!(request.headers.get('content-type') || '').includes('application/json')) return json({ error: 'Unsupported content type.' }, 415, headers);
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins(env).includes(origin)) return json({ error: 'Origin not allowed.' }, 403, headers);

  if (misconfigured(env)) return json({ error: 'Feedback is not available right now.' }, 503, headers);
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return json({ error: 'Submission too large.' }, 413, headers);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'Submission too large.' }, 413, headers);
  let d;
  try { d = JSON.parse(raw); } catch { return json({ error: 'Invalid JSON.' }, 400, headers); }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return json({ error: 'Invalid submission.' }, 400, headers);

  // Silent drops for bots: same success response, nothing stored.
  const ok = json({ ok: true, message: 'Thank you. Your response has been received for private review.' }, 200, headers);
  if (clean(d.website, 100)) return ok; // honeypot
  if (!(Number(d.elapsed_ms) >= 4000)) return ok; // answered implausibly fast

  if (d.privacy_ack !== true) return json({ error: 'Please confirm you have read the privacy notice.' }, 400, headers);
  const choice = clean(d.continue, 10);
  if (!CHOICES.has(choice)) return json({ error: 'Please choose whether you would want to keep reading.' }, 400, headers);
  const comments = clean(d.comments, MAX_COMMENTS);
  const stopped = clean(d.stopped_at, MAX_STOPPED);
  let email = null;
  if (d.email_optin === true) {
    email = clean(d.email, 254);
    if (!EMAIL_RE.test(email)) return json({ error: 'Please enter a valid email address, or untick the email option.' }, 400, headers);
  }

  if (!(await turnstileOk(d.turnstile_token, request, env))) return json({ error: 'Spam check failed. Please reload and try again.' }, 403, headers);
  if (await rateLimited(request, env)) return json({ error: 'Too many submissions. Please try again later.' }, 429, headers);

  const id = crypto.randomUUID();
  const created = new Date().toISOString();
  const days = Number(env.RETENTION_DAYS || 365);
  const record = {
    id, created, status: 'pending', continue: choice, stopped_at: stopped, comments, email_optin: Boolean(email), email,
    email_consent_text: email ? CONSENT_TEXT : null, email_consent_version: email ? CONSENT_VERSION : null, email_consent_at: email ? created : null,
  };
  // Absolute expiry from the creation time, so moderation never extends retention.
  await env.FEEDBACK.put(`fb:${created}:${id}`, JSON.stringify(record), { expiration: Math.floor(Date.parse(created) / 1000) + Math.max(60, days * 86400) });
  return json({ ok: true, ref: id, message: 'Thank you. Your response has been received for private review.' }, 200, headers);
}

async function handleAdmin(request, env, url) {
  if (!env.ADMIN_TOKEN) return json({ error: 'Not found.' }, 404);
  const auth = request.headers.get('authorization') || '';
  if (!safeEqual(auth, `Bearer ${env.ADMIN_TOKEN}`)) return json({ error: 'Unauthorized.' }, 401);
  const parts = url.pathname.split('/').filter(Boolean); // admin, feedback, [id]
  if (parts[1] !== 'feedback') return json({ error: 'Not found.' }, 404);

  if (parts.length === 2 && request.method === 'GET') {
    const want = url.searchParams.get('status'); // pending | approved | rejected | (all)
    const out = [];
    let cursor;
    do {
      const page = await env.FEEDBACK.list({ prefix: 'fb:', cursor });
      for (const k of page.keys) {
        const raw = await env.FEEDBACK.get(k.name);
        if (!raw) continue; // expired between list and get
        const v = JSON.parse(raw);
        if (!want || v.status === want) out.push({ key: k.name, ...v });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return json({ count: out.length, items: out });
  }

  const id = parts[2];
  if (!id) return json({ error: 'Not found.' }, 404);
  let key, cursor;
  do {
    const page = await env.FEEDBACK.list({ prefix: 'fb:', cursor });
    key = page.keys.map((k) => k.name).find((n) => n.endsWith(':' + id));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (!key && cursor);
  if (!key) return json({ error: 'Not found.' }, 404);

  if (request.method === 'DELETE') { await env.FEEDBACK.delete(key); return json({ ok: true, deleted: id }); }
  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || !['approve', 'reject'].includes(body.action)) return json({ error: 'action must be approve or reject' }, 400);
    const raw = await env.FEEDBACK.get(key);
    if (!raw) return json({ error: 'Not found.' }, 404);
    const rec = JSON.parse(raw);
    rec.status = body.action === 'approve' ? 'approved' : 'rejected';
    rec.moderated = new Date().toISOString();
    const days = Number(env.RETENTION_DAYS || 365);
    const exp = Math.floor(Date.parse(rec.created) / 1000) + days * 86400;
    if (exp - Math.floor(Date.now() / 1000) < 60) { await env.FEEDBACK.delete(key); return json({ ok: true, id, expired: true }); } // KV minimum TTL is 60 s
    await env.FEEDBACK.put(key, JSON.stringify(rec), { expiration: exp });
    return json({ ok: true, id, status: rec.status });
  }
  return json({ error: 'Method not allowed.' }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = cors(request, env);
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (url.pathname === '/health') return json({ ok: true, service: 'safe-return-feedback' }, 200, headers);
      if (url.pathname === '/feedback' && request.method === 'POST') return await handleSubmit(request, env, headers);
      if (url.pathname.startsWith('/admin/')) return await handleAdmin(request, env, url);
      return json({ error: 'Not found.' }, 404, headers);
    } catch (err) {
      console.error('feedback worker error', err && err.message);
      return json({ error: 'Server error. Please try again later.' }, 500, headers);
    }
  },
};
