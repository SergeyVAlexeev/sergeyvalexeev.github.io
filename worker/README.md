# Sergey AI backend (Cloudflare Worker)

The "Ask Sergey AI" chat on https://www.alexeev.pw/ posts `{ messages }` to this Worker
(`alexeev-website-chat`). The Worker builds context from two live sources, calls an
OpenAI-compatible model and returns `{ text }`, or `{ error: { code, message } }` on failure.

```
browser (index.html) ──POST──> Worker ──> Dropbox API: /Job hunting/PROFILE.md (revision check every request)
                                      ──> www.alexeev.pw pages (extracted, cached 10 min)
                                      ──> OpenAI Chat Completions (model from OPENAI_MODEL)
                               KV "CACHE": last-good profile and website snapshots, daily usage counter
```

## Files

| Path | Purpose |
|---|---|
| `src/index.js` | Routing, CORS, `/health`, `/diag` |
| `src/chat.js` | Request validation and limits, context assembly, user-facing error messages |
| `src/system-prompt.md` | The system prompt. Edit freely; it is bundled at deploy time |
| `src/profile.js` | Dropbox refresh-token auth, revision check, download, referee filtering, fallback |
| `src/website.js` | Page fetching, HTML-to-text extraction, caching |
| `src/llm.js` | AI provider call and error classification |
| `src/config.js` | Every tunable and its default. Each can be overridden by a Worker variable |
| `wrangler.jsonc` | Worker name, bindings, rate limits, `staging` environment |
| `test/` | `npm test`: scenario tests with mocked Dropbox, website and OpenAI |
| `scripts/dropbox-auth.mjs` | One-time Dropbox authorisation that stores secrets in Cloudflare |
| `scripts/backup-live-worker.mjs` | Saves the deployed Worker's code and binding names to `legacy/` |

## Sources of truth

- **Profile:** `/Job hunting/PROFILE.md` in Sergey's Dropbox (`C:\Users\serge\Dropbox\Job hunting\PROFILE.md` locally).
  Preferred for roles, experience, expertise, methods and supervision. Sections whose heading
  matches `PROFILE_EXCLUDE_HEADINGS` (default `referee`) are removed before caching or sending to the model.
- **Website:** pages listed in `WEBSITE_PAGES` (homepage, the two research films, REVALUE-AU, HOPE, FAMILY).
  Preferred for publications, their status and links. HTML comments, scripts, navigation, forms,
  buttons and hidden elements (such as the chat panel) are dropped. To add a page, append its URL to `WEBSITE_PAGES`.
- **Behaviour:** `src/system-prompt.md`.

Nothing else holds content: there is no vector store and nothing to upload.

## How updates propagate

**Profile.** On every chat request the Worker asks Dropbox for the file's current revision (one small
metadata call, cached access token). If the revision differs from the cached copy it downloads that
revision. So an edit appears in the next chat request after Dropbox has finished syncing the file
from the PC. If Dropbox is unreachable or the token is revoked, the last good copy (memory, then KV)
is used and the model is told how long ago it was last confirmed current. With no copy at all, the
bot answers from the website only and says the profile is unavailable. If the website is also
unavailable, it returns `context_unavailable`.

The profile states that newer CVs may contain later facts. Automatic syncing makes the bot use the
latest *file*; it does not make an unchanged file current. Keep its `Last updated` line accurate.

**Website.** Extracted pages are cached for `WEBSITE_TTL_SECONDS` (600 s). GitHub Pages itself caches
for about 10 minutes, so a site change reaches the bot within roughly 20 minutes of the Pages
deployment finishing. If a page fetch fails, its last good copy is used and the next attempt is after
60 s.

## Endpoints

- `POST /` (or `/chat`): chat. Only allowed from `ALLOWED_ORIGINS`.
- `GET /health`: public. Only booleans and coarse status, with no network calls.
- `GET /diag` with header `Authorization: Bearer <DIAG_TOKEN>`: live checks. Shows the Dropbox revision,
  the modification time, when the copy was last confirmed current, the profile's `Last updated` line,
  a hash of the profile text, per-page website status, AI key/model access, and today's usage with an
  estimated cost. Add `?ai=probe` to send one tiny real AI request (detects exhausted credit, costs
  well under $0.001). Add `?refresh=1` to refetch the website now. Returns 404 if `DIAG_TOKEN` is unset or wrong.

