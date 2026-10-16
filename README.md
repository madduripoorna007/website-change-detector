# Website Change Detector

Monitors public web pages and alerts you to **meaningful** changes, while ignoring noise like timestamps, counters, ads, rotating banners and random tokens.

## Features
| Requirement | How it's done |
|---|---|
| Add URL, name, interval (15 min to 24 h), headless rendering | Dashboard form, Playwright (Chromium), fresh context per check, no stored credentials |
| Scheduler + job queue, timeouts, retries | BullMQ on Redis: a 1-minute scheduler tick queues due targets; jobs have 30 s render timeout, 3 attempts with exponential backoff |
| Text + screenshot per check, new snapshot only on hash change | SHA-256 of cleaned text; a snapshot (text, cleaned HTML, PNG) is stored only when the hash differs |
| Noise filtering + sensitivity | Built-in noise selectors and regexes, **two-load auto learning**, per-watch ignore regions, sensitivity Low/Medium/High |
| Visual picker | Preview renders the page and returns element boxes; click to add CSS selectors to *watch* or *ignore* |
| Diffs | Line diff (green added / red removed), highlighted screenshot diff (pixelmatch), side-by-side for any two versions |
| Alerts | Email (SMTP), Discord webhook, Telegram bot; deduplicated by content hash; optional daily digest |
| Timeline + dashboard | Per-page version timeline; dashboard shows last checked, last changed, next check, status (OK / error / blocked) |
| Visual-only changes | Noise-masked screenshots are compared with pixelmatch; a swapped image or moved layout with identical text becomes a **visual** version and alert (per-watch, region-aware, can be switched off) |

## Security
- **Accounts:** username + password; passwords stored as salted **scrypt** hashes; sessions are random 256-bit tokens in an `HttpOnly`, `SameSite=Lax` cookie (only their SHA-256 is stored, with expiry). Login is rate limited (10 failures / 15 min).
- **Ownership on every private endpoint:** watches, checks, alerts, snapshots, compare, previews and **screenshots** are only served to a user who watches that page; others get `404`. Ids are validated so `?watch[$ne]=x` style NoSQL injection does nothing. RSS feeds use a per-watch secret token.
- **CSRF:** state-changing API calls must carry our own `Origin`.
- **SSRF:** URLs are checked for scheme, credentials and port, then **every resolved IP** is checked against private, loopback, link-local, CGNAT, multicast, cloud-metadata, IPv4-mapped/NAT64 IPv6 ranges (decimal/hex IP tricks are normalized first). In the browser, **every request** (page, images, iframes, `fetch()`) goes through a guard; redirects are never followed by the browser itself but re-validated hop by hop. Server-side fetches (robots.txt, conditional GET) use a socket-level DNS lookup that refuses private IPs, closing the DNS-rebinding gap. For the local demo only, exact `host:port` pairs can be allowed with `PRIVATE_HOST_ALLOWLIST`.
- **Headers:** CSP, `X-Frame-Options: DENY`, `nosniff`; the Docker image runs as a non-root user.

## Reliable alerts
Every alert is stored (with its exact message) **before** sending; a unique key per change means it is never sent twice. Each channel is delivered and tracked separately (`sent` / `retrying` / `failed`, shown in the dashboard). HTTP responses are checked, so a deleted Discord webhook (404) is a failure, not a silent success. Temporary failures (SMTP down or `4xx`, timeouts, `5xx`, `429` with `Retry-After`) are retried after 1, 5, 15, 60 and 180 minutes; permanent ones (SMTP `5xx` rejection, deleted webhook, unknown Telegram chat) stop immediately. Working channels are never resent when another one is retried. Channels are validated when a watch is saved.

**Bonus done:** keyword-only alerts, number tracking with chart, AI one-line summaries (OpenAI-compatible, optional), per-page RSS feed.

## Architecture
```
 Browser (dashboard SPA)
        │  REST
        ▼
 Express API ───────── MongoDB (targets, watches, snapshots, checks, alerts)
        │ enqueue            ▲
        ▼                    │
 Redis / BullMQ ──► Worker(s): robots.txt → domain slot → conditional GET
                              → Playwright render → block/CAPTCHA check
                              → clean + hash → snapshot? → evaluate each watch → alerts
```
Key idea: **Target** (one per normalized URL, fetched once) is separate from **Watch** (one per user subscription with its own regions, sensitivity and alert channels).

## Design questions

### 1. Is a site outage or CAPTCHA a change?
No. Every check is classified first:
- **error**: timeouts, DNS failures, HTTP 404/410/5xx
- **blocked**: HTTP 401/403/429, CAPTCHA or bot-challenge markers (reCAPTCHA, hCaptcha, Cloudflare challenge, "verify you are human"), robots.txt disallow, or the page's text collapsing by more than 90% versus the last good version

Failed checks never create a snapshot, so the next good check is compared with the last good version and no false "change" fires. The status shows on the dashboard; after 3 consecutive failures each watcher gets **one** "unreachable" alert and one "back online" alert when it recovers.

### 2. If 200 users watch the same URL, is it fetched 200 times?
No. URLs are normalized (lowercase host, `www.` removed, fragment removed, query params sorted, tracking params like `utm_*`, `fbclid`, `gclid` dropped). One `Target` per normalized URL is fetched at the **shortest interval any watcher chose**. Each user's selectors, ignore regions, sensitivity and keywords are applied to that shared snapshot (stored cleaned HTML) inside the worker. A new watcher on an already-monitored page gets a baseline from the existing snapshot with zero extra requests. BullMQ job ids are the target id, so a target can't be queued twice.

