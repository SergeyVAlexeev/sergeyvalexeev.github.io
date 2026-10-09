# First production rollout of the new Sergey AI (runbook)

Status log and exact steps for finishing the rollout. A coding agent continuing this work
should read `worker/README.md`, then work through the steps below in order, ticking them off and
recording results in the **Log** at the end. Commit and push the updates to this file as you go.

**Authorisation (from Sergey, 9 Oct 2026):** the agent may deploy staging and production, configure
Cloudflare, merge the branch `claude/exciting-hypatia-w84i84` into `main` and publish, once tests
pass, without asking again. Do not change unrelated parts of the website or the CV link. Never purchase
OpenAI credit or enable auto-recharge. Never print or commit credentials, and never ask Sergey to paste one into chat.

## Credentials

- Cloudflare: the API token is a Claude **network secret** for `api.cloudflare.com` (Bearer); the environment holds
  only `CLOUDFLARE_API_TOKEN=network-secret-proxy` and `CLOUDFLARE_ACCOUNT_ID`. Wrangler works through the proxy;
  Node scripts that call the API directly need `NODE_USE_ENV_PROXY=1`. Approved scope: Workers Scripts Edit +
  Workers KV Storage Edit. Do not broaden it.
- Dropbox (PKCE, no app secret anywhere): Sergey adds the app key as secret `DROPBOX_APP_KEY` on the staging
  Worker in the Cloudflare dashboard. The Dropbox app needs **Full Dropbox** access, scopes `files.metadata.read` and
  `files.content.read` enabled and submitted, and redirect URI
  `https://alexeev-website-chat-staging.sergei-v-alexeev.workers.dev/oauth/dropbox`.

OpenAI: reuse the API key secret already on the production Worker (project `website-chat`). Its
value cannot be read, only reused. Live AI tests need the $5 prepaid credit Sergey is adding.

## Steps

1. **Preflight.** `cd worker && npm ci && npm test` (all pass). Check that the four environment variables are present
   (`env | grep -c ...`, never echo values). `npx wrangler whoami` succeeds.
2. **Back up production.** `node scripts/backup-live-worker.mjs`; review `legacy/` for secret values (there
   should be none) and commit it. Record the current version id from `npx wrangler deployments list` in the Log.
   This is the rollback target: `npx wrangler rollback <id>`.
3. **OpenAI secret name.** `npx wrangler secret list` (production). If the key is not named `OPENAI_API_KEY`,
   add that name as a fallback in `src/llm.js` (`env.OPENAI_API_KEY || env.<OLD_NAME>`), plus a test, and commit.
4. **KV.** `npx wrangler kv namespace create CACHE` and `npx wrangler kv namespace create CACHE --env staging`;
   put both ids into `wrangler.jsonc` (ids are not secret) and commit.
5. **Deploy staging.** `npx wrangler deploy --env staging`.
6. **Dropbox OAuth.** Run `node scripts/dropbox-auth.mjs --production` in the background. Give Sergey the
   printed `/oauth/dropbox/start` link (his only action is to click Allow) and wait for it to finish. Note that adding secrets to production
   redeploys the *old* production code with extra secrets, which changes nothing visible. Confirm that
   `DROPBOX_OAUTH_STATE` is gone from staging (`npx wrangler secret list --env staging`).
