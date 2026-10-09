// Sergey AI backend. See worker/README.md.
//
//   POST /        chat (also POST /chat). Body { messages: [{ role, content }] }
//                 -> 200 { text } or 4xx/5xx { error: { code, message } }
//   GET  /health  public, cheap, no outbound calls
//   GET  /diag    live checks; requires "Authorization: Bearer <DIAG_TOKEN>"

import { getConfig } from "./config.js";
import { ChatError, checkModelAccess, complete } from "./llm.js";
import { ERROR_MESSAGES, handleChat } from "./chat.js";
import { dropboxConfigured, getProfile, profileState } from "./profile.js";
import { getWebsite, websiteState } from "./website.js";
import { getUsage, log } from "./store.js";

function corsHeaders(origin, cfg) {
  const h = { Vary: "Origin" };
  if (origin && cfg.allowedOrigins.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function json(data, status, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function errorResponse(code, status, headers) {
  return json({ error: { code, message: ERROR_MESSAGES[code] || ERROR_MESSAGES.internal_error } }, status, headers);
}

function version(env) {
  return env.CF_VERSION_METADATA?.id || "dev";
}

function health(env, cfg) {
  const p = profileState();
  const w = websiteState();
  return {
    ok: true,
    service: "Sergey AI",
    version: version(env),
    time: new Date().toISOString(),
    ai_configured: Boolean(env.OPENAI_API_KEY),
    model: cfg.OPENAI_MODEL,
    dropbox_configured: dropboxConfigured(env),
    // Last known state in this isolate only; "unknown" until a chat request runs.
    profile: p.profile ? (p.lastError ? "stale" : "ok") : p.lastError ? "error" : "unknown",
    website: w.snapshot ? (w.lastError ? "partial" : "ok") : "unknown",
  };
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

function iso(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

async function diag(request, env, ctx, cfg) {
  const url = new URL(request.url);
  if (url.searchParams.get("refresh") === "1" && websiteState().snapshot) websiteState().snapshot.nextRefreshAt = 0;

  const [profile, website, modelAccess, usage] = await Promise.all([
    getProfile(env, { ...cfg, PROFILE_CHECK_SECONDS: 0 }, ctx),
    getWebsite(env, cfg, ctx),
    checkModelAccess(env, cfg),
    getUsage(env),
  ]);

  let probe = "skipped (add ?ai=probe to send a tiny real request, costs a fraction of a cent)";
  if (url.searchParams.get("ai") === "probe") {
    try {
      const r = await complete(env, cfg, [{ role: "user", content: "Reply with the single word: ok" }], { maxTokens: 64 });
      probe = { ok: true, reply: r.text.slice(0, 40), usage: r.usage };
    } catch (err) {
      probe = { ok: false, code: err.code || "error", detail: err.detail || String(err) };
    }
  }

  const cost =
    (usage.input_tokens - usage.cached_tokens) * cfg.PRICE_INPUT_PER_M +
    usage.cached_tokens * cfg.PRICE_CACHED_INPUT_PER_M +
    usage.output_tokens * cfg.PRICE_OUTPUT_PER_M;

  const lastUpdatedLine = profile.text?.match(/^\*\*Last updated:\*\*.*$/m)?.[0] || null;

  return {
    time: new Date().toISOString(),
    version: version(env),
    config: {
      model: cfg.OPENAI_MODEL,
      ai_host: new URL(cfg.OPENAI_BASE_URL).host,
      reasoning_effort: cfg.OPENAI_REASONING_EFFORT || "(not sent)",
      max_output_tokens: cfg.MAX_OUTPUT_TOKENS,
      dropbox_path: cfg.DROPBOX_PROFILE_PATH,
      profile_check_seconds: cfg.PROFILE_CHECK_SECONDS,
      website_ttl_seconds: cfg.WEBSITE_TTL_SECONDS,
      daily_chat_limit: cfg.DAILY_CHAT_LIMIT,
      allowed_origins: cfg.allowedOrigins,
    },
    bindings: { kv: Boolean(env.CACHE), rate_limit_ip: Boolean(env.RL_IP), rate_limit_global: Boolean(env.RL_GLOBAL) },
    secrets_present: {
      OPENAI_API_KEY: Boolean(env.OPENAI_API_KEY),
      DROPBOX_APP_KEY: Boolean(env.DROPBOX_APP_KEY),
      DROPBOX_APP_SECRET: Boolean(env.DROPBOX_APP_SECRET),
      DROPBOX_REFRESH_TOKEN: Boolean(env.DROPBOX_REFRESH_TOKEN),
    },
    profile: {
      status: profile.status,
      error: profile.error || null,
      revision: profile.rev || null,
      dropbox_modified: profile.serverModified || null,
      downloaded_at: iso(profile.loadedAt),
      confirmed_current_at: iso(profile.verifiedAt),
      age_seconds: profile.ageSeconds ?? null,
      chars_sent_to_model: profile.text?.length || 0,
      text_sha256_16: profile.text ? await sha256(profile.text) : null,
      last_updated_line: lastUpdatedLine,
    },
    website: {
      status: website.status,
      fetched_at: iso(website.fetchedAt),
      pages: website.pages.map((p) => ({
        url: p.url,
        ok: p.ok,
        title: p.title,
        chars: p.text.length,
        fetched_at: iso(p.fetchedAt),
        error: p.error || null,
      })),
    },
    ai: { model_access: modelAccess, probe },
    usage_today: { ...usage, estimated_cost_usd: Number((cost / 1e6).toFixed(4)) },
  };
}

export default {
  async fetch(request, env, ctx) {
    const cfg = getConfig(env);
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, cfg);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

      if (request.method === "GET" && (path === "/" || path === "/health")) {
        return json(health(env, cfg), 200, cors);
      }

      if (request.method === "GET" && path === "/diag") {
        if (!env.DIAG_TOKEN) return errorResponse("not_found", 404, cors);
        if (env.RL_IP) {
          const ip = request.headers.get("CF-Connecting-IP") || "unknown";
          if (!(await env.RL_IP.limit({ key: `diag:${ip}` })).success) return errorResponse("rate_limited", 429, cors);
        }
        const auth = request.headers.get("Authorization") || "";
        if (!safeEqual(auth, `Bearer ${env.DIAG_TOKEN}`)) return errorResponse("not_found", 404, cors);
        return json(await diag(request, env, ctx, cfg), 200);
      }

      if (request.method === "POST" && (path === "/" || path === "/chat")) {
        if (!origin || !cfg.allowedOrigins.includes(origin)) {
          log("chat_rejected", { code: "forbidden_origin", origin: origin || "-" });
          return errorResponse("forbidden_origin", 403, cors);
        }
        return json(await handleChat(request, env, ctx, cfg), 200, cors);
      }

      return errorResponse("not_found", 404, cors);
    } catch (err) {
      if (err instanceof ChatError) {
        log("chat_error", { code: err.code, status: err.status, detail: err.detail });
        return errorResponse(err.code, err.status, cors);
      }
      log("internal_error", { error: String(err?.stack || err).slice(0, 500) });
      return errorResponse("internal_error", 500, cors);
    }
  },
};
