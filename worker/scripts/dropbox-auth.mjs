#!/usr/bin/env node
// Connects Sergey AI to Dropbox (one-time, or to rotate the token).
//
// Needs in the environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
// DROPBOX_APP_KEY, DROPBOX_APP_SECRET. The staging Worker must be deployed
// with a KV namespace, and the Dropbox app must list this redirect URI:
//   https://alexeev-website-chat-staging.sergei-v-alexeev.workers.dev/oauth/dropbox
//
//   node scripts/dropbox-auth.mjs [--production] [--callback-base URL]
//
// Steps: stores the app key/secret and a random one-time state on the staging
// Worker, prints the Dropbox authorisation link, waits while the person clicks
// Allow (the Worker exchanges the code and parks the refresh token in KV for
// up to an hour), then moves the refresh token into Worker secrets (staging,
// plus production with --production), deletes the KV copy and disables the
// callback. No credential is printed.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const argValue = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const CALLBACK_BASE = argValue("--callback-base", "https://alexeev-website-chat-staging.sergei-v-alexeev.workers.dev");
const REDIRECT_URI = `${CALLBACK_BASE}/oauth/dropbox`;
const KV_KEY = "oauth:dropbox_refresh_token";
const STAGING = ["--env", "staging"];
const PRODUCTION = [];
const TIMEOUT_MS = 20 * 60 * 1000;

const { DROPBOX_APP_KEY: appKey, DROPBOX_APP_SECRET: appSecret } = process.env;
for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "DROPBOX_APP_KEY", "DROPBOX_APP_SECRET"]) {
  if (!process.env[name]) {
    console.error(`Missing environment variable ${name}.`);
    process.exit(1);
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

async function putSecret(name, value, flags) {
  const r = await wrangler(["secret", "put", name, ...flags], value);
  if (r.code !== 0) throw new Error(`secret put ${name} failed: ${r.err.split("\n").filter((l) => /error/i.test(l)).join(" ").slice(0, 300)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const state = randomBytes(24).toString("hex");
  console.log("Storing app credentials and a one-time state on the staging Worker...");
  await putSecret("DROPBOX_APP_KEY", appKey, STAGING);
  await putSecret("DROPBOX_APP_SECRET", appSecret, STAGING);
  await putSecret("DROPBOX_OAUTH_STATE", state, STAGING);

  const authUrl =
    "https://www.dropbox.com/oauth2/authorize?" +
    new URLSearchParams({ client_id: appKey, response_type: "code", token_access_type: "offline", redirect_uri: REDIRECT_URI, state });
  console.log("\nOpen this link, sign in as the Dropbox account that holds PROFILE.md and click Allow:\n");
  console.log(authUrl + "\n");
  console.log("Waiting for Dropbox to redirect back (up to 20 minutes)...");

  let refreshToken = "";
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const r = await wrangler(["kv", "key", "get", KV_KEY, "--binding", "CACHE", "--remote", "--text", ...STAGING]);
    const value = r.out.trim().split("\n").pop()?.trim() || "";
    if (r.code === 0 && /^[A-Za-z0-9_.-]{20,}$/.test(value)) {
      refreshToken = value;
      break;
    }
    await sleep(5000);
  }
  if (!refreshToken) throw new Error("Timed out waiting for the Dropbox redirect. Run the script again.");
  console.log("Authorisation received.");

  await putSecret("DROPBOX_REFRESH_TOKEN", refreshToken, STAGING);
  if (args.includes("--production")) {
    console.log("Storing Dropbox secrets on the production Worker...");
    await putSecret("DROPBOX_APP_KEY", appKey, PRODUCTION);
    await putSecret("DROPBOX_APP_SECRET", appSecret, PRODUCTION);
    await putSecret("DROPBOX_REFRESH_TOKEN", refreshToken, PRODUCTION);
  }

  console.log("Cleaning up: deleting the KV copy and disabling the callback...");
  await wrangler(["kv", "key", "delete", KV_KEY, "--binding", "CACHE", "--remote", ...STAGING]);
  await wrangler(["secret", "delete", "DROPBOX_OAUTH_STATE", ...STAGING], "y\n");
  console.log("Done. Revoke access any time under Dropbox Settings -> Connected apps.");
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
