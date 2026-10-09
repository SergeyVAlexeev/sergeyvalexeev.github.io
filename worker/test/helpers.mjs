// Shared mocks: a fake upstream world (Dropbox, website, OpenAI), a KV
// namespace, rate limiters and an execution context.

import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { resetProfileState } from "../src/profile.js";
import { resetWebsiteState } from "../src/website.js";
import { resetMemoryUsage } from "../src/store.js";

const SITE_ROOT = new URL("../../", import.meta.url);

export const SECRETS = {
  OPENAI_API_KEY: "sk-test-OPENAI-SECRET-123456789",
  DROPBOX_APP_KEY: "dbx-app-key-TEST",
  DROPBOX_APP_SECRET: "dbx-app-secret-TEST-SECRET",
  DROPBOX_REFRESH_TOKEN: "dbx-refresh-token-TEST-SECRET",
  DIAG_TOKEN: "diag-token-TEST-SECRET",
};

export const PROFILE_V1 = `# Profile - Sergey Alexeev

**Last updated:** 18 September 2026

## Research areas

- Drug policy
- Test fact: favourite estimator is the Wald estimator

## Referees / collaboration contacts

- Referee One, Example University, referee.one@example.edu
- Referee Two, +61 400 000 000

---

**Profile maintenance rule:** keep this current.
`;

export const PROFILE_V2 = PROFILE_V1.replace("Wald estimator", "synthetic control estimator").replace(
  "18 September 2026",
  "9 October 2026",
);

// Serve the real pages from this repository as the "live website".
export function sitePage(url) {
  const path = new URL(url).pathname.replace(/^\//, "");
  return readFileSync(new URL(path.endsWith("/") || path === "" ? `${path}index.html` : path, SITE_ROOT), "utf8");
}

export function createWorld() {
  const world = {
    profile: { rev: "a1b2c3d4e", text: PROFILE_V1, modified: "2026-09-18T07:59:52Z" },
    dropboxDown: false,
    tokenRevoked: false,
    accessTokenExpired: false,
    websiteDown: false,
    openai: { mode: "ok", reply: "Sergey works on causal inference." },
    calls: { token: 0, metadata: 0, download: 0, website: 0, openai: 0 },
    openaiRequests: [],
    issuedTokens: 0,
  };

  world.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = new Headers(init.headers || {});
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    if (url === "https://api.dropboxapi.com/oauth2/token") {
      world.calls.token++;
      if (world.dropboxDown) return new Response("upstream error", { status: 503 });
      const form = new URLSearchParams(String(init.body));
      if (world.tokenRevoked || form.get("refresh_token") !== SECRETS.DROPBOX_REFRESH_TOKEN) {
        return json({ error: "invalid_grant", error_description: "refresh token is invalid or revoked" }, 400);
      }
      world.accessTokenExpired = false;
      return json({ access_token: `sl.access-${++world.issuedTokens}`, token_type: "bearer", expires_in: 14400 });
    }

    if (url.startsWith("https://api.dropboxapi.com/2/files/get_metadata")) {
      world.calls.metadata++;
      if (world.dropboxDown) return new Response("upstream error", { status: 503 });
      if (world.accessTokenExpired) return json({ error_summary: "expired_access_token/" }, 401);
      const { path } = JSON.parse(init.body);
      if (path !== "/Job hunting/PROFILE.md") return json({ error_summary: "path/not_found/" }, 409);
      return json({
        ".tag": "file",
        name: "PROFILE.md",
        rev: world.profile.rev,
        server_modified: world.profile.modified,
        size: world.profile.text.length,
      });
    }

    if (url === "https://content.dropboxapi.com/2/files/download") {
      world.calls.download++;
      if (world.dropboxDown) return new Response("upstream error", { status: 503 });
      const arg = JSON.parse(headers.get("Dropbox-API-Arg"));
      if (arg.path !== `rev:${world.profile.rev}`) return json({ error_summary: "path/not_found/" }, 409);
      return new Response(world.profile.text, { status: 200 });
    }

    if (url.startsWith("https://www.alexeev.pw/")) {
      world.calls.website++;
      if (world.websiteDown) throw new TypeError("fetch failed");
      try {
        return new Response(sitePage(url), { status: 200, headers: { "Content-Type": "text/html" } });
      } catch {
        return new Response("not found", { status: 404 });
      }
    }

    if (url === "https://api.openai.com/v1/chat/completions") {
      world.calls.openai++;
      const body = JSON.parse(init.body);
      world.openaiRequests.push({ body, auth: headers.get("Authorization") });
      const m = world.openai.mode;
      if (m === "quota") {
        return json(
          {
            error: {
              message: "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
              type: "insufficient_quota",
              param: null,
              code: "credit_balance_exhausted",
            },
          },
          429,
        );
      }
      if (m === "ratelimit") return json({ error: { message: "Rate limit reached", type: "requests", code: null } }, 429);
      if (m === "auth") return json({ error: { message: "Incorrect API key provided: sk-test-****", type: "invalid_request_error", code: "invalid_api_key" } }, 401);
      if (m === "server") return new Response("<html>bad gateway</html>", { status: 502 });
      if (m === "hang") {
        // Node's AbortSignal.timeout timer is unref'd; keep the loop alive until it fires.
        const keepAlive = setTimeout(() => {}, 10_000);
        await new Promise((resolve, reject) =>
          init.signal?.addEventListener("abort", () => {
            clearTimeout(keepAlive);
            reject(init.signal.reason);
          }),
        );
      }
      if (m === "empty") return json({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: {} });
      return json({
        model: body.model,
        choices: [{ message: { role: "assistant", content: world.openai.reply }, finish_reason: m === "length" ? "length" : "stop" }],
        usage: { prompt_tokens: 15000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 12000 } },
      });
    }

    if (url.startsWith("https://api.openai.com/v1/models/")) {
      return world.openai.mode === "auth" ? json({ error: { code: "invalid_api_key" } }, 401) : json({ id: "gpt-6-luna" });
    }

    throw new Error(`Unexpected fetch in test: ${url}`);
  };
  return world;
}

export function createKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

export function createRateLimiter(limit) {
  const counts = new Map();
  return {
    async limit({ key }) {
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
}

export function createEnv(overrides = {}) {
  return { ...SECRETS, CACHE: createKV(), ...overrides };
}

export function createCtx() {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p), settle: () => Promise.all(pending) };
}

export function resetAll() {
  resetProfileState();
  resetWebsiteState();
  resetMemoryUsage();
}

export async function chat(env, messages, { origin = "https://www.alexeev.pw", ip = "203.0.113.7", rawBody } = {}) {
  const ctx = createCtx();
  const req = new Request("https://worker.example/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "CF-Connecting-IP": ip },
    body: rawBody ?? JSON.stringify({ messages }),
  });
  const res = await worker.fetch(req, env, ctx);
  await ctx.settle();
  return { status: res.status, body: await res.json(), headers: res.headers };
}

export async function get(env, path, headers = {}) {
  const ctx = createCtx();
  const res = await worker.fetch(new Request(`https://worker.example${path}`, { headers }), env, ctx);
  await ctx.settle();
  return { status: res.status, text: await res.text() };
}

export function lastSystemPrompt(world) {
  const req = world.openaiRequests.at(-1);
  return req.body.messages[0].content;
}

export function captureLogs() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  return { lines, restore: () => (console.log = original) };
}
