// All tunables live here. Each can be overridden by a Worker variable of the
// same name (wrangler.jsonc "vars" or the Cloudflare dashboard).

const DEFAULTS = {
  // AI provider (any OpenAI-compatible Chat Completions endpoint).
  OPENAI_MODEL: "gpt-6-luna",
  OPENAI_BASE_URL: "https://api.openai.com/v1",
  OPENAI_REASONING_EFFORT: "low", // empty string = do not send the parameter
  OPENAI_TIMEOUT_MS: 30000,
  MAX_OUTPUT_TOKENS: 1200, // includes reasoning tokens for reasoning models

  // Prices in USD per 1M tokens, used only for cost estimates in /diag.
  PRICE_INPUT_PER_M: 0.1,
  PRICE_CACHED_INPUT_PER_M: 0.01,
  PRICE_OUTPUT_PER_M: 0.5,

  // Dropbox profile.
  DROPBOX_PROFILE_PATH: "/Job hunting/PROFILE.md",
  DROPBOX_TIMEOUT_MS: 6000,
  // Re-check the Dropbox revision if the last check is older than this.
  // 0 = check on every chat request.
  PROFILE_CHECK_SECONDS: 0,
  PROFILE_MAX_CHARS: 40000,
  // Markdown sections whose heading matches this (case-insensitive regex)
  // are removed before the profile is cached or sent to the model.
  PROFILE_EXCLUDE_HEADINGS: "", // No sections withheld; professional referees are public.

  // Public website pages to extract. The first page may be longer.
  WEBSITE_PAGES: [
    "https://www.alexeev.pw/",
    "https://www.alexeev.pw/interviewers-as-instruments/",
    "https://www.alexeev.pw/why-twelve-notes/",
    "https://www.alexeev.pw/revalue-au/",
    "https://www.alexeev.pw/hope/",
    "https://www.alexeev.pw/family/",
  ].join(","),
  WEBSITE_TTL_SECONDS: 600,
  WEBSITE_TIMEOUT_MS: 6000,
  WEBSITE_HOME_MAX_CHARS: 40000,
  WEBSITE_PAGE_MAX_CHARS: 6000,

  // Abuse and cost limits.
  ALLOWED_ORIGINS: "https://www.alexeev.pw,https://alexeev.pw,https://sergeyvalexeev.github.io",
  RATE_LIMIT_PER_IP_PER_MIN: 6,
  RATE_LIMIT_GLOBAL_PER_MIN: 30,
  MAX_BODY_BYTES: 100000,
  MAX_USER_MESSAGE_CHARS: 8000,
  MAX_ASSISTANT_MESSAGE_CHARS: 4000,
  MAX_HISTORY_MESSAGES: 12,
  MAX_HISTORY_CHARS: 24000,
  DAILY_CHAT_LIMIT: 300, // approximate, counted in KV; 0 = no daily limit
};

export function getConfig(env = {}) {
  const cfg = {};
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const raw = env[key];
    if (raw === undefined || raw === null || raw === "") {
      cfg[key] = def;
    } else if (typeof def === "number") {
      const n = Number(raw);
      cfg[key] = Number.isFinite(n) ? n : def;
    } else {
      cfg[key] = String(raw);
    }
  }
  // OPENAI_REASONING_EFFORT may be deliberately set to "none" or "" (omit).
  if (env.OPENAI_REASONING_EFFORT === "") cfg.OPENAI_REASONING_EFFORT = "";
  cfg.websitePages = cfg.WEBSITE_PAGES.split(",").map((s) => s.trim()).filter(Boolean);
  cfg.allowedOrigins = cfg.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  return cfg;
}
