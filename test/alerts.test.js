// Alert reliability: failed SMTP, invalid/broken webhooks, retries with backoff, and recovery.
// Needs MongoDB (TEST_MONGO_URL, default mongodb://127.0.0.1:27017). Skips if none is running.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');

const SMTP_PORT = 2526;
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(SMTP_PORT);
process.env.TELEGRAM_BOT_TOKEN = '123:test';
const mongoUrl = (process.env.TEST_MONGO_URL || 'mongodb://127.0.0.1:27017') + '/cd_alert_tests';

const alerts = require('../src/alerts');
const db = require('../src/db');
const { Alert } = db;

// ---------- a tiny SMTP server whose behaviour we control ----------
let smtpMode = 'ok'; // ok | tempfail (451) | reject (550)
const received = [];
let smtpServer = null;
function startSmtp() {
  return new Promise((resolve) => {
    smtpServer = net.createServer((sock) => {
      let inData = false; let buf = ''; let mail = '';
      sock.write('220 test ESMTP\r\n');
      sock.on('data', (chunk) => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (inData) {
            if (line === '.') { inData = false; received.push(mail); mail = ''; sock.write('250 OK queued\r\n'); } else mail += line + '\n';
            continue;
          }
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 test\r\n');
          else if (cmd === 'MAIL') sock.write(smtpMode === 'tempfail' ? '451 4.3.0 Mailbox busy, try later\r\n' : '250 OK\r\n');
          else if (cmd === 'RCPT') sock.write(smtpMode === 'reject' ? '550 5.1.1 No such user\r\n' : '250 OK\r\n');
          else if (cmd === 'DATA') { inData = true; sock.write('354 go\r\n'); } else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); } else if (cmd === 'RSET') sock.write('250 OK\r\n');
          else sock.write('250 OK\r\n');
        }
      });
      sock.on('error', () => {});
    }).listen(SMTP_PORT, '127.0.0.1', resolve);
  });
}
const stopSmtp = () => new Promise((r) => (smtpServer ? smtpServer.close(() => { smtpServer = null; r(); }) : r()));

// ---------- fake HTTP for Discord/Telegram (a scripted queue of responses) ----------
function scriptedFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next === 'network') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return new Response(next.status === 204 ? null : JSON.stringify(next.body || {}), { status: next.status, headers: next.headers || { 'content-type': 'application/json' } });
  };
  impl.calls = calls;
  return impl;
}

const WEBHOOK = 'https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz';
const watchWith = (channels) => ({ _id: new db.mongoose.Types.ObjectId(), name: 'Hoodie', channels, digest: false });

let haveMongo = false;
test.before(async () => {
  try {
    await db.mongoose.connect(mongoUrl, { serverSelectionTimeoutMS: 2000 });
    await Alert.deleteMany({});
    await Alert.syncIndexes();
    haveMongo = true;
  } catch { haveMongo = false; }
});
test.after(async () => { await stopSmtp(); if (haveMongo) { await db.mongoose.connection.dropDatabase(); await db.mongoose.disconnect(); } });

// ---------- pure retry policy ----------
test('retry policy: backoff for temporary errors, stop at once on permanent ones', () => {
  const t0 = Date.parse('2026-10-16T10:00:00Z');
  const fresh = { channel: 'discord', status: 'pending', attempts: 0 };
  const s1 = alerts.nextState(fresh, new alerts.DeliveryError('500'), t0);
  assert.strictEqual(s1.status, 'failed');
  assert.strictEqual(s1.nextAttemptAt.getTime() - t0, 60000); // 1 min
  const s2 = alerts.nextState(s1, new alerts.DeliveryError('500'), t0);
  assert.strictEqual(s2.nextAttemptAt.getTime() - t0, 5 * 60000); // then 5 min
  const rl = alerts.nextState(fresh, new alerts.DeliveryError('429', { retryAfterMs: 30 * 60000 }), t0);
  assert.strictEqual(rl.nextAttemptAt.getTime() - t0, 30 * 60000, 'Retry-After is honoured');
  assert.strictEqual(alerts.nextState(fresh, new alerts.DeliveryError('404', { permanent: true }), t0).status, 'dead');
  let s = fresh;
  for (let i = 0; i < alerts.MAX_ATTEMPTS; i++) s = alerts.nextState(s, new alerts.DeliveryError('timeout'), t0);
  assert.strictEqual(s.status, 'dead', 'gives up after the last attempt');
  assert.strictEqual(alerts.nextState(s1, null, t0).status, 'sent');
});

