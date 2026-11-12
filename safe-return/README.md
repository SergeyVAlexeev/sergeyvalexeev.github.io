# Safe Return microsite (`/safe-return/`)

Static section of alexeev.pw (no framework). Public and indexable.

## What is public

| Path | Content |
|---|---|
| `index.html`, `style.css`, `app.js`, `config.js`, `fonts/`, `img/` | the page, its styles and script, the open-licence fonts (OFL) and the cover images |
| `chapter-1.html` | Chapter 1 of the frozen v0.5.1 manuscript, converted to HTML. Checked word for word by `tools/verify-fidelity.mjs` |
| `audio/` | Locally generated Qwen3-TTS 1.7B narration of Chapter 1 with a small original synthetic cast: `.webm` (Opus 40 kb/s, used where supported), `.mp3` (64 kb/s, fallback and download), `ch1-timings.json` (start time of each of the 194 paragraphs, for "Follow in the text"). Built outside this repo; see below |
| `feedback-worker/` | source of the separate feedback Worker. No secrets, no data |
| `tools/`, `dev/` | local checks and preview server |

Not public and not in Git: `_private/` (source paths, guard hashes, local outputs), chapters 2 to 22, the full reading edition, and any feedback response. Feedback responses live only in the Worker's KV storage. There is no public read route.

## Configuration

`config.js` controls the page:
- `chapterUrl`: Chapter 1 (set).
- `pdfUrl`: `/safe-return/Safe_Return_Chapter_1.pdf`, the public Chapter 1 sample (cover, title page, Chapter 1, closing author note). Built from the public sample source, not the private reader edition.
- `feedbackEndpoint`: empty, so the form is off. Set it to the deployed Worker URL (`https://safe-return-feedback.<subdomain>.workers.dev/feedback`) and set `turnstileSiteKey`. Also replace `https://*.workers.dev` in the CSP `connect-src` in `index.html` with that exact origin.

- `audio`: the narration player. It shows when `audio.mp3` is set; `timings` drives paragraph highlighting and must list one time per `<p>` in `chapter-1.html` (otherwise follow-along stays off and the player still works); `duration` is in seconds.

## Narration

Generated, audited and mastered locally in the novel project folder (`06_manuscript/audio/chapter_01_narration/NUC1/`) with Qwen3-TTS 1.7B, not in this repository. To replace it, copy the production `.webm`, `.mp3` and `ch1-timings.json` into `audio/` and update `audio.duration`. The spoken text is the frozen v0.5.1 Chapter 1; source identity, span word streams, speaker assignments, mastering and per-paragraph diagnostic transcription are recorded with the production assets.

## Checks

```bash
node safe-return/tools/build-private-chapter.mjs   # needs safe-return/_private/paths.json (or SAFE_RETURN_TEX); regenerates chapter-1.html
node safe-return/tools/verify-fidelity.mjs         # chapter-1.html vs the frozen .tex: must print EXACT MATCH
node safe-return/tools/guard-hashes.mjs            # writes _private/canary-hashes.json from frozen chapters 2-22
node safe-return/tools/check-no-private.mjs        # release guard: must pass before every commit
node safe-return/dev/serve.mjs 4173                # local preview, feedback Worker running in memory
node safe-return/dev/serve.mjs 4174 --public       # local preview with _private/ and /api/ blocked
cd safe-return/feedback-worker && node --test test/feedback.test.mjs
```

The pre-commit hook in `.git/hooks/` runs the release guard.

## Feedback backend

Public routes: `POST /feedback` and `GET /health`. Admin routes need `Authorization: Bearer <ADMIN_TOKEN>`: `GET /admin/feedback?status=pending`, `POST /admin/feedback/:id` with `{"action":"approve"|"reject"}`, `DELETE /admin/feedback/:id`.

Spam controls fail closed (503) unless `TURNSTILE_SECRET` and `RATE_SALT` are set. The hostname check uses `TURNSTILE_HOSTNAME`. A rate-limit binding `RATE_LIMITER` is optional. Records expire at a fixed time: creation plus `RETENTION_DAYS` (default 365). Moderation never extends it. Each response returns a reference code.

### Deploy (needs the account owner)

```bash
cd safe-return/feedback-worker
npx wrangler login                                          # interactive browser sign-in
npx wrangler kv namespace create SAFE_RETURN_FEEDBACK       # paste the id into wrangler.jsonc
npx wrangler secret put ADMIN_TOKEN                         # 32+ random bytes
npx wrangler secret put RATE_SALT
npx wrangler secret put TURNSTILE_SECRET                    # from a Turnstile widget for www.alexeev.pw
npx wrangler deploy
```

Set `TURNSTILE_HOSTNAME=www.alexeev.pw` as a var. Then set `feedbackEndpoint` and `turnstileSiteKey` in `config.js` and push.

The Worker tests are not run in CI. Run them before deploying.