```
curl -s -H "Authorization: Bearer $DIAG_TOKEN" https://alexeev-website-chat.sergei-v-alexeev.workers.dev/diag
```

## Credentials (Cloudflare secrets, never in Git)

| Secret | What |
|---|---|
| `OPENAI_API_KEY` | OpenAI key from project `website-chat` |
| `DROPBOX_APP_KEY` | Dropbox app `Sergey-AI-Website` (Full Dropbox; scopes `files.metadata.read`, `files.content.read`) |
| `DROPBOX_REFRESH_TOKEN` | Long-lived PKCE refresh token from `scripts/dropbox-auth.mjs`; renews with the app key alone, so no app secret is stored |
| `DIAG_TOKEN` | Any long random string; protects `/diag` |

Add `--env staging` to target the staging Worker.

- **Dropbox (set up or rotate):** add the app key as secret `DROPBOX_APP_KEY` on the staging Worker
  (Cloudflare dashboard → Workers → `alexeev-website-chat-staging` → Settings → Variables and Secrets), and register the
  redirect URI `https://alexeev-website-chat-staging.sergei-v-alexeev.workers.dev/oauth/dropbox` in the Dropbox app.
  Then run `node scripts/dropbox-auth.mjs --production` and give the person the printed link. They click Allow;
  the staging Worker does the PKCE exchange, checks the scopes and the profile path, and the script moves the token into
  secrets on both Workers and disables the endpoint. To revoke: Dropbox → Settings → Connected apps.
- **OpenAI:** create a key in the `website-chat` project, then run `npx wrangler secret put OPENAI_API_KEY`
  and paste the key at the prompt. Delete the old key in OpenAI once the new one is confirmed working.
- **Diagnostics token:** `npx wrangler secret put DIAG_TOKEN` (generate one with
  `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`).
- `npx wrangler secret list` shows which secrets exist (names only).

For local runs, copy `.dev.vars.example` to `.dev.vars` (git-ignored).

## Deploy and roll back

```
cd worker
npm ci
npm test                              # must pass
npx wrangler deploy --env staging     # test Worker: alexeev-website-chat-staging.<subdomain>.workers.dev
npx wrangler deploy                   # production Worker alexeev-website-chat
```

One-time production setup: create the KV namespace with `npx wrangler kv namespace create CACHE`
and put the returned id in `wrangler.jsonc`.

**Rollback:** `npx wrangler deployments list` shows the history; `npx wrangler rollback [version-id]`
makes an earlier version (any of the last 100) active immediately. Deploys don't delete existing
secrets, but Cloudflare doesn't document how rollback treats secrets changed since. So don't delete or
rename the secret an older version uses (e.g. its OpenAI key) until the new version is confirmed working.
After a rollback, check `/health`. The frontend works with both the old and the new Worker; revert the
`index.html` commit only if needed.

Note: `wrangler secret put` creates and deploys a new version immediately, carrying the code that is
currently live. Adding secrets therefore doesn't change behaviour, but it shows up in the deployment history.

The website itself is GitHub Pages: changes to `index.html` go live when merged to `main`.

## Changing the AI model

Set `OPENAI_MODEL` in `wrangler.jsonc` `vars` and deploy, or change it in the dashboard under
Worker → Settings → Variables. For reasoning models, `OPENAI_REASONING_EFFORT` (`none`, `low`, …) controls
hidden reasoning tokens, which are billed as output. Set it to an empty string for models that don't accept the
parameter. Update `PRICE_*_PER_M` so the `/diag` cost estimate stays right. Any provider with an
OpenAI-compatible `/chat/completions` endpoint can be used by setting `OPENAI_BASE_URL` and that provider's
key in `OPENAI_API_KEY`.

Default: `gpt-6-luna` ($0.10 input / $0.01 cached input / $0.50 output per 1M tokens, Oct 2026),
reasoning effort `low`.

