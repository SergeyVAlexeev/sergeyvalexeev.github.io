// Reads PROFILE.md from Dropbox.
//
// On each call: get (or refresh) a short-lived access token from the stored
// refresh token, ask Dropbox for the file's current revision, and download
// the file only when the revision differs from the cached copy. If Dropbox
// fails, the last successfully loaded copy (memory, then KV) is returned and
// marked stale with its age.

import { kvGet, kvPut, log, safeEqual } from "./store.js";

const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const METADATA_URL = "https://api.dropboxapi.com/2/files/get_metadata";
const DOWNLOAD_URL = "https://content.dropboxapi.com/2/files/download";
const KV_KEY = "profile";

// Per-isolate state. Lost when the isolate is recycled; KV covers that case.
const state = {
  accessToken: null,
  accessTokenExpiresAt: 0,
  profile: null, // { rev, serverModified, size, text, loadedAt, checkedAt }
  lastError: null, // { at, message }
  lastSuccessAt: 0,
};

export function resetProfileState() {
  state.accessToken = null;
  state.accessTokenExpiresAt = 0;
  state.profile = null;
  state.lastError = null;
  state.lastSuccessAt = 0;
}

export function profileState() {
  return state;
}

export function dropboxConfigured(env) {
  return Boolean(env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET && env.DROPBOX_REFRESH_TOKEN);
}

class DropboxError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function getAccessToken(env, cfg, force = false) {
  if (!force && state.accessToken && Date.now() < state.accessTokenExpiresAt - 300_000) {
    return state.accessToken;
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: env.DROPBOX_REFRESH_TOKEN,
    client_id: env.DROPBOX_APP_KEY,
    client_secret: env.DROPBOX_APP_SECRET,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(cfg.DROPBOX_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Dropbox returns e.g. {"error":"invalid_grant"}; safe to log, no secrets.
    const detail = (await res.text()).slice(0, 200);
    throw new DropboxError(`token refresh failed: HTTP ${res.status} ${detail}`, res.status);
  }
  const data = await res.json();
  state.accessToken = data.access_token;
  state.accessTokenExpiresAt = Date.now() + (Number(data.expires_in) || 14400) * 1000;
  return state.accessToken;
}

async function dropboxCall(env, cfg, makeRequest) {
  let token = await getAccessToken(env, cfg);
  let res = await makeRequest(token);
  if (res.status === 401) {
    // Access token expired or revoked early: refresh once and retry.
    token = await getAccessToken(env, cfg, true);
    res = await makeRequest(token);
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new DropboxError(`HTTP ${res.status} ${detail}`, res.status);
  }
  return res;
}

async function getMetadata(env, cfg) {
  const res = await dropboxCall(env, cfg, (token) =>
    fetch(METADATA_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path: cfg.DROPBOX_PROFILE_PATH }),
      signal: AbortSignal.timeout(cfg.DROPBOX_TIMEOUT_MS),
    }),
  );
  const meta = await res.json();
  if (meta[".tag"] && meta[".tag"] !== "file") throw new DropboxError(`path is a ${meta[".tag"]}, not a file`);
  return meta;
}

async function download(env, cfg, rev) {
  const res = await dropboxCall(env, cfg, (token) =>
    fetch(DOWNLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        // Download the exact revision we just saw, so text and rev match.
        "Dropbox-API-Arg": JSON.stringify({ path: `rev:${rev}` }),
      },
      signal: AbortSignal.timeout(cfg.DROPBOX_TIMEOUT_MS),
    }),
  );
  return await res.text();
}

// Remove Markdown sections (and their subsections) whose heading matches.
export function filterProfile(markdown, excludePattern, maxChars) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const re = excludePattern ? new RegExp(excludePattern, "i") : null;
  const out = [];
  let skipLevel = 0; // heading level being skipped; 0 = not skipping
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      const level = m[1].length;
      if (skipLevel && level <= skipLevel) skipLevel = 0;
      if (!skipLevel && re && re.test(m[2])) {
        skipLevel = level;
        continue;
      }
    } else if (skipLevel && /^-{3,}\s*$/.test(line)) {
      // A horizontal rule ends the skipped section.
      skipLevel = 0;
    }
    if (!skipLevel) out.push(line);
  }
  let text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (maxChars && text.length > maxChars) {
    text = text.slice(0, maxChars) + "\n\n[Profile truncated for length.]";
  }
  return text;
}

// ageSeconds = time since this copy was last confirmed to be Dropbox's
// current revision (a revision check or a download).
function withStatus(profile, status, now) {
  const verifiedAt = Math.max(profile.checkedAt || 0, profile.loadedAt || 0);
  return { ...profile, status, verifiedAt, ageSeconds: Math.round((now - verifiedAt) / 1000) };
}

