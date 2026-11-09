import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

export function fakeKV() {
  const m = new Map();
  const ttl = new Map();
  const exp = new Map();
  return {
    m, ttl, exp,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v, opts) { m.set(k, v); ttl.set(k, opts && opts.expirationTtl); exp.set(k, opts && opts.expiration); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}
const ORIGIN = 'https://www.alexeev.pw';
const mkEnv = (over = {}) => ({ FEEDBACK: fakeKV(), ALLOWED_ORIGINS: ORIGIN, ADMIN_TOKEN: 'tok', RATE_SALT: 's', DEV: '1', ...over });
const good = { continue: 'yes', comments: 'Wanted to keep going.', stopped_at: '', privacy_ack: true, elapsed_ms: 20000, website: '' };
const post = (env, body, headers = {}) => worker.fetch(new Request('https://w.test/feedback', {
  method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': '1.2.3.4', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
}), env);
const feedbackKeys = (env) => [...env.FEEDBACK.m.keys()].filter((k) => k.startsWith('fb:'));

test('stores a valid submission as pending, without IP/UA, with a TTL', async () => {
  const env = mkEnv();
  const r = await post(env, good, { 'user-agent': 'secret-agent' });
  assert.equal(r.status, 200);
  const [k] = feedbackKeys(env);
  const rec = JSON.parse(env.FEEDBACK.m.get(k));
  assert.equal(rec.status, 'pending');
  assert.equal(rec.email, null);
  assert.ok(!JSON.stringify(rec).includes('1.2.3.4') && !JSON.stringify(rec).includes('secret-agent'));
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
});
test('retention TTL applied to records', async () => {
  const env = mkEnv({ RETENTION_DAYS: '30' });
  await post(env, good);
  const k = feedbackKeys(env)[0];
  const created = Date.parse(JSON.parse(env.FEEDBACK.m.get(k)).created) / 1000;
  assert.equal(env.FEEDBACK.exp.get(k), Math.floor(created) + 30 * 86400);
  const rl = [...env.FEEDBACK.m.keys()].find((x) => x.startsWith('rl:'));
  assert.equal(env.FEEDBACK.ttl.get(rl), 3600);
});
test('rejects disallowed or missing Origin', async () => {
  const env = mkEnv();
  assert.equal((await post(env, good, { origin: 'https://evil.example' })).status, 403);
  const r = await worker.fetch(new Request('https://w.test/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(good) }), env);
  assert.equal(r.status, 403);
  assert.equal(feedbackKeys(env).length, 0);
});
test('honeypot and too-fast submissions are silently dropped', async () => {
  const env = mkEnv();
  assert.equal((await post(env, { ...good, website: 'http://spam' })).status, 200);
  assert.equal((await post(env, { ...good, elapsed_ms: 500 })).status, 200);
  assert.equal(feedbackKeys(env).length, 0);
});
test('validation: choice, privacy ack, email, size, JSON, content type', async () => {
  const env = mkEnv();
  assert.equal((await post(env, { ...good, continue: 'banana' })).status, 400);
  assert.equal((await post(env, { ...good, privacy_ack: false })).status, 400);
  assert.equal((await post(env, { ...good, email_optin: true, email: 'nope' })).status, 400);
  assert.equal((await post(env, 'not json')).status, 400);
  assert.equal((await post(env, 'x'.repeat(9000))).status, 413);
  assert.equal((await post(env, good, { 'content-type': 'text/plain' })).status, 415);
  assert.equal(feedbackKeys(env).length, 0);
});
test('email stored only with opt-in; comments truncated', async () => {
  const env = mkEnv();
  await post(env, { ...good, email: 'a@b.com', email_optin: false, comments: 'z'.repeat(5000) });
  let rec = JSON.parse(env.FEEDBACK.m.get(feedbackKeys(env)[0]));
  assert.equal(rec.email, null); assert.equal(rec.comments.length, 2000);
  const env2 = mkEnv();
  await post(env2, { ...good, email: 'reader@example.org', email_optin: true });
  rec = JSON.parse(env2.FEEDBACK.m.get(feedbackKeys(env2)[0]));
  assert.equal(rec.email, 'reader@example.org');
});
test('rate limit: 6th submission in an hour is refused', async () => {
  const env = mkEnv({ RATE_LIMIT_PER_HOUR: '5' });
  for (let i = 0; i < 5; i++) assert.equal((await post(env, good)).status, 200);
  assert.equal((await post(env, good)).status, 429);
});
test('turnstile required when configured', async () => {
  const env = mkEnv({ TURNSTILE_SECRET: 'x' });
  assert.equal((await post(env, good)).status, 403);
});
test('fails closed (503) when Turnstile secret or salt missing outside DEV', async () => {
  assert.equal((await post(mkEnv({ DEV: '', TURNSTILE_SECRET: '' }), good)).status, 503);
  assert.equal((await post(mkEnv({ DEV: '', TURNSTILE_SECRET: 'x', RATE_SALT: '' }), good)).status, 503);
});
test('moderation does not extend retention; success returns a reference code; consent recorded', async () => {
  const env = mkEnv({ RETENTION_DAYS: '30' });
  const r = await (await post(env, { ...good, email_optin: true, email: 'a@b.com', consent_text: 'Email me' })).json();
  assert.ok(r.ref);
  const k = feedbackKeys(env)[0];
  const before = env.FEEDBACK.exp.get(k);
  await worker.fetch(new Request(`https://w.test/admin/feedback/${r.ref}`, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ action: 'approve' }) }), env);
  assert.equal(env.FEEDBACK.exp.get(k), before);
  const rec = JSON.parse(env.FEEDBACK.m.get(k));
  assert.equal(rec.email_consent_text, 'Email me about this novel\u2019s progress'); assert.equal(rec.email_consent_version, 1); assert.ok(rec.email_consent_at);
});
test('admin POST with null body is a 400, not a 500', async () => {
  const env = mkEnv();
  const r = await (await post(env, good)).json();
  const res = await worker.fetch(new Request(`https://w.test/admin/feedback/${r.ref}`, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: 'null' }), env);
  assert.equal(res.status, 400);
});
test('rate limiting binding is used when present', async () => {
  const env = mkEnv({ RATE_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal((await post(env, good)).status, 429);
});
test('no public read: GET /feedback and unauthenticated admin are refused', async () => {
  const env = mkEnv();
  await post(env, good);
  assert.equal((await worker.fetch(new Request('https://w.test/feedback'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://w.test/admin/feedback'), env)).status, 401);
  assert.equal((await worker.fetch(new Request('https://w.test/admin/feedback', { headers: { authorization: 'Bearer wrong' } }), env)).status, 401);
  assert.equal((await worker.fetch(new Request('https://w.test/admin/feedback'), mkEnv({ ADMIN_TOKEN: '' }))).status, 404);
});
test('admin can list, approve, reject and delete', async () => {
  const env = mkEnv();
  await post(env, good);
  const H = { authorization: 'Bearer tok' };
  const list = await (await worker.fetch(new Request('https://w.test/admin/feedback?status=pending', { headers: H }), env)).json();
  assert.equal(list.count, 1);
  const id = list.items[0].id;
  let r = await worker.fetch(new Request(`https://w.test/admin/feedback/${id}`, { method: 'POST', headers: H, body: JSON.stringify({ action: 'approve' }) }), env);
  assert.equal((await r.json()).status, 'approved');
  r = await worker.fetch(new Request(`https://w.test/admin/feedback/${id}`, { method: 'DELETE', headers: H }), env);
  assert.equal(r.status, 200);
  assert.equal(feedbackKeys(env).length, 0);
});
test('CORS preflight only grants allowed origins', async () => {
  const env = mkEnv();
  const ok = await worker.fetch(new Request('https://w.test/feedback', { method: 'OPTIONS', headers: { origin: ORIGIN } }), env);
  assert.equal(ok.status, 204); assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  const bad = await worker.fetch(new Request('https://w.test/feedback', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), env);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});
