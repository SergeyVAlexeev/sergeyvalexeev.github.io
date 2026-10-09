// Calls an OpenAI-compatible Chat Completions endpoint and maps failures to
// stable error codes the frontend understands.

// OpenAI 429 codes that mean "no money", as opposed to "slow down".
const BILLING_CODES = new Set([
  "credit_balance_exhausted",
  "insufficient_quota",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "billing_hard_limit_reached",
]);

export class ChatError extends Error {
  constructor(code, status, detail) {
    super(code);
    this.code = code;
    this.status = status;
    this.detail = detail; // for logs only; never sent to the browser
  }
}

export function classifyProviderError(status, body) {
  const err = body?.error || {};
  const code = String(err.code || "");
  const type = String(err.type || "");
  const detail = `HTTP ${status} type=${type || "-"} code=${code || "-"}`;
  if (BILLING_CODES.has(code) || type === "insufficient_quota") {
    return new ChatError("ai_credit_exhausted", 503, detail);
  }
  if (status === 429) return new ChatError("ai_busy", 503, detail);
  if (status === 401 || status === 403) return new ChatError("ai_auth_failed", 503, detail);
  if (status === 400 || status === 404) {
    return new ChatError("ai_request_rejected", 502, `${detail} ${String(err.message || "").slice(0, 200)}`);
  }
  return new ChatError("ai_unavailable", 502, detail);
}

function apiUrl(cfg, path) {
  return cfg.OPENAI_BASE_URL.replace(/\/+$/, "") + path;
}

export async function complete(env, cfg, messages, { maxTokens = cfg.MAX_OUTPUT_TOKENS } = {}) {
  if (!env.OPENAI_API_KEY) throw new ChatError("ai_not_configured", 503, "OPENAI_API_KEY missing");

  const payload = {
    model: cfg.OPENAI_MODEL,
    messages,
    max_completion_tokens: maxTokens,
    store: false,
  };
  if (cfg.OPENAI_REASONING_EFFORT) payload.reasoning_effort = cfg.OPENAI_REASONING_EFFORT;

  let res;
  try {
    res = await fetch(apiUrl(cfg, "/chat/completions"), {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(cfg.OPENAI_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === "TimeoutError") throw new ChatError("ai_timeout", 504, `no response in ${cfg.OPENAI_TIMEOUT_MS} ms`);
    throw new ChatError("ai_unavailable", 502, `network error: ${String(err?.message || err)}`);
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON error page
  }
  if (!res.ok) throw classifyProviderError(res.status, body);

  const choice = body?.choices?.[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content.trim() : "";
  const usage = {
    input_tokens: body?.usage?.prompt_tokens || 0,
    cached_tokens: body?.usage?.prompt_tokens_details?.cached_tokens || 0,
    output_tokens: body?.usage?.completion_tokens || 0,
  };
  if (!text) {
    throw new ChatError("ai_empty_response", 502, `finish_reason=${choice?.finish_reason || "-"}`);
  }
  return { text, truncated: choice?.finish_reason === "length", usage, model: body?.model || cfg.OPENAI_MODEL };
}

// Free check used by /diag: is the key valid and can it see the model?
export async function checkModelAccess(env, cfg) {
  if (!env.OPENAI_API_KEY) return { ok: false, error: "OPENAI_API_KEY not set" };
  try {
    const res = await fetch(apiUrl(cfg, `/models/${encodeURIComponent(cfg.OPENAI_MODEL)}`), {
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true };
    let body = null;
    try {
      body = await res.json();
    } catch {}
    return { ok: false, error: classifyProviderError(res.status, body).detail };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