// Returns { status, text, rev, serverModified, loadedAt, checkedAt, ageSeconds, error }
// status: "fresh" | "stale" | "unavailable" | "not_configured"
export async function getProfile(env, cfg, ctx) {
  const now = Date.now();

  if (!state.profile) {
    const snap = await kvGet(env, KV_KEY);
    if (snap && snap.text) state.profile = { ...snap, checkedAt: 0 };
  }

  if (!dropboxConfigured(env)) {
    return state.profile
      ? { ...withStatus(state.profile, "stale", now), error: "Dropbox credentials not configured" }
      : { status: "not_configured", error: "Dropbox credentials not configured" };
  }

  if (state.profile && cfg.PROFILE_CHECK_SECONDS > 0 && now - state.profile.checkedAt < cfg.PROFILE_CHECK_SECONDS * 1000) {
    return withStatus(state.profile, "fresh", now);
  }

  try {
    const meta = await getMetadata(env, cfg);
    if (state.profile && state.profile.rev === meta.rev) {
      state.profile.checkedAt = now;
    } else {
      const raw = await download(env, cfg, meta.rev);
      state.profile = {
        rev: meta.rev,
        serverModified: meta.server_modified,
        size: meta.size,
        text: filterProfile(raw, cfg.PROFILE_EXCLUDE_HEADINGS, cfg.PROFILE_MAX_CHARS),
        loadedAt: now,
        checkedAt: now,
      };
      log("profile_loaded", { rev: meta.rev, server_modified: meta.server_modified, size: meta.size });
      const { checkedAt, ...snapshot } = state.profile;
      const write = kvPut(env, KV_KEY, snapshot);
      if (ctx?.waitUntil) ctx.waitUntil(write);
      else await write;
    }
    state.lastSuccessAt = now;
    state.lastError = null;
    // A successful check means the cached text is the current revision.
    return withStatus(state.profile, "fresh", now);
  } catch (err) {
    const message = err?.name === "TimeoutError" ? "Dropbox request timed out" : String(err?.message || err);
    state.lastError = { at: now, message };
    log("profile_error", { error: message });
    return state.profile
      ? { ...withStatus(state.profile, "stale", now), error: message }
      : { status: "unavailable", error: message };
  }
}

// ---------- One-time OAuth redirect target ----------
// Active only while the DROPBOX_OAUTH_STATE secret is set. Dropbox redirects
// the browser here after "Allow"; the Worker exchanges the code itself, so the
// code never has to be copied anywhere. The refresh token is parked in KV for
// at most an hour until scripts/dropbox-auth.mjs moves it into a secret.
export const OAUTH_KV_KEY = "oauth:dropbox_refresh_token";

export async function handleDropboxCallback(url, env) {
  const expected = env.DROPBOX_OAUTH_STATE;
  if (!expected || !env.CACHE || !env.DROPBOX_APP_KEY || !env.DROPBOX_APP_SECRET) return null;
  if (!safeEqual(url.searchParams.get("state") || "", expected)) return null;

  if (url.searchParams.get("error")) {
    return { ok: false, message: "Dropbox authorisation was cancelled. Open the authorisation link again to retry." };
  }
  const code = url.searchParams.get("code");
  if (!code) return { ok: false, message: "No authorisation code received from Dropbox." };

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.DROPBOX_APP_KEY,
      client_secret: env.DROPBOX_APP_SECRET,
      redirect_uri: `${url.origin}${url.pathname}`,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const token = await res.json().catch(() => ({}));
  if (!res.ok || !token.refresh_token) {
    log("oauth_error", { status: res.status, error: token.error || "-" });
    return { ok: false, message: `Dropbox rejected the authorisation (${token.error || res.status}). Open the authorisation link again to retry.` };
  }

  const path = env.DROPBOX_PROFILE_PATH || "/Job hunting/PROFILE.md";
  const meta = await fetch(METADATA_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
    signal: AbortSignal.timeout(10000),
  });
  const info = await meta.json().catch(() => ({}));
  if (!meta.ok) {
    log("oauth_error", { status: meta.status, error: info.error_summary || "-" });
    return {
      ok: false,
      message:
        `Connected to Dropbox, but the app cannot read ${path} (${info.error_summary || meta.status}). ` +
        "If this says path/not_found, the Dropbox app must use 'Full Dropbox' access, not 'App folder'.",
    };
  }

  await env.CACHE.put(OAUTH_KV_KEY, token.refresh_token, { expirationTtl: 3600 });
  log("oauth_ok", { rev: info.rev });
  return {
    ok: true,
    message: `Sergey AI is connected to Dropbox and can read ${info.path_display} (last modified ${info.server_modified}). You can close this tab.`,
  };
}
