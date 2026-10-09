#!/usr/bin/env node
// One-time Dropbox authorisation for Sergey AI.
//
//   cd worker
//   npx wrangler login                       # once, opens a browser
//   node scripts/dropbox-auth.mjs            # staging Worker
//   node scripts/dropbox-auth.mjs --production   # production Worker
//   node scripts/dropbox-auth.mjs --staging --production   # both
//
// It asks for the Dropbox app key and secret, prints an authorisation link,
// exchanges the code you paste for a long-lived refresh token, checks that
// the token can read the profile, and stores DROPBOX_APP_KEY,
// DROPBOX_APP_SECRET and DROPBOX_REFRESH_TOKEN as Cloudflare Worker secrets.
// Nothing is printed or written to disk. Needs Node 18+.

import { spawn } from "node:child_process";
import readline from "node:readline";

const PROFILE_PATH = process.env.DROPBOX_PROFILE_PATH || "/Job hunting/PROFILE.md";

const args = process.argv.slice(2);
const targets = [];
if (args.includes("--staging") || !args.includes("--production")) targets.push({ label: "staging", flags: ["--env", "staging"] });
if (args.includes("--production")) targets.push({ label: "production", flags: [] });

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

function putSecret(name, value, flags) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", "secret", "put", name, ...flags], {
      stdio: ["pipe", "inherit", "inherit"],
      shell: process.platform === "win32",
    });
    child.stdin.end(value);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`wrangler exited with ${code}`))));
  });
}

async function main() {
  console.log("Sergey AI: Dropbox authorisation\n");
  console.log("Dropbox app console: https://www.dropbox.com/developers/apps -> your app -> Settings tab.\n");
  const appKey = await ask("App key: ");
  const appSecret = await ask("App secret (hidden): ", { hidden: true });
  if (!appKey || !appSecret) throw new Error("App key and secret are required.");

  const authUrl =
    "https://www.dropbox.com/oauth2/authorize?" +
    new URLSearchParams({ client_id: appKey, response_type: "code", token_access_type: "offline" });
  console.log("\nOpen this link, sign in as the Dropbox account that holds PROFILE.md, click Allow,");
  console.log("then copy the access code Dropbox shows:\n");
  console.log(authUrl + "\n");
  const code = await ask("Access code: ");

  const tokenRes = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: appKey, client_secret: appSecret }),
  });
  const token = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !token.refresh_token) {
    throw new Error(`Code exchange failed (HTTP ${tokenRes.status}): ${token.error_description || token.error || "no refresh token returned"}`);
  }
  const scopes = String(token.scope || "").split(" ");
  console.log(`\nAuthorised. Granted scopes: ${token.scope || "(not reported)"}`);
  for (const s of ["files.metadata.read", "files.content.read"]) {
    if (token.scope && !scopes.includes(s)) console.log(`WARNING: scope ${s} missing. Enable it under Permissions, Submit, then run this again.`);
  }

  const metaRes = await fetch("https://api.dropboxapi.com/2/files/get_metadata", {
    method: "POST",
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path: PROFILE_PATH }),
  });
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok) {
    console.error(`\nThe token cannot read ${PROFILE_PATH} (HTTP ${metaRes.status}): ${JSON.stringify(meta.error_summary || meta)}`);
    console.error("If the error is path/not_found, the app was probably created with 'App folder' access.");
    console.error("It needs 'Full Dropbox' access: create a new app with Full Dropbox and the same two scopes.");
    process.exit(1);
  }
  console.log(`Verified access to ${meta.path_display}: revision ${meta.rev}, modified ${meta.server_modified}, ${meta.size} bytes.\n`);

  for (const t of targets) {
    console.log(`Storing secrets on the ${t.label} Worker...`);
    await putSecret("DROPBOX_APP_KEY", appKey, t.flags);
    await putSecret("DROPBOX_APP_SECRET", appSecret, t.flags);
    await putSecret("DROPBOX_REFRESH_TOKEN", token.refresh_token, t.flags);
  }
  console.log("\nDone. The refresh token does not expire; revoke it any time under");
  console.log("Dropbox Settings -> Connected apps, or by regenerating the app secret.");
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
