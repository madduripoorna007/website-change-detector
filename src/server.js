// HTTP API + dashboard.
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const { Target, Watch, Snapshot, Check, Alert, NumberPoint } = db;
// Every id that comes from the request must be a plain 24-hex string. This stops NoSQL operator
// injection such as ?watch[$ne]=x (Express would parse that into an object).
function oid(v) {
  if (typeof v !== 'string' || !/^[a-f0-9]{24}$/i.test(v)) throw Object.assign(new Error('Not found'), { status: 404 });
  return v;
}
const { enqueueCheck } = require('./queue');
const crypto = require('crypto');
const { normalizeUrl, checkUrl } = require('./url');
const auth = require('./auth');
const { textDiff, imageDiff } = require('./diff');
const { extractText } = require('./noise');
const { render } = require('./render');
const polite = require('./polite');

fs.mkdirSync(config.screenshotDir, { recursive: true });

const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---------- Authentication ----------
app.use('/api', auth.sameOrigin);
app.post('/api/auth/register', wrap(auth.register));
app.post('/api/auth/login', wrap(auth.login));
app.post('/api/auth/logout', wrap(auth.logout));

// RSS is the one route a feed reader calls without a session: it carries a per-watch secret token instead.
app.get('/api/watches/:id/rss', wrap(async (req, res) => {
  const w = await Watch.findById(oid(req.params.id)).populate('target');
  const token = String(req.query.token || '');
  if (!w || !w.rssToken || token.length !== w.rssToken.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(w.rssToken))) {
    return res.status(404).end();
  }
  const items = await Alert.find({ watch: w._id, kind: { $in: ['change', 'visual'] } }).sort({ createdAt: -1 }).limit(50);
  const esc = (v) => String(v || '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${esc(w.name)} changes</title><link>${esc(w.target.url)}</link><description>Changes detected on ${esc(w.target.url)}</description>
${items.map((a) => `<item><title>${esc(a.summary)}</title><link>${esc(`${config.baseUrl}/#/compare/${w._id}/${a.fromSnapshot}/${a.toSnapshot}`)}</link><guid isPermaLink="false">${a._id}</guid><pubDate>${a.createdAt.toUTCString()}</pubDate></item>`).join('\n')}
</channel></rss>`;
  res.type('application/rss+xml').send(xml);
}));

// Everything below needs a logged-in user.
app.use('/api', auth.requireUser);
app.use('/screenshots', auth.requireUser);
app.get('/api/auth/me', (req, res) => res.json({ username: req.user }));

const owner = (req) => req.user;
const userTag = (u) => crypto.createHash('sha256').update(u).digest('hex').slice(0, 16);

// Screenshots are private: only someone watching that page (or who made the preview) may load them.
app.get('/screenshots/:file', wrap(async (req, res) => {
  const file = req.params.file;
  if (!/^[A-Za-z0-9_.-]+\.png$/.test(file)) throw httpError(404, 'Not found');
  let allowed = false;
  if (file.startsWith('preview_')) allowed = file.startsWith(`preview_${userTag(req.user)}_`);
  else {
    const targetId = file.replace(/^diff_/, '').split('_')[0];
    if (/^[a-f0-9]{24}$/.test(targetId)) allowed = !!(await Watch.exists({ target: targetId, owner: req.user }));
  }
  if (!allowed) throw httpError(404, 'Not found');
  res.setHeader('Cache-Control', 'private, max-age=604800');
  res.sendFile(path.join(config.screenshotDir, file), (err) => { if (err && !res.headersSent) res.status(404).end(); });
}));

function clampInterval(n) {
  const v = Number(n) || 60;
  return Math.min(Math.max(v, config.minIntervalMin), config.maxIntervalMin);
}

function list(v) {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
  return [];
}

async function validUrl(raw) {
  let normalized;
  try { normalized = normalizeUrl(String(raw || '')); } catch (e) { throw httpError(400, e.message.includes('Invalid URL') ? 'Enter a full URL starting with http:// or https://' : e.message); }
  const verdict = await checkUrl(normalized, { allowlist: config.privateHostAllowlist });
  if (!verdict.ok) throw httpError(400, `Only public pages can be monitored (${verdict.reason})`);
  return { normalized, domain: new URL(normalized).hostname };
}

const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,255}\.[a-z]{2,}$/i;
const DISCORD = /^https:\/\/(?:canary\.|ptb\.)?(discord|discordapp)\.com\/api\/webhooks\/\d{5,30}\/[\w-]{20,100}$/;
const TELEGRAM = /^(-?\d{4,20}|@[A-Za-z0-9_]{5,32})$/;
function validChannels(ch = {}) {
  const out = {};
  if (ch.email) { if (!EMAIL.test(ch.email)) throw httpError(400, 'Email address looks invalid'); out.email = String(ch.email).trim(); }
  if (ch.discordWebhook) { if (!DISCORD.test(ch.discordWebhook)) throw httpError(400, 'Discord webhook must look like https://discord.com/api/webhooks/<id>/<token>'); out.discordWebhook = ch.discordWebhook; }
  if (ch.telegramChatId) { if (!TELEGRAM.test(String(ch.telegramChatId))) throw httpError(400, 'Telegram chat id must be a number or @channel'); out.telegramChatId = String(ch.telegramChatId); }
  return out;
}

// Target interval = the shortest interval any watcher asked for.
async function syncTargetInterval(targetId) {
  const watches = await Watch.find({ target: targetId, active: true }).select('intervalMin');
  if (!watches.length) return;
  const min = Math.min(...watches.map((w) => w.intervalMin));
  const t = await Target.findById(targetId);
  if (t.intervalMin !== min) {
    t.intervalMin = min;
    const next = new Date((t.lastCheckedAt?.getTime() || Date.now()) + min * 60000);
    if (next < t.nextCheckAt) t.nextCheckAt = next;
    await t.save();
  }
}

function watchFields(body) {
  return {
    name: String(body.name || '').slice(0, 120),
    intervalMin: clampInterval(body.intervalMin),
    watchSelectors: list(body.watchSelectors),
    ignoreSelectors: list(body.ignoreSelectors),
    sensitivity: ['low', 'medium', 'high'].includes(body.sensitivity) ? body.sensitivity : 'medium',
    keywords: list(body.keywords),
    numberSelector: body.numberSelector ? String(body.numberSelector) : undefined,
    channels: validChannels(body.channels),
    visualAlerts: body.visualAlerts === undefined ? true : !!body.visualAlerts,
    digest: !!body.digest,
  };
}

app.get('/api/watches', wrap(async (req, res) => {
  const watches = await Watch.find({ owner: owner(req) }).populate('target').sort({ createdAt: -1 });
  res.json(watches.map((w) => ({
    _id: w._id,
    name: w.name,
    url: w.target?.url,
    intervalMin: w.intervalMin,
    sensitivity: w.sensitivity,
    status: w.target?.status,
    lastError: w.target?.lastError,
    lastCheckedAt: w.target?.lastCheckedAt,
    lastChangedAt: w.lastChangedAt,
    nextCheckAt: w.target?.nextCheckAt,
    active: w.active,
  })));
}));

app.post('/api/watches', wrap(async (req, res) => {
  const user = owner(req);
  const { normalized, domain } = await validUrl(req.body.url);
  const fields = watchFields(req.body);
  if (!fields.name) fields.name = domain;

  let target = await Target.findOne({ normalizedUrl: normalized });
  const isNew = !target;
  if (!target) {
    target = await Target.create({ url: req.body.url.trim(), normalizedUrl: normalized, domain, intervalMin: fields.intervalMin, nextCheckAt: new Date() });
  }
  const watch = await Watch.create({ ...fields, owner: user, target: target._id, rssToken: crypto.randomBytes(24).toString('base64url') });
  await syncTargetInterval(target._id);
  if (isNew || !target.lastSnapshot) await enqueueCheck(target._id);
  else await (require('./worker').evaluateWatch)(watch, await Snapshot.findById(target.lastSnapshot), target, true); // baseline from shared snapshot, no new fetch
  res.status(201).json({ _id: watch._id, sharedTarget: !isNew });
}));

async function ownWatch(req) {
  const w = await Watch.findOne({ _id: oid(req.params.id), owner: owner(req) }).populate('target');
  if (!w) throw Object.assign(new Error('Not found'), { status: 404 });
  return w;
}

app.get('/api/watches/:id', wrap(async (req, res) => {
  const w = await ownWatch(req);
  if (!w.rssToken) { w.rssToken = crypto.randomBytes(24).toString('base64url'); await w.save(); }
  const [snapshots, checks, alerts, numbers, watchers] = await Promise.all([
    Snapshot.find({ target: w.target._id }).select('createdAt title screenshot contentHash visualOnly visualPct').sort({ createdAt: -1 }).limit(200),
    Check.find({ target: w.target._id }).sort({ createdAt: -1 }).limit(30),
    Alert.find({ watch: w._id }).sort({ createdAt: -1 }).limit(50),
    NumberPoint.find({ watch: w._id }).sort({ createdAt: 1 }).limit(500),
    Watch.countDocuments({ target: w.target._id, active: true }),
  ]);
  const t = w.target;
  res.json({
    watch: w,
    target: { _id: t._id, url: t.url, status: t.status, lastError: t.lastError, lastCheckedAt: t.lastCheckedAt, lastChangedAt: t.lastChangedAt, nextCheckAt: t.nextCheckAt, autoIgnore: t.autoIgnore, autoMask: t.autoMask },
    snapshots, checks, alerts, numbers, watchers,
    rssUrl: `${config.baseUrl}/api/watches/${w._id}/rss?token=${w.rssToken}`,
  });
}));

app.patch('/api/watches/:id', wrap(async (req, res) => {
  const w = await ownWatch(req);
  const fields = watchFields({ ...w.toObject(), ...req.body, channels: { ...w.channels, ...(req.body.channels || {}) } });
  const regionsChanged = JSON.stringify([fields.watchSelectors, fields.ignoreSelectors]) !== JSON.stringify([w.watchSelectors, w.ignoreSelectors]);
  Object.assign(w, fields);
  if (typeof req.body.active === 'boolean') w.active = req.body.active;
  if (regionsChanged) { w.lastHash = undefined; w.lastText = undefined; } // re-baseline, avoid a false alert
  await w.save();
  await syncTargetInterval(w.target._id);
  res.json({ ok: true });
}));

app.delete('/api/watches/:id', wrap(async (req, res) => {
  const w = await ownWatch(req);
  await w.deleteOne();
  await Alert.deleteMany({ watch: w._id });
  await NumberPoint.deleteMany({ watch: w._id });
  await syncTargetInterval(w.target._id);
  res.json({ ok: true });
}));

app.post('/api/watches/:id/check', wrap(async (req, res) => {
  const w = await ownWatch(req);
  if (w.target.lastCheckedAt && Date.now() - w.target.lastCheckedAt.getTime() < config.manualCheckCooldownMs) {
    return res.status(429).json({ error: 'Checked less than a minute ago' });
  }
  await enqueueCheck(w.target._id, { manual: true });
  res.json({ queued: true });
}));

app.get('/api/snapshots/:id', wrap(async (req, res) => {
  const s = await Snapshot.findById(oid(req.params.id)).select('-html');
  if (!s || !(await Watch.exists({ target: s.target, owner: req.user }))) return res.status(404).json({ error: 'Not found' });
  res.json(s);
}));

// Compare any two versions: text diff (scoped to the watch's regions) + screenshot diff.
app.get('/api/compare', wrap(async (req, res) => {
  const w = await Watch.findOne({ _id: oid(req.query.watch), owner: owner(req) }).populate('target');
  if (!w) return res.status(404).json({ error: 'Not found' });
  const [a, b] = await Promise.all([Snapshot.findById(oid(req.query.a)), Snapshot.findById(oid(req.query.b))]);
  if (!a || !b || String(a.target) !== String(w.target._id) || String(b.target) !== String(w.target._id)) {
    return res.status(404).json({ error: 'Snapshots not found' });
  }
  const [older, newer] = a.createdAt <= b.createdAt ? [a, b] : [b, a];
  const opts = { watchSelectors: w.watchSelectors, ignoreSelectors: w.ignoreSelectors };
  const parts = textDiff(extractText(older.html, opts), extractText(newer.html, opts));
  let image = null;
  try { image = imageDiff(older.screenshot, newer.screenshot); } catch (e) { image = { error: e.message }; }
  res.json({
    older: { _id: older._id, createdAt: older.createdAt, screenshot: older.screenshot },
    newer: { _id: newer._id, createdAt: newer.createdAt, screenshot: newer.screenshot },
    parts,
    image,
  });
}));

// Visual picker: render once, return screenshot + clickable element boxes.
const previewLimiter = new Map();
app.post('/api/preview', wrap(async (req, res) => {
  const user = owner(req);
  const last = previewLimiter.get(user) || 0;
  if (Date.now() - last < 10000) return res.status(429).json({ error: 'Wait a few seconds between previews' });
  previewLimiter.set(user, Date.now());
  const { normalized } = await validUrl(req.body.url);
  if (!(await polite.robotsAllows(normalized))) return res.status(403).json({ error: 'This page disallows bots in robots.txt' });
  let page;
  try { page = await render(normalized, { screenshot: true, collectElements: true }); } catch (e) {
    throw httpError(e.blocked ? 400 : 502, e.blocked ? e.message : `Could not load the page: ${e.message.split('\n')[0]}`);
  }
  const file = `preview_${userTag(user)}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.png`;
  fs.writeFileSync(path.join(config.screenshotDir, file), page.screenshot);
  res.json({ screenshot: file, title: page.title, status: page.status, elements: page.elements });
}));

app.use((err, req, res, _next) => {
  const status = err.status || (err.name === 'CastError' ? 404 : err.message?.includes('Invalid URL') ? 400 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || 'Server error' });
});

if (require.main === module) {
  db.connect().then(() => {
    app.listen(config.port, () => console.log(`Dashboard on http://localhost:${config.port}`));
  });
}

module.exports = app;
