require('dotenv').config();
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');

module.exports = {
  port: Number(process.env.PORT || 3000),
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  mongoUrl: process.env.MONGO_URL || 'mongodb://localhost:27017/changedetector',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  dataDir: DATA_DIR,
  screenshotDir: path.join(DATA_DIR, 'screenshots'),
  perDomainGapMs: Number(process.env.PER_DOMAIN_GAP_MS || 10000),
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY || 3),
  // use a system Chromium instead of Playwright's download (an empty value in .env must not hide the image's default)
  chromiumPath: process.env.CHROMIUM_PATH || (require('fs').existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
  // Exact host:port pairs that may be monitored even though private, e.g. "localhost:4000" for the demo store.
  // Leave empty in production: every other private, loopback, link-local or metadata address is blocked.
  privateHostAllowlist: (process.env.PRIVATE_HOST_ALLOWLIST || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  sessionDays: Number(process.env.SESSION_DAYS || 14),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  userAgent: process.env.USER_AGENT || 'ChangeDetectorBot/1.0',
  manualCheckCooldownMs: Number(process.env.MANUAL_CHECK_COOLDOWN_MS || 60000),
  minIntervalMin: 15,
  maxIntervalMin: 24 * 60,
  renderTimeoutMs: 30000,
  failuresBeforeDownAlert: 3,
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM || 'Change Detector <alerts@example.com>',
  },
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  openai: {
    key: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },
  digestHourUtc: Number(process.env.DIGEST_HOUR_UTC || 3),
  // sensitivity -> minimum fraction of changed characters that counts as a change
  sensitivity: { low: 0.10, medium: 0.02, high: 0 },
  // sensitivity -> minimum % of (watched) screenshot pixels that must change for a visual-only alert
  visualSensitivity: { low: 5, medium: 1, high: 0.3 },
  visualSnapshotMinPct: 0.3, // below this, a text-identical render is not even stored as a new version
};