// ---------- channel error classification ----------
test('Discord: deleted webhook (404) is a permanent failure, not a silent success', async () => {
  await assert.rejects(alerts.sendDiscord(WEBHOOK, 'hi', scriptedFetch([{ status: 404, body: { message: 'Unknown Webhook', code: 10015 } }])),
    (e) => e.permanent === true && /Unknown Webhook/.test(e.message));
});
test('Discord: invalid webhook URL is rejected without any request', async () => {
  const f = scriptedFetch([{ status: 204 }]);
  await assert.rejects(alerts.sendDiscord('https://evil.example.com/hook', 'hi', f), (e) => e.permanent);
  assert.strictEqual(f.calls.length, 0);
});
test('Discord: 5xx, network errors and 429 are temporary', async () => {
  await assert.rejects(alerts.sendDiscord(WEBHOOK, 'x', scriptedFetch([{ status: 502 }])), (e) => !e.permanent);
  await assert.rejects(alerts.sendDiscord(WEBHOOK, 'x', scriptedFetch(['network'])), (e) => !e.permanent && /ECONNRESET/.test(e.message));
  await assert.rejects(alerts.sendDiscord(WEBHOOK, 'x', scriptedFetch([{ status: 429, body: { retry_after: 12.5 } }])), (e) => !e.permanent && e.retryAfterMs === 12500);
});
test('Telegram: "chat not found" is permanent, ok:true is success', async () => {
  await assert.rejects(alerts.sendTelegram('42', 'x', scriptedFetch([{ status: 400, body: { ok: false, description: 'Bad Request: chat not found' } }])), (e) => e.permanent);
  await alerts.sendTelegram('42', 'x', scriptedFetch([{ status: 200, body: { ok: true } }]));
});
test('SMTP: server down is temporary, 451 is temporary, 550 is permanent', async () => {
  await stopSmtp();
  await assert.rejects(alerts.sendEmail('a@b.co', 's', 't'), (e) => !e.permanent && /ECONNREFUSED|ESOCKET|ECONNECTION/.test(e.message));
  await startSmtp();
  smtpMode = 'tempfail';
  await assert.rejects(alerts.sendEmail('a@b.co', 's', 't'), (e) => !e.permanent && /451/.test(e.message));
  smtpMode = 'reject';
  await assert.rejects(alerts.sendEmail('a@b.co', 's', 't'), (e) => e.permanent && /550/.test(e.message));
  smtpMode = 'ok';
  await alerts.sendEmail('a@b.co', 'Changed: Hoodie', 'price now 799');
  assert.match(received.at(-1), /price now 799/);
});

// ---------- end to end with MongoDB: failure, retry, recovery, no duplicates ----------
test('outage then recovery: failed channels are retried and delivered; working channels are not resent', async (t) => {
  if (!haveMongo) return t.skip('MongoDB not running');
  if (!smtpServer) await startSmtp();
  await stopSmtp(); // SMTP is down when the change happens
  const discord = scriptedFetch([{ status: 503 }, { status: 204 }]); // first call fails, retry works
  const telegram = scriptedFetch([{ status: 200, body: { ok: true } }]);
  const senders = { ...alerts.defaultSenders, discord: (u, txt) => alerts.sendDiscord(u, txt, discord), telegram: (c, txt) => alerts.sendTelegram(c, txt, telegram) };
  const watch = watchWith({ email: 'ganesh@example.com', discordWebhook: WEBHOOK, telegramChatId: '42' });
  const t0 = Date.now();

  const a = await alerts.raise(watch, { summary: 'Price ₹999 -> ₹799', dedupeKey: `${watch._id}:h1`, url: 'https://shop.example/hoodie' }, { senders, now: t0 });
  const state = (al) => Object.fromEntries(al.deliveries.map((d) => [d.channel, d.status]));
  assert.deepStrictEqual(state(a), { email: 'failed', discord: 'failed', telegram: 'sent' });
  assert.ok(!a.sentAt);

  // duplicate change (worker retried the job): no second alert, nothing re-sent
  assert.strictEqual(await alerts.raise(watch, { summary: 'dup', dedupeKey: `${watch._id}:h1`, url: 'x' }, { senders, now: t0 }), null);
  assert.strictEqual(telegram.calls.length, 1);

  // retry runner before the backoff is over: nothing happens
  await alerts.retryDeliveries({ senders: { ...senders }, now: t0 + 10000 });
  let fresh = await Alert.findById(a._id);
  assert.deepStrictEqual(state(fresh), { email: 'failed', discord: 'failed', telegram: 'sent' });

  // SMTP comes back; retry after 1 minute backoff
  await startSmtp(); smtpMode = 'ok';
  // populate needs the watch in the DB for retryDeliveries
  await db.Watch.create({ _id: watch._id, owner: 'ganesh', name: watch.name, target: new db.mongoose.Types.ObjectId(), channels: watch.channels });
  const n = await alerts.retryDeliveries({ senders, now: t0 + 61000 });
  assert.strictEqual(n, 1);
  fresh = await Alert.findById(a._id);
  assert.deepStrictEqual(state(fresh), { email: 'sent', discord: 'sent', telegram: 'sent' });
  assert.ok(fresh.sentAt, 'alert marked fully delivered');
  assert.strictEqual(telegram.calls.length, 1, 'telegram was not sent twice');
  assert.strictEqual(discord.calls.length, 2);
  assert.ok(received.some((m) => m.includes('Price') && m.includes('799')), 'email body delivered after recovery');
  assert.strictEqual(fresh.deliveries.find((d) => d.channel === 'email').attempts, 2);
});

test('a permanently broken webhook is marked failed once and never retried', async (t) => {
  if (!haveMongo) return t.skip('MongoDB not running');
  await Alert.deleteMany({});
  const discord = scriptedFetch([{ status: 404, body: { message: 'Unknown Webhook' } }]);
  const senders = { ...alerts.defaultSenders, discord: (u, txt) => alerts.sendDiscord(u, txt, discord) };
  const watch = await db.Watch.create({ owner: 'ganesh', name: 'W2', target: new db.mongoose.Types.ObjectId(), channels: { discordWebhook: WEBHOOK } });
  const t0 = Date.now();
  const a = await alerts.raise(watch, { summary: 's', dedupeKey: `${watch._id}:h`, url: 'x' }, { senders, now: t0 });
  assert.strictEqual(a.deliveries[0].status, 'dead');
  assert.match(a.deliveries[0].lastError, /Unknown Webhook/);
  await alerts.retryDeliveries({ senders, now: t0 + 24 * 3600 * 1000 });
  assert.strictEqual(discord.calls.length, 1, 'no retries for a dead webhook');
});
