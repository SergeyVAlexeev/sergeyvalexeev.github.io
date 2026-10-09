import SYSTEM_PROMPT from "./system-prompt.md";
import { ChatError, complete } from "./llm.js";
import { getProfile } from "./profile.js";
import { getWebsite, formatWebsite } from "./website.js";
import { addUsage, getUsage, log } from "./store.js";
import { checkRateLimits } from "./ratelimit.js";

// User-facing text for every error code. The frontend shows `message` as a
// system notice, never as an AI answer.
export const ERROR_MESSAGES = {
  bad_request: "The chat request was not understood. Please reload the page and try again.",
  request_too_large: "This conversation has become too long. Please reload the page to start a new one.",
  message_too_long: "Your message is too long. Please shorten it (for example, paste only the key parts of the brief) and try again.",
  forbidden_origin: "This chat service only accepts requests from alexeev.pw.",
  rate_limited: "You're sending messages faster than Sergey AI can answer. Please wait a minute and try again.",
  daily_limit: "Sergey AI has reached its daily usage limit. Please try again tomorrow, or contact Sergey directly using the details on this page.",
  context_unavailable: "Sergey AI can't load its reference information right now, so it can't answer reliably. Please try again later.",
  ai_credit_exhausted: "Sergey AI is temporarily unavailable because its AI service credit has run out. Please try again later, or contact Sergey directly using the details on this page.",
  ai_busy: "The AI service is busy right now. Please try again in a minute.",
  ai_timeout: "The AI service took too long to respond. Please try again.",
  ai_unavailable: "The AI service is temporarily unavailable. Please try again in a moment.",
  ai_empty_response: "The AI service returned an empty answer. Please try rephrasing your question.",
  ai_not_configured: "Sergey AI is temporarily unavailable because of a configuration problem. Please contact Sergey directly using the details on this page.",
  ai_auth_failed: "Sergey AI is temporarily unavailable because of a configuration problem. Please contact Sergey directly using the details on this page.",
  ai_request_rejected: "Sergey AI is temporarily unavailable because of a configuration problem. Please contact Sergey directly using the details on this page.",
  not_found: "Not found.",
  internal_error: "Something went wrong in Sergey AI. Please try again.",
};

function clip(text, max) {
  return text.length > max ? text.slice(0, max) + " …[truncated]" : text;
}

// Turns the browser's { messages } into a bounded, well-formed history.
export function normaliseMessages(body, cfg) {
  if (!body || !Array.isArray(body.messages) || body.messages.length > 200) {
    throw new ChatError("bad_request", 400, "messages missing or not an array");
  }
  const msgs = body.messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.trim() }))
    .filter((m) => m.content);

  const last = msgs.pop();
  if (!last || last.role !== "user") throw new ChatError("bad_request", 400, "last message must be from the user");
  if (last.content.length > cfg.MAX_USER_MESSAGE_CHARS) {
    throw new ChatError("message_too_long", 413, `${last.content.length} chars`);
  }

  let history = msgs.slice(-(cfg.MAX_HISTORY_MESSAGES - 1)).map((m) => ({
    role: m.role,
    content: clip(m.content, m.role === "user" ? cfg.MAX_USER_MESSAGE_CHARS : cfg.MAX_ASSISTANT_MESSAGE_CHARS),
  }));
  const budget = cfg.MAX_HISTORY_CHARS - last.content.length;
  while (history.length && history.reduce((n, m) => n + m.content.length, 0) > budget) history.shift();
  while (history.length && history[0].role !== "user") history.shift();
  return [...history, last];
}

function hoursAgo(seconds) {
  const h = seconds / 3600;
  return h < 1 ? `${Math.max(1, Math.round(seconds / 60))} minutes` : `${h.toFixed(1)} hours`;
}

export function buildSystemMessage(cfg, profile, website, now = Date.now()) {
  const parts = [SYSTEM_PROMPT.trim(), "# Reference data"];
  const status = [`Today's date: ${new Date(now).toISOString().slice(0, 10)}.`];

  if (website.status !== "unavailable") {
    parts.push(`<website source="${cfg.websitePages[0] || ""}">\n${formatWebsite(website)}\n</website>`);
    status.push(
      `Website: text extracted ${new Date(website.fetchedAt).toISOString()}.` +
        (website.status === "fresh" ? "" : " Some pages could not be refreshed; their last saved copy is used where available."),
    );
  } else {
    status.push("Website: could not be loaded. Say that publication details are temporarily unavailable and point visitors to https://www.alexeev.pw/.");
  }

  if (profile.text) {
    parts.push(
      `<profile source="Dropbox ${cfg.DROPBOX_PROFILE_PATH}" revision="${profile.rev}" modified="${profile.serverModified}">\n${profile.text}\n</profile>`,
    );
    status.push(
      profile.status === "fresh"
        ? `Profile: current Dropbox revision, file last modified ${profile.serverModified}.`
        : `Profile: Dropbox could not be checked just now, so this is a saved copy last confirmed current ${hoursAgo(profile.ageSeconds)} ago (file last modified ${profile.serverModified}). Mention this only if recency matters to the answer.`,
    );
  } else {
    status.push("Profile: could not be loaded. Answer from the website only, and say that detailed background information is temporarily unavailable when it matters.");
  }

  parts.push(`# Status\n${status.join("\n")}`);
  return parts.join("\n\n");
}

export async function handleChat(request, env, ctx, cfg) {
  const started = Date.now();
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";


  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > cfg.MAX_BODY_BYTES) throw new ChatError("request_too_large", 413, `${declared} bytes`);
  const raw = await request.text();
  if (raw.length > cfg.MAX_BODY_BYTES) throw new ChatError("request_too_large", 413, `${raw.length} chars`);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ChatError("bad_request", 400, "invalid JSON");
  }
  const messages = normaliseMessages(body, cfg);

  // Limits are checked after validation so malformed requests don't use up quota.
  const limited = await checkRateLimits(env, cfg, ip);
  if (limited) throw new ChatError("rate_limited", 429, limited);
  if (cfg.DAILY_CHAT_LIMIT > 0) {
    const usage = await getUsage(env);
    if (usage.requests >= cfg.DAILY_CHAT_LIMIT) throw new ChatError("daily_limit", 429, `${usage.requests} today`);
  }

  const [profile, website] = await Promise.all([getProfile(env, cfg, ctx), getWebsite(env, cfg, ctx)]);
  if (!profile.text && website.status === "unavailable") {
    throw new ChatError("context_unavailable", 503, `profile=${profile.error || profile.status}`);
  }

  const system = buildSystemMessage(cfg, profile, website);
  const result = await complete(env, cfg, [{ role: "system", content: system }, ...messages]);

  const usageWrite = addUsage(env, result.usage);
  if (ctx?.waitUntil) ctx.waitUntil(usageWrite);
  else await usageWrite;

  log("chat_ok", {
    ms: Date.now() - started,
    model: result.model,
    turns: messages.length,
    profile: profile.status,
    profile_rev: profile.rev,
    website: website.status,
    ...result.usage,
  });

  const text = result.truncated ? `${result.text}\n\n[Answer cut short because of length limits.]` : result.text;
  return { text };
}