### 3. How to avoid endless alerts on pages that differ on every load?
Layers, from cheapest to smartest:
1. **Strip noisy elements**: scripts, styles, iframes, ads, cookie banners, carousels/sliders, live regions, counters, hidden inputs, nonce/CSRF attributes.
2. **Normalize text**: dates, times, "5 minutes ago", UUIDs, long hex/base64 tokens, "1,204 views"-style counters become placeholders before hashing.
3. **Auto-learn noise**: when a page is first added it is loaded twice, 3 s apart. Any small element whose text differs between the two loads is saved as an auto-ignore selector.
4. **User regions**: watch only selected regions and/or ignore regions via the visual picker.
5. **Sensitivity**: Low ≥10%, Medium ≥2%, High any change of text. Below-threshold changes keep the old baseline so slow drift still adds up and eventually alerts.
6. **Dedupe**: alerts have a unique key `watchId:contentHash`, so the same content never alerts twice; digest mode batches a day of changes into one message.

### 4. How to avoid hammering a site?
- Minimum interval 15 minutes, plus random jitter (0–10% of interval) so checks don't line up
- **Per-domain spacing** across all workers using a Redis lock (default one request per domain every 10 s); jobs that can't get a slot are delayed, not dropped
- Global worker rate limit and concurrency cap
- **Conditional requests** (`If-None-Match` / `If-Modified-Since`) before a full browser render; a 304 skips Playwright entirely
- Respects `robots.txt` (cached 24 h), `429` and `Retry-After`; exponential backoff on failures (5 min → 12 h)
- Ad/analytics hosts and media are blocked during rendering; the bot sends an honest User-Agent
- One fetch per URL regardless of watcher count (question 2)

## Run it

### With Docker (easiest)
```bash
cp .env.example .env
docker compose up --build
```
Open http://localhost:3000, create an account, add a page.

To try it with the built-in noisy demo store (and run the full end-to-end test inside the stack):
```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml up --build -d
docker compose -f docker-compose.yml -f docker-compose.demo.yml exec web node scripts/e2e.js http://localhost:3000 http://demo:4000
```
Then add `http://demo:4000/product` in the dashboard.

### Without Docker
Needs Node 18+, MongoDB and Redis running locally.
```bash
npm install
npx playwright install chromium
cp .env.example .env
npm start          # API + dashboard on :3000
npm run worker     # in a second terminal
```

### Local demo (noisy test page)
```bash
node demo/demo-site.js            # http://localhost:4000/product
# in .env: PRIVATE_HOST_ALLOWLIST=localhost:4000   (demo only, keep empty in production)
# real change:    curl -X POST 'localhost:4000/admin/price?value=799'
# visual only:    curl -X POST 'localhost:4000/admin/image?theme=red'   or   '/admin/layout?value=right'
# full workflow:  MANUAL_CHECK_COOLDOWN_MS=2000 on the API, then  node scripts/e2e.js
```

### Tests
```bash
npm test
```
35 tests. Unit tests need nothing; the alert, API-security and browser SSRF tests use a local MongoDB/Redis (`TEST_MONGO_URL`, `TEST_REDIS_URL`) and Chromium (`CHROMIUM_PATH`) and skip themselves if those are missing.
- `core` / `imagediff`: URL normalization, noise filtering, selectors, CAPTCHA/outage detection, robots.txt, screenshot diff
- `noise-learning`: a changing counter inside the price's container can never hide a price update
- `ssrf`: internal IPs in every disguise, DNS rebinding, redirects and sub-resources in a real browser
- `api-security`: sessions, password hashing, lockout, CSRF, ownership on every endpoint, NoSQL injection, RSS token
- `alerts`: SMTP down / 451 / 550, deleted and invalid webhooks, 429, retries with backoff, recovery, no duplicates

## Alerts setup
- **Email**: fill `SMTP_*` in `.env` (Gmail works with an app password).
- **Discord**: Server Settings → Integrations → Webhooks → copy URL into the watch.
- **Telegram**: create a bot with @BotFather, put its token in `TELEGRAM_BOT_TOKEN`, message the bot, get your chat id from `https://api.telegram.org/bot<token>/getUpdates`, put it in the watch.
- **AI summaries** (optional): set `OPENAI_API_KEY` (any OpenAI-compatible endpoint via `OPENAI_BASE_URL`).

## Project structure
```
src/
  server.js     REST API + static dashboard
  worker.js     check pipeline, scheduler tick, daily digest
  render.js     Playwright rendering, screenshots, element boxes for the picker
  noise.js      noise removal, text extraction, hashing, CAPTCHA detection, noise learning
  diff.js       text diff, change ratio, screenshot diff
  polite.js     robots.txt, per-domain lock, conditional requests, backoff
  alerts.js     email / Discord / Telegram, dedupe, digest
  summarize.js  AI one-line summary with plain fallback
  queue.js      BullMQ queues
  db.js         Mongo models
  url.js        URL normalization, IP classification, SSRF checks
  safefetch.js  server-side GET with per-hop + socket-level private-IP blocking
  auth.js       accounts, scrypt passwords, cookie sessions, CSRF origin check
  visual.js     screenshot comparison for visual-only changes
public/         dashboard (vanilla JS)
test/           node:test tests
scripts/e2e.js  end-to-end workflow test against a running stack
demo/           noisy demo store (clock, ads, counters, tokens; admin endpoints for price, image, layout)
```

## Limitations / next steps
- No password reset or email verification yet; serve over HTTPS and set `COOKIE_SECURE=true` in production.
- For the strongest SSRF isolation in production, also run the worker behind an egress proxy or firewall that blocks private ranges.
- Screenshots are stored on local disk; move to S3/Cloudinary for multi-server deploys.
- Browser extension bonus not included.
