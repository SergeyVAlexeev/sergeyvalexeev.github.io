// Tests for the pre-flight checks in scripts/dropbox-auth.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { secretNames, waitForStartRedirect, AUTHORIZE_PREFIX } from "../scripts/dropbox-auth.mjs";
import { createEnv, createCtx, resetAll } from "./helpers.mjs";

test("secretNames parses wrangler's JSON list, ignoring surrounding log lines", () => {
  const out = 'Proxy warning\n[\n  { "name": "DIAG_TOKEN", "type": "secret_text" },\n  { "name": "DROPBOX_APP_KEY", "type": "secret_text" }\n]\n';
  assert.deepEqual(secretNames(out), ["DIAG_TOKEN", "DROPBOX_APP_KEY"]);
  assert.deepEqual(secretNames("[]"), []);
  assert.equal(secretNames("✘ [ERROR] Authentication error"), null);
  assert.equal(secretNames("[not json]"), null);
});

function responder(sequence) {
  let i = 0;
  return async () => {
    const next = sequence[Math.min(i++, sequence.length - 1)];
    if (next instanceof Error) throw next;
    return new Response(null, { status: next.status, headers: next.location ? { Location: next.location } : {} });
  };
}

test("waitForStartRedirect succeeds once the endpoint redirects to Dropbox", async () => {
  const fetchImpl = responder([{ status: 404 }, new TypeError("fetch failed"), { status: 302, location: `${AUTHORIZE_PREFIX}?client_id=x` }]);
  const r = await waitForStartRedirect("https://staging.example/oauth/dropbox/start?state=s", { fetchImpl, intervalMs: 1, timeoutMs: 1000 });
  assert.deepEqual(r, { ok: true, lastStatus: "302" });
});

test("waitForStartRedirect gives up after the bounded wait and reports the last status only", async () => {
  const r = await waitForStartRedirect("https://staging.example/x", {
    fetchImpl: responder([{ status: 404 }]),
    intervalMs: 5,
    timeoutMs: 30,
  });
  assert.equal(r.ok, false);
  assert.equal(r.lastStatus, "404");
  const other = await waitForStartRedirect("https://staging.example/x", {
    fetchImpl: responder([{ status: 302, location: "https://evil.example/" }]),
    intervalMs: 5,
    timeoutMs: 20,
  });
  assert.equal(other.ok, false); // a redirect elsewhere is not "ready"
});

test("readiness check agrees with the real Worker: 404 without app key/state, ready with both", async () => {
  resetAll();
  const viaWorker = (env) => (url, init) => worker.fetch(new Request(url, init), env, createCtx());
  const url = "https://alexeev-website-chat-staging.example/oauth/dropbox/start?state=st";
  const opts = { intervalMs: 1, timeoutMs: 10 };

  const noKey = await waitForStartRedirect(url, { ...opts, fetchImpl: viaWorker(createEnv({ DROPBOX_APP_KEY: "", DROPBOX_OAUTH_STATE: "st" })) });
  assert.deepEqual(noKey, { ok: false, lastStatus: "404" });

  const noState = await waitForStartRedirect(url, { ...opts, fetchImpl: viaWorker(createEnv()) });
  assert.equal(noState.ok, false);

  const ready = await waitForStartRedirect(url, { ...opts, fetchImpl: viaWorker(createEnv({ DROPBOX_OAUTH_STATE: "st" })) });
  assert.deepEqual(ready, { ok: true, lastStatus: "302" });
});
