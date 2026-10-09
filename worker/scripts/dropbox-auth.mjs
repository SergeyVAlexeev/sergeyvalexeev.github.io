#!/usr/bin/env node
// Connects Sergey AI to Dropbox (one-time, or to rotate the token), using the
// PKCE flow so no Dropbox app secret is needed anywhere.
//
// Prerequisites:
//  - Cloudflare credentials for wrangler (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID).
//  - Staging Worker deployed (npx wrangler deploy --env staging) with the secret
//    DROPBOX_APP_KEY (the Dropbox app key, entered in the Cloudflare dashboard).
//  - Dropbox app: Full Dropbox access; scopes files.metadata.read and
//    files.content.read enabled and submitted; redirect URI
//    https://alexeev-website-chat-staging.sergei-v-alexeev.workers.dev/oauth/dropbox
//
//   node scripts/dropbox-auth.mjs [--production]
//
// The script sets a one-time state secret on staging and prints a link. The
// person opens it and clicks Allow; the staging Worker exchanges the code and
// parks { app_key, refresh_token } in its KV for up to an hour. The script
// then stores DROPBOX_REFRESH_TOKEN on staging (and DROPBOX_APP_KEY +
// DROPBOX_REFRESH_TOKEN on production with --production), deletes the KV
// copy and disables the OAuth endpoints. No credential is printed.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const BASE = "https://alexeev-website-chat-staging.sergei-v-alexeev.workers.dev";
const KV_KEY = "oauth:dropbox";
const STAGING = ["--env", "staging"];
const PRODUCTION = [];
const TIMEOUT_MS = 45 * 60 * 1000;
const toProduction = process.argv.includes("--production");

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
  if (r.code !== 0) {
    const reason = (r.err + r.out).split("\n").filter((l) => /error|✘/i.test(l)).join(" ").slice(0, 300);
    throw new Error(`secret put ${name} failed: ${reason}`);
  }
}

async function deleteSecret(name, flags) {
  await wrangler(["secret", "delete", name, ...flags], "y\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const state = randomBytes(24).toString("hex");
  console.log("Enabling the one-time Dropbox authorisation endpoint on staging...");
  await putSecret("DROPBOX_OAUTH_STATE", state, STAGING);

  console.log("\nOpen this link, sign in to the Dropbox account that holds PROFILE.md and click Allow:\n");
  console.log(`${BASE}/oauth/dropbox/start?state=${state}\n`);
  console.log("Waiting for the authorisation (up to 45 minutes)...");

  let parked = null;
  const deadline = Date.now() + TIMEOUT_MS;
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

  try {
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

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
