#!/usr/bin/env node
// Saves the currently deployed Worker's code and binding names to
// worker/legacy/ so they can be reviewed and committed before replacing it.
// Secret VALUES are never returned by Cloudflare; only their names are saved.
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/backup-live-worker.mjs [worker-name]
//   (behind an HTTPS proxy, prefix with NODE_USE_ENV_PROXY=1)
//
// The token needs "Workers Scripts: Read". Without a token, copy the code
// from the dashboard instead: Workers & Pages -> alexeev-website-chat -> Edit code.

import { mkdirSync, writeFileSync } from "node:fs";

const name = process.argv[2] || "alexeev-website-chat";
const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } = process.env;
if (!token || !account) {
  console.error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID first.");
  process.exit(1);
}

const base = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}`;
const headers = { Authorization: `Bearer ${token}` };
const outDir = new URL("../legacy/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const content = await fetch(`${base}/content/v2`, { headers });
if (!content.ok) throw new Error(`content: HTTP ${content.status} ${await content.text()}`);
const type = content.headers.get("content-type") || "";
const body = await content.text();
writeFileSync(new URL(type.includes("multipart") ? "original-worker.multipart.txt" : "original-worker.js", outDir), body);

const settings = await fetch(`${base}/settings`, { headers });
if (!settings.ok) throw new Error(`settings: HTTP ${settings.status} ${await settings.text()}`);
const { result } = await settings.json();
const bindings = (result.bindings || []).map((b) =>
  b.type === "secret_text" ? { type: b.type, name: b.name } : b,
);
writeFileSync(
  new URL("original-settings.json", outDir),
  JSON.stringify({ compatibility_date: result.compatibility_date, bindings }, null, 2) + "\n",
);

console.log(`Saved to worker/legacy/. Review before committing (it should contain no secret values).`);
console.log(`Bindings: ${bindings.map((b) => `${b.name} (${b.type})`).join(", ") || "none"}`);
