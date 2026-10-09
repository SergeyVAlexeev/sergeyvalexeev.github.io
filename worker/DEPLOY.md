# First production rollout of the new Sergey AI (runbook)

Status log and exact steps for finishing the rollout. A coding agent continuing this work
should read `worker/README.md`, then work through the steps below in order, ticking them off and
recording results in the **Log** at the end. Commit and push the updates to this file as you go.

**Authorisation (from Sergey, 9 Oct 2026):** the agent may deploy staging and production, configure
Cloudflare, merge the branch `claude/exciting-hypatia-w84i84` into `main` and publish, once tests
pass, without asking again. Do not change unrelated parts of the website or the CV link. Never purchase
OpenAI credit or enable auto-recharge. Never print or commit credentials, and never ask Sergey to paste one into chat.

## Required environment variables (set by Sergey in the cloud environment settings)

| Variable | Source |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare custom token: Account › Workers Scripts › Edit; Account › Workers KV Storage › Edit; Account › Account Settings › Read; User › Memberships › Read; User › User Details › Read |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard, Workers & Pages overview (right sidebar) |
| `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET` | Dropbox app console › `Sergey-AI-Website` › Settings |

Dropbox app settings that Sergey must have made: permission type **Full Dropbox**; scopes
`files.metadata.read` and `files.content.read` (submitted); redirect URI
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
   printed link (his only action is to click Allow) and wait for it to finish. Note that adding secrets to production
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

- 2026-10-09: Code complete on the branch (35 tests). Waiting for environment variables, Dropbox redirect URI and OpenAI credit.