## Cost and abuse limits

A request carries about 17,000 prompt tokens: the system prompt plus about 54,000 characters of website
text plus the profile. At `gpt-6-luna` prices that is about $0.002 for a first turn. Follow-up turns
within a few minutes reuse OpenAI's prompt cache and cost about $0.0005. A typical five-turn conversation
costs about $0.005–0.01, so $5 covers roughly 500–1,000 conversations. These figures are approximate;
`/diag` shows actual usage.

| Limit | Default | Setting |
|---|---|---|
| Per-IP requests | 6 per minute (binding per location, plus in-memory per isolate) | `ratelimits`, `RATE_LIMIT_PER_IP_PER_MIN` |
| All visitors | 30 per minute (same mechanisms) | `ratelimits`, `RATE_LIMIT_GLOBAL_PER_MIN` |
| Daily chats | 300 (approximate, KV) | `DAILY_CHAT_LIMIT` |
| Message length | 8,000 characters | `MAX_USER_MESSAGE_CHARS` |
| History | 12 messages, 24,000 characters | `MAX_HISTORY_MESSAGES`, `MAX_HISTORY_CHARS` |
| Output | 1,200 tokens (including reasoning) | `MAX_OUTPUT_TOKENS` |
| AI timeout | 30 s (the browser gives up at 45 s) | `OPENAI_TIMEOUT_MS` |
| Request origin | alexeev.pw only | `ALLOWED_ORIGINS` |

The per-minute limits are approximate. In a staging test on 9 Oct 2026, 40 sequential requests from one fixed client
gave 19 answers and 21 × 429: the per-IP binding throttles a stable client, but lets more through than its nominal
limit. Requests whose source IP changes each time (as from some cloud hosts) were not throttled by the binding. The
in-memory window is a per-isolate backstop for the global limit. A Durable Object limiter is deliberately not used.
Worst case at the daily cap is about $1 per day. OpenAI auto-recharge stays off, so the prepaid balance is
the hard ceiling. A monthly budget can also be set in OpenAI under Project → Limits.

## Diagnosing failures

- **Chat says "AI service credit has run out":** OpenAI returned `credit_balance_exhausted`
  (or a spend-limit code). Check `/diag?ai=probe` → `ai.probe.code = ai_credit_exhausted`, then add
  credit at https://platform.openai.com/settings/organization/billing/. No redeploy is needed.
- **"configuration problem":** `ai_auth_failed` (bad or revoked key), `ai_request_rejected` (wrong
  model name or parameter), or `ai_not_configured`. `/diag` → `ai.model_access` shows the reason.
- **Profile stale or unavailable:** `/diag` → `profile.status` and `profile.error`. `invalid_grant` means the
  refresh token was revoked: rerun `scripts/dropbox-auth.mjs`. `path/not_found` means the file was moved or
  renamed: update `DROPBOX_PROFILE_PATH`.
- **Logs:** Cloudflare dashboard → Worker → Logs (Workers Logs, free tier), or `npx wrangler tail`. Each
  request logs one JSON line (`chat_ok`, `chat_error`, `profile_loaded`, `profile_error`, `website_page_error`, …)
  with codes, timings and token counts, never message text or credentials.

## Verifying freshness

1. Edit a harmless line in `PROFILE.md` and save. Wait for the Dropbox tray icon to show synced.
2. Open `/diag`: `profile.revision` and `profile.dropbox_modified` change, and `last_updated_line` shows the file's line.
3. Ask Sergey AI about the edited fact; the answer uses the new text. Revert the edit afterwards.
4. Website: `/diag?refresh=1` lists each page with `fetched_at` and character count.

## Tests

`npm test` runs the scenario suite (Node's built-in runner, no extra dependencies). It covers profile
revision changes, referee filtering, website extraction and caching, credit and other provider errors,
Dropbox and website outages with fallback, conversation handling, every limit, and that no secret
reaches responses or logs. `npm run check` builds the Worker without deploying. CI runs both
(`.github/workflows/worker-tests.yml`).
