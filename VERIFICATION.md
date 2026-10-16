# Verification log (16 Oct 2026)

| # | Check | Result |
|---|---|---|
| 1 | Clean `npm ci` + original suite | Fresh install from the original zip: 9/9 tests pass |
| 2 | Noise-learning ancestors | Proved the old learner hid the price when the counter had its own id (`#card` + `#live-count` both ignored, price change missed). Rewrote learning on the DOM: only leaf text is learnable, partly-changing lines mask just the changing words. 5 regression tests |
| 3 | Auth, ownership, SSRF | Accounts (scrypt), HttpOnly sessions, lockout, CSRF origin check, ownership on every endpoint incl. screenshots and snapshots, RSS token, NoSQL-injection guard. SSRF: DNS-resolved IP checks, redirect hop validation in the browser and server-side, sub-resource blocking. Found and fixed: the browser silently followed redirects to internal hosts. 13 tests |
| 4 | Alert reliability | Per-channel delivery tracking, HTTP status checks (a 404 webhook used to count as sent), backoff retries 1/5/15/60/180 min, permanent vs temporary errors, recovery. Tested against a real local SMTP server (down, 451, 550) and scripted Discord/Telegram responses. 8 tests |
| 5 | Visual-only changes | Before: an image swap or layout move with identical text was invisible. Now: noise-masked screenshot comparison, region-aware per watch. Demo store: image swap -> visual alert (6.4% of page); price-only watcher not alerted; layout move -> price-region watcher alerted (32.3%); noise-only reloads stay unchanged |
| 6 | Full Docker stack | `docker compose -f docker-compose.yml -f docker-compose.demo.yml up` (mongo, redis, web, worker, demo) + `scripts/e2e.js` inside the stack: 22/22 checks pass. Found and fixed: an empty `CHROMIUM_PATH=` in `.env` broke Chromium in the container |

Total automated tests: 35/35 passing (`npm test`). End-to-end: 22/22 natively and 22/22 in Docker.
