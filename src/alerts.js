// Alerts via email, Discord webhook and Telegram.
// Reliability rules:
//  * the alert record (with the exact message) is written BEFORE sending; its unique dedupeKey means
//    the same change is never alerted twice, even if two workers race or a job is retried
//  * every channel is delivered and tracked separately (one broken channel never blocks the others)
//  * HTTP responses are checked: a 404 webhook is a failure, not a silent success
//  * temporary failures (network, timeouts, 5xx, 429, SMTP 4xx) are retried with backoff;
//    permanent ones (deleted webhook, bad chat id, SMTP 5xx rejection) stop at once and are shown as "dead"
const nodemailer = require('nodemailer');
const config = require('./config');
const { Alert } = require('./db');

const RETRY_DELAYS_MIN = [1, 5, 15, 60, 180];   // after attempt 1, 2, 3 ...
const MAX_ATTEMPTS = RETRY_DELAYS_MIN.length + 1;

class DeliveryError extends Error {
  constructor(message, { permanent = false, retryAfterMs = null } = {}) {
    super(message);
    this.permanent = permanent;
    this.retryAfterMs = retryAfterMs;
  }
}

let transporter = null;
function getTransporter() {
  if (!transporter && config.smtp.host) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  return transporter;
}

async function sendEmail(to, subject, text) {
  const t = getTransporter();
  if (!t) throw new DeliveryError('SMTP is not configured on the server', { permanent: true });
  try {
    await t.sendMail({ from: config.smtp.from, to, subject, text });
  } catch (e) {
    const code = Number(e.responseCode);
    if (code >= 500 && code < 600) throw new DeliveryError(`SMTP rejected: ${e.response || e.message}`, { permanent: true });
    throw new DeliveryError(`SMTP: ${e.code || ''} ${e.response || e.message}`.trim());
  }
}

async function postJson(url, payload, fetchImpl) {
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new DeliveryError(`Network error: ${e.cause?.code || e.name || e.message}`);
  }
}

function retryAfterFrom(res, bodyRetrySec) {
  const header = Number(res.headers?.get?.('retry-after'));
  const sec = Number.isFinite(bodyRetrySec) ? bodyRetrySec : Number.isFinite(header) ? header : null;
  return sec === null ? null : Math.ceil(sec * 1000);
}

async function sendDiscord(webhook, text, fetchImpl = fetch) {
  if (!/^https:\/\/(?:canary\.|ptb\.)?(discord|discordapp)\.com\/api\/webhooks\//.test(webhook)) {
    throw new DeliveryError('Invalid Discord webhook URL', { permanent: true });
  }
  const res = await postJson(webhook, { content: text.slice(0, 1900), allowed_mentions: { parse: [] } }, fetchImpl);
  if (res.ok) return;
  let body = {}; try { body = await res.json(); } catch { /* not json */ }
  if (res.status === 429) throw new DeliveryError('Discord rate limited', { retryAfterMs: retryAfterFrom(res, body.retry_after) });
  if (res.status >= 500) throw new DeliveryError(`Discord server error ${res.status}`);
  throw new DeliveryError(`Discord webhook rejected (${res.status}${body.message ? `: ${body.message}` : ''})`, { permanent: true });
}

