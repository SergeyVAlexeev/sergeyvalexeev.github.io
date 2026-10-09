#!/usr/bin/env node
// Connects Sergey AI to Dropbox (one-time, or to rotate the token), using the
// PKCE flow so no Dropbox app secret is needed anywhere.
//
// Prerequisites:
//  - Cloudflare credentials for wrangler (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID).
//  - Staging Worker deployed (npx wrangler deploy --env staging) with the secret
//    DROPBOX_APP_KEY (the Dropbox app key, added in the Cloudflare dashboard as
//    type "Secret"; a plain "Text" variable is removed by the next deploy).
//  - Dropbox app (Settings tab): Full Dropbox access; scopes files.metadata.read
//    and files.content.read enabled and submitted; OAuth 2 →
//    "Allow public clients (Implicit Grant & PKCE)" set to Allow; redirect URI
//    https://alexeev-website-chat-staging.sergei-v-alexeev.workers.dev/oauth/dropbox
//
//   node scripts/dropbox-auth.mjs [--production]
//
// Steps: checks that DROPBOX_APP_KEY exists on staging (fails fast if not),
// sets a one-time state secret on staging, waits until the staging
// /oauth/dropbox/start endpoint answers with the Dropbox redirect (bounded),
// then prints the consent link. The person clicks Allow; the staging Worker
// exchanges the code and parks { app_key, refresh_token } in its KV for up to
// an hour. The script stores DROPBOX_REFRESH_TOKEN on staging (and
// DROPBOX_APP_KEY + DROPBOX_REFRESH_TOKEN on production with --production),
// deletes the KV copy and disables the OAuth endpoints. No credential is printed.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

export const BASE = "https://alexeev-website-chat-staging.sergei-v-alexeev.workers.dev";
export const AUTHORIZE_PREFIX = "https://www.dropbox.com/oauth2/authorize";
const KV_KEY = "oauth:dropbox";
const STAGING = ["--env", "staging"];
const PRODUCTION = [];
const READY_TIMEOUT_MS = 2 * 60 * 1000;
const CONSENT_TIMEOUT_MS = 45 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Secret names from `wrangler secret list --format json` output (names only;
// Cloudflare never returns values). Returns null if the output can't be parsed.
export function secretNames(output) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end < start) return null;
  try {
    const list = JSON.parse(output.slice(start, end + 1));
    return Array.isArray(list) ? list.map((s) => s?.name).filter(Boolean) : null;
  } catch {
    return null;
  }
}

// Polls the start endpoint until it redirects to Dropbox's consent page.
// Never returns or logs the redirect target (it carries the state value).
export async function waitForStartRedirect(url, { timeoutMs = READY_TIMEOUT_MS, intervalMs = 3000, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "no response";
  for (;;) {
    try {
      const res = await fetchImpl(url, { redirect: "manual" });
      lastStatus = String(res.status);
      if (res.status === 302 && (res.headers.get("Location") || "").startsWith(AUTHORIZE_PREFIX)) {
        return { ok: true, lastStatus };
      }
    } catch (err) {
      lastStatus = `network error (${err?.name || "Error"})`;
    }
    if (Date.now() + intervalMs > deadline) return { ok: false, lastStatus };
    await sleep(intervalMs);
  }
}

function wrangler(argv, input) {
  return new Promise((resolve) => {
    const child = spawn("npx", ["wrangler", ...argv], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.end(input ?? "");
    child.on("exit", (code) => resolve({ code, out, err }));
  });
}

function errorLines(r) {
  return (r.err + r.out).split("\n").filter((l) => /error|✘/i.test(l)).join(" ").slice(0, 300);
}

async function putSecret(name, value, flags) {
  const r = await wrangler(["secret", "put", name, ...flags], value);
  if (r.code !== 0) throw new Error(`secret put ${name} failed: ${errorLines(r)}`);
}

async function deleteSecret(name, flags) {
  // Non-interactive wrangler answers its confirmation prompt with "yes".
  await wrangler(["secret", "delete", name, ...flags], "y\n");
}

async function main() {
  const toProduction = process.argv.includes("--production");

  console.log("Checking the staging Worker's secrets (names only)...");
  const list = await wrangler(["secret", "list", "--format", "json", ...STAGING]);
  const names = list.code === 0 ? secretNames(list.out) : null;
  if (!names) throw new Error(`Could not list staging secrets: ${errorLines(list) || "unreadable output"}`);
  if (!names.includes("DROPBOX_APP_KEY")) {
    throw new Error(
      "DROPBOX_APP_KEY is not set on the staging Worker. Add it in the Cloudflare dashboard " +
        "(Workers & Pages → alexeev-website-chat-staging → Settings → Variables and Secrets → Add, type Secret), " +
        "then run this again.",
    );
  }

  const state = randomBytes(24).toString("hex");
  const startUrl = `${BASE}/oauth/dropbox/start?state=${state}`;
  console.log("Enabling the one-time Dropbox authorisation endpoint on staging...");
  await putSecret("DROPBOX_OAUTH_STATE", state, STAGING);

  try {
    console.log("Waiting for the endpoint to go live (up to 2 minutes)...");
    const ready = await waitForStartRedirect(startUrl);
    if (!ready.ok) {
      throw new Error(
        `The authorisation endpoint did not become ready (last status: ${ready.lastStatus}). ` +
          "Check that DROPBOX_APP_KEY is a Secret on the staging Worker and that staging is deployed, then run this again.",
      );
    }

    console.log("\nOpen this link, sign in to the Dropbox account that holds PROFILE.md and click Allow:\n");
    console.log(`${startUrl}\n`);
    console.log("Waiting for the authorisation (up to 45 minutes)...");

    let parked = null;
    const deadline = Date.now() + CONSENT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const r = await wrangler(["kv", "key", "get", KV_KEY, "--binding", "CACHE", "--remote", "--text", ...STAGING]);
      const line = r.out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("{"));
      if (r.code === 0 && line) {
        try {
          parked = JSON.parse(line);
          if (parked.refresh_token && parked.app_key) break;
        } catch {}
        parked = null;
      }
      await sleep(5000);
    }
    if (!parked) throw new Error("Timed out waiting for the Dropbox authorisation. Run the script again.");

    console.log("Authorisation received and verified by the Worker.");
    await putSecret("DROPBOX_REFRESH_TOKEN", parked.refresh_token, STAGING);
    if (toProduction) {
      console.log("Storing the Dropbox credentials on the production Worker...");
      await putSecret("DROPBOX_APP_KEY", parked.app_key, PRODUCTION);
      await putSecret("DROPBOX_REFRESH_TOKEN", parked.refresh_token, PRODUCTION);
    }
  } finally {
    console.log("Cleaning up: deleting the KV copy and disabling the authorisation endpoint...");
    await wrangler(["kv", "key", "delete", KV_KEY, "--binding", "CACHE", "--remote", ...STAGING]);
    await deleteSecret("DROPBOX_OAUTH_STATE", STAGING);
  }
  console.log("Done. Revoke access any time under Dropbox Settings -> Connected apps.");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  // Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is set; re-run
  // once with it so the readiness check works behind a proxy.
  if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
    const r = spawnSync(process.execPath, process.argv.slice(1), {
      stdio: "inherit",
      env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
    });
    process.exit(r.status ?? 1);
  }
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