7. **Diagnostics token.** Generate one (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`),
   keep it in the session scratchpad only, and `wrangler secret put DIAG_TOKEN` on staging and production.
8. **Staging with real data.** `GET /diag` on staging: `profile.status = fresh`, and `revision` equals the rev
   returned by the Dropbox connector (`get_file_metadata /Job hunting/PROFILE.md`) if one is available.
   `last_updated_line` should be the file's line, and every website page should be `ok`. Then POST a chat with
   `Origin: https://www.alexeev.pw`; it should return `ai_not_configured` (staging has no OpenAI key), which proves context loading.
9. **Deploy production.** `npx wrangler deploy`. Check `/health` and `/diag`: profile fresh, website fresh,
   `ai.model_access.ok = true`. Run `/diag?ai=probe`: before credit it gives `ai_credit_exhausted`
   (record it as the real-API test of the credit-error path); after credit it gives `ok`.
10. **Real AI tests (needs credit).** POST to production with `Origin: https://www.alexeev.pw`:
    a recent publication (the JOPE interviewers paper: title, journal, link should match the website);
    a collaboration-fit question (pasted brief); a question the sources cannot answer (should say so);
    a multi-turn follow-up; whether HOPE/CARE-SW are funded (must say proposals). Fix the prompt if answers fail
    and redeploy.
11. **Publish frontend.** Merge `claude/exciting-hypatia-w84i84` into `main` and push. Wait for GitHub Pages
    (check `https://www.alexeev.pw/` contains `MAX_HISTORY`). Run a real conversation through the live page with
    Playwright (Chromium at `/opt/pw-browsers`), plus a mobile viewport screenshot.
12. **Profile change, no redeploy.** Ask Sergey to add the line `- Test fact for Sergey AI: favourite estimator is the
    Wald estimator.` under "Research areas" in his local PROFILE.md and save. Poll `/diag` until the revision
    changes, ask the live bot "What is Sergey's favourite estimator?", then ask him to remove the line and confirm the
    revision changes again and the fact is gone.
13. **Report** the final status questions: live? current profile? auto-updates verified? merged? real API tests? anything left?

## Log

- 2026-10-09: Code complete on the branch.
- 2026-10-09: Cloudflare token verified (tokens/verify 200, active); `wrangler whoami` OK (account a87d4b1c…).
- 2026-10-09: **Production backup** in `legacy/` (old code, binding names: ALLOWED_ORIGIN, OPENAI_API_KEY,
  VECTOR_STORE_ID). Production untouched. **Rollback target: version `391c5f37-4c08-4cef-97fc-03300b2c09b9`**
  (`npx wrangler rollback 391c5f37-4c08-4cef-97fc-03300b2c09b9`). The existing secret is named `OPENAI_API_KEY`, so
  the new code reuses it without changes.
- 2026-10-09: KV namespaces created: production `fbad1c79…`, staging `d08d9aaa…` (ids in `wrangler.jsonc`).
- 2026-10-09: Staging deployed. Checks passed: /health; /diag token-gated (404 without or with a wrong token); OAuth
  endpoints 404 while disabled; CORS only for alexeev.pw; foreign origin 403; 8,001-char message 413; all 6 live website
  pages extracted on Cloudflare; chat returns `ai_not_configured` (staging has no OpenAI key) after loading context.
- 2026-10-09: Rate limits on staging. Binding version (`952c8c0d`, fully propagated): 40 sequential requests from one
  colo (IAD), **0 throttled**; the global key does not depend on client IP. A paused Durable Object experiment
  (`fd569692`, staging only, created before Sergey's stop note, free plan, no token change): 40 sequential requests,
  **30 admitted then 10 × 429**, exact. Its namespace stays on staging, dormant, until Sergey decides (delete with a
  `deleted_classes` migration, or adopt). Staging now runs `952c8c0d` (binding + in-memory backstop).
- 2026-10-09: **Fixed-source test by Sergey** on staging `952c8c0d`: 40 sequential POSTs from one local client gave
  19 × 503 (`ai_not_configured`) and 21 × 429; no OpenAI calls were made. This confirms the `RL_IP` binding
  throttles a stable client once it exceeds its limit. It admitted 19 against a nominal 6 per minute: the binding is
  approximate, as Cloudflare documents. The earlier 0-throttle runs came from the cloud sandbox, whose egress IP
  rotates per request.
- **Decision (Sergey):** keep the binding-based version and the in-memory global fallback. Do not add or use a
  Durable Object. Do not run this load test against production.
- **On hold (Sergey):** Dropbox app shows only `account_info.read`; `files.metadata.read`/`files.content.read` are
  off, so no OAuth yet. The OpenAI key/credit question is unresolved. No production deploy or merge until these are
  resolved and end-to-end tests pass.
- 2026-10-09: **Production deployed** (Sergey authorised deploy + merge; Dropbox scopes still not approved).
  Pre-checks: rollback version `391c5f37` exists; production's only trigger is workers.dev (no routes, custom
  domains or zones); existing secrets kept (`OPENAI_API_KEY` reused). New version **`e6cec90a-34ba-456c-bdf3-49158fc067cd`**.
  Wrangler turned on Preview URLs (previously off); reverted via the API (`previews_enabled: false`), and
  `"preview_urls": false` added to `wrangler.jsonc`.
- 2026-10-09: **Production smoke test passed.** `/health` 200 on `e6cec90a` (ai_configured true,
  dropbox_configured false). One real chat ("recent paper on interviewers and drug use") → HTTP 200 in 3.8 s with the
  correct title, co-author, Journal of Population Economics (2026), post-print and film links, all matching the
  website. Errors are generic: foreign origin 403, malformed body 400, `/diag` 404 (no DIAG_TOKEN on production), OAuth
  endpoints 404. No load tests on production. Existing prepaid credit used; nothing purchased or changed in billing.
- **Still blocked:** Dropbox profile reading and auto-refresh. The app has only `account_info.read`, so production
  answers from the live website only and its prompt tells the model the profile is unavailable. To enable later: step 6
  of this runbook (scopes + redirect URI + `DROPBOX_APP_KEY` on staging, then `scripts/dropbox-auth.mjs --production`).
  No redeploy needed: the Worker picks the profile up once the secrets exist.