async function sendTelegram(chatId, text, fetchImpl = fetch) {
  if (!config.telegramToken) throw new DeliveryError('Telegram bot token is not configured on the server', { permanent: true });
  const res = await postJson(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`,
    { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }, fetchImpl);
  let body = {}; try { body = await res.json(); } catch { /* not json */ }
  if (res.ok && body.ok !== false) return;
  if (res.status === 429) throw new DeliveryError('Telegram rate limited', { retryAfterMs: retryAfterFrom(res, body.parameters?.retry_after) });
  if (res.status >= 500) throw new DeliveryError(`Telegram server error ${res.status}`);
  throw new DeliveryError(`Telegram rejected (${res.status}${body.description ? `: ${body.description}` : ''})`, { permanent: true });
}

const defaultSenders = { email: sendEmail, discord: sendDiscord, telegram: sendTelegram };

function channelsOf(watch) {
  const c = watch.channels || {};
  return [
    c.email && 'email',
    c.discordWebhook && 'discord',
    c.telegramChatId && 'telegram',
  ].filter(Boolean);
}

function destination(watch, channel) {
  const c = watch.channels || {};
  return channel === 'email' ? c.email : channel === 'discord' ? c.discordWebhook : c.telegramChatId;
}

function format(channel, subject, body) {
  if (channel === 'discord') return `**${subject}**\n${body}`;
  if (channel === 'telegram') return `${subject}\n${body}`;
  return body;
}

// Decide what happens after one attempt. Pure, so it is easy to test.
function nextState(delivery, error, now = Date.now()) {
  const attempts = delivery.attempts + 1;
  if (!error) return { ...delivery, attempts, status: 'sent', sentAt: new Date(now), lastError: undefined, nextAttemptAt: undefined };
  if (error.permanent || attempts >= MAX_ATTEMPTS) {
    return { ...delivery, attempts, status: 'dead', lastError: error.message, nextAttemptAt: undefined };
  }
  const wait = Math.max(error.retryAfterMs || 0, RETRY_DELAYS_MIN[attempts - 1] * 60000);
  return { ...delivery, attempts, status: 'failed', lastError: error.message, nextAttemptAt: new Date(now + wait) };
}

// Try every channel that is not yet delivered. Saves the result on the alert.
async function attemptDeliveries(alert, watch, { senders = defaultSenders, now = Date.now(), onlyDue = false } = {}) {
  for (let i = 0; i < alert.deliveries.length; i++) {
    const d = alert.deliveries[i];
    if (d.status === 'sent' || d.status === 'dead') continue;
    if (onlyDue && d.nextAttemptAt && d.nextAttemptAt.getTime() > now) continue;
    const to = destination(watch, d.channel);
    let error = null;
    if (!to) error = new DeliveryError('Channel was removed from this watch', { permanent: true });
    else {
      try {
        if (d.channel === 'email') await senders.email(to, alert.subject, alert.body);
        else await senders[d.channel](to, format(d.channel, alert.subject, alert.body));
      } catch (e) {
        error = e instanceof DeliveryError ? e : new DeliveryError(e.message);
      }
    }
    alert.deliveries[i] = nextState(d.toObject ? d.toObject() : d, error, now);
    if (error) console.warn(`[alert] ${d.channel} failed for watch ${watch._id}: ${error.message}${error.permanent ? ' (permanent)' : ''}`);
  }
  if (alert.deliveries.length && alert.deliveries.every((d) => d.status === 'sent')) alert.sentAt = new Date(now);
  alert.markModified('deliveries');
  await alert.save();
  return alert;
}

function messageFor(watch, { kind, summary, url, fromSnapshot, toSnapshot }) {
  const link = ['change', 'visual'].includes(kind) ? `${config.baseUrl}/#/compare/${watch._id}/${fromSnapshot}/${toSnapshot}` : `${config.baseUrl}/#/watch/${watch._id}`;
  const subject = kind === 'change' ? `Changed: ${watch.name}`
    : kind === 'visual' ? `Looks different: ${watch.name}`
      : kind === 'down' ? `Unreachable: ${watch.name}` : `Back online: ${watch.name}`;
  return { subject, body: `${summary}\n${url}\nDiff: ${link}` };
}

// Creates the alert record first; the unique dedupeKey guarantees no duplicate alert for the same content.
async function raise(watch, { kind = 'change', fromSnapshot, toSnapshot, summary, dedupeKey, url }, opts = {}) {
  const toDigest = watch.digest && ['change', 'visual'].includes(kind);
  const { subject, body } = messageFor(watch, { kind, summary, url, fromSnapshot, toSnapshot });
  let alert;
  try {
    alert = await Alert.create({
      watch: watch._id, kind, fromSnapshot, toSnapshot, summary, subject, body, dedupeKey,
      pendingDigest: toDigest,
      deliveries: toDigest ? [] : channelsOf(watch).map((channel) => ({ channel })),
    });
  } catch (e) {
    if (e.code === 11000) return null; // duplicate -> already alerted
    throw e;
  }
  if (!toDigest) await attemptDeliveries(alert, watch, opts);
  return alert;
}

// Runs every minute from the worker: re-sends failed channels whose backoff is over.
async function retryDeliveries({ senders = defaultSenders, now = Date.now() } = {}) {
  const due = await Alert.find({ deliveries: { $elemMatch: { status: 'failed', nextAttemptAt: { $lte: new Date(now) } } } })
    .populate('watch').limit(200);
  let retried = 0;
  for (const alert of due) {
    if (!alert.watch) continue;
    await attemptDeliveries(alert, alert.watch, { senders, now, onlyDue: true });
    retried += 1;
  }
  return retried;
}

async function sendDigests({ senders = defaultSenders, now = Date.now() } = {}) {
  const pending = await Alert.find({ pendingDigest: true }).populate({ path: 'watch', populate: 'target' });
  const byWatch = new Map();
  for (const a of pending) {
    if (!a.watch) continue;
    const key = String(a.watch._id);
    if (!byWatch.has(key)) byWatch.set(key, { watch: a.watch, alerts: [] });
    byWatch.get(key).alerts.push(a);
  }
  for (const { watch, alerts } of byWatch.values()) {
    const lines = alerts.map((a) => `- ${a.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC: ${a.summary}\n  ${config.baseUrl}/#/compare/${watch._id}/${a.fromSnapshot}/${a.toSnapshot}`);
    const day = new Date(now).toISOString().slice(0, 10);
    try {
      const digest = await Alert.create({
        watch: watch._id, kind: 'digest', dedupeKey: `${watch._id}:digest:${day}:${alerts[alerts.length - 1]._id}`,
        summary: `${alerts.length} change${alerts.length > 1 ? 's' : ''}`,
        subject: `Daily digest: ${watch.name} (${alerts.length} change${alerts.length > 1 ? 's' : ''})`,
        body: `${watch.target?.url}\n${lines.join('\n')}`,
        deliveries: channelsOf(watch).map((channel) => ({ channel })),
      });
      // the digest is its own alert with its own retries; the changes are no longer pending
      await Alert.updateMany({ _id: { $in: alerts.map((a) => a._id) } }, { pendingDigest: false });
      await attemptDeliveries(digest, watch, { senders, now });
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
  }
  return byWatch.size;
}

module.exports = { raise, retryDeliveries, sendDigests, attemptDeliveries, nextState, sendEmail, sendDiscord, sendTelegram, DeliveryError, RETRY_DELAYS_MIN, MAX_ATTEMPTS, defaultSenders };
