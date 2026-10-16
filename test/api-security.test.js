// Authentication, ownership on every private endpoint, CSRF and SSRF at the API level.
// Needs MongoDB + Redis (TEST_MONGO_URL / TEST_REDIS_URL). Skips if they are not running.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-api-'));
process.env.MONGO_URL = (process.env.TEST_MONGO_URL || 'mongodb://127.0.0.1:27017') + '/cd_api_tests';
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/5';
process.env.PRIVATE_HOST_ALLOWLIST = '127.0.0.1:4120';

let app; let db; let server; let base; let ready = false;
const site = http.createServer((q, r) => r.end('<p>hello</p>'));

test.before(async () => {
  try {
    db = require('../src/db');
    await db.mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 2000 });
    await db.mongoose.connection.dropDatabase();
    await Promise.all(Object.values(db.mongoose.models).map((m) => m.syncIndexes()));
    const { connection } = require('../src/queue');
    await connection.ping();
    app = require('../src/server');
    await new Promise((r) => site.listen(4120, r));
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    ready = true;
  } catch (e) { console.log('skipping API tests:', e.message); }
});
test.after(async () => {
  if (!ready) return;
  server.close(); site.close();
  await db.mongoose.connection.dropDatabase();
  await db.mongoose.disconnect();
  const { connection, checkQueue, systemQueue } = require('../src/queue');
  await checkQueue.obliterate({ force: true }).catch(() => {});
  await checkQueue.close(); await systemQueue.close(); await connection.quit();
});

async function call(method, p, { cookie, body, origin = base, headers = {} } = {}) {
  const h = { ...headers };
  if (origin) h.Origin = origin;
  if (cookie) h.Cookie = cookie;
  if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, setCookie: res.headers.get('set-cookie') };
}
const cookieOf = (r) => r.setCookie.split(';')[0];
const users = {};

test('auth: everything private needs a session', async (t) => {
  if (!ready) return t.skip('Mongo/Redis not running');
  for (const [m, p] of [['GET', '/api/watches'], ['POST', '/api/watches'], ['GET', '/api/auth/me'], ['POST', '/api/preview'], ['GET', '/api/compare'], ['GET', '/screenshots/x.png'], ['GET', '/api/snapshots/6ad1f1c6c7a951c84cf25340']]) {
    assert.strictEqual((await call(m, p, { body: m === 'POST' ? {} : undefined })).status, 401, `${m} ${p}`);
  }
  assert.strictEqual((await call('GET', '/api/watches', { headers: { 'x-user': 'ganesh' } })).status, 401, 'the old username header no longer works');
});

test('auth: sign-up rules, hashed password, secure cookie', async (t) => {
  if (!ready) return t.skip('Mongo/Redis not running');
  assert.strictEqual((await call('POST', '/api/auth/register', { body: { username: 'alice', password: 'short' } })).status, 400);
  const r = await call('POST', '/api/auth/register', { body: { username: 'alice', password: 'correct horse battery' } });
  assert.strictEqual(r.status, 201);
  assert.match(r.setCookie, /HttpOnly/); assert.match(r.setCookie, /SameSite=Lax/);
  users.alice = cookieOf(r);
  assert.strictEqual((await call('POST', '/api/auth/register', { body: { username: 'ALICE', password: 'another password' } })).status, 409);
  const stored = await db.User.findOne({ username: 'alice' });
  assert.ok(stored.passwordHash.startsWith('scrypt$') && !stored.passwordHash.includes('correct horse'));
  users.bob = cookieOf(await call('POST', '/api/auth/register', { body: { username: 'bob', password: 'bob password 123' } }));
  assert.strictEqual((await call('GET', '/api/auth/me', { cookie: users.alice })).json.username, 'alice');
  const sess = await db.Session.findOne({ user: 'alice' });
  assert.ok(!users.alice.includes(sess.tokenHash), 'only a hash of the session token is stored');
});

test('auth: wrong password, brute-force lockout, logout kills the session', async (t) => {
  if (!ready) return t.skip('Mongo/Redis not running');
  await call('POST', '/api/auth/register', { body: { username: 'carol', password: 'carol password 1' } });
  assert.strictEqual((await call('POST', '/api/auth/login', { body: { username: 'carol', password: 'nope nope nope' } })).status, 401);
  for (let i = 0; i < 10; i++) await call('POST', '/api/auth/login', { body: { username: 'carol', password: 'nope nope nope' } });
  assert.strictEqual((await call('POST', '/api/auth/login', { body: { username: 'carol', password: 'carol password 1' } })).status, 429, 'locked out even with the right password');
  const login = await call('POST', '/api/auth/login', { body: { username: 'bob', password: 'bob password 123' } });
  assert.strictEqual(login.status, 200);
  const c = cookieOf(login);
  assert.strictEqual((await call('POST', '/api/auth/logout', { cookie: c })).status, 200);
  assert.strictEqual((await call('GET', '/api/watches', { cookie: c })).status, 401, 'old cookie is dead after logout');
});

test('CSRF: state-changing requests from another site are refused', async (t) => {
  if (!ready) return t.skip('Mongo/Redis not running');
  assert.strictEqual((await call('POST', '/api/watches', { cookie: users.alice, body: { url: 'http://127.0.0.1:4120/' }, origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await call('POST', '/api/watches', { cookie: users.alice, body: { url: 'http://127.0.0.1:4120/' }, origin: null })).status, 403);
});

test('SSRF: the API refuses internal URLs for watches and previews', async (t) => {
  if (!ready) return t.skip('Mongo/Redis not running');
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:6379/', 'http://127.0.0.1:27017/', 'http://[::1]:3000/', 'http://2130706433/', 'file:///etc/passwd', 'http://10.0.0.1/admin']) {
    const r = await call('POST', '/api/watches', { cookie: users.alice, body: { url } });
    assert.strictEqual(r.status, 400, `${url} -> ${r.status} ${r.text}`);
    const p = await call('POST', '/api/preview', { cookie: users.alice, body: { url } });
    assert.ok([400, 429].includes(p.status), `preview ${url} -> ${p.status}`);
  }
});

test('ownership: another user cannot read, change, check, compare, or see screenshots of my watch', async (t) => {
  if (!ready) return t.skip('Mongo/Redis not running');
  const made = await call('POST', '/api/watches', { cookie: users.alice, body: { url: 'http://127.0.0.1:4120/page', name: 'Alice page' } });
  assert.strictEqual(made.status, 201, made.text);
  const id = made.json._id;
  const w = await db.Watch.findById(id);
  // two stored versions with screenshots, as the worker would make
  const s1 = await db.Snapshot.create({ target: w.target, contentHash: 'a', text: 'x', html: '<p>x</p>', screenshot: `${w.target}_1.png` });
  const s2 = await db.Snapshot.create({ target: w.target, contentHash: 'b', text: 'y', html: '<p>y</p>', screenshot: `${w.target}_2.png` });
  fs.mkdirSync(path.join(process.env.DATA_DIR, 'screenshots'), { recursive: true });
  const { PNG } = require('pngjs');
  const png = PNG.sync.write(new PNG({ width: 4, height: 4 }));
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'screenshots', `${w.target}_1.png`), png);
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'screenshots', `${w.target}_2.png`), png);

  const bob = users.bob = cookieOf(await call('POST', '/api/auth/login', { body: { username: 'bob', password: 'bob password 123' } }));
  assert.strictEqual((await call('GET', '/api/watches', { cookie: bob })).json.length, 0, "bob's list does not include alice's watch");
  for (const [m, p, body] of [
    ['GET', `/api/watches/${id}`], ['PATCH', `/api/watches/${id}`, { name: 'pwned' }], ['DELETE', `/api/watches/${id}`],
    ['POST', `/api/watches/${id}/check`], ['GET', `/api/compare?watch=${id}&a=${s1._id}&b=${s2._id}`],
    ['GET', `/api/snapshots/${s1._id}`], ['GET', `/screenshots/${w.target}_1.png`],
  ]) {
    assert.strictEqual((await call(m, p, { cookie: bob, body })).status, 404, `bob ${m} ${p}`);
  }
  assert.strictEqual((await db.Watch.findById(id)).name, 'Alice page', 'unchanged');
  assert.strictEqual((await call('GET', `/api/watches/${id}`, { cookie: users.alice })).status, 200);
  assert.strictEqual((await call('GET', `/api/compare?watch=${id}&a=${s1._id}&b=${s2._id}`, { cookie: users.alice })).status, 200);
  assert.strictEqual((await call('GET', `/screenshots/${w.target}_1.png`, { cookie: users.alice })).status, 200);
  assert.strictEqual((await call('GET', '/screenshots/..%2F..%2Fetc%2Fpasswd', { cookie: users.alice })).status, 404, 'path traversal');

  // NoSQL operator injection is treated as data
  assert.strictEqual((await call('GET', `/api/compare?watch[$ne]=x&a=${s1._id}&b=${s2._id}`, { cookie: bob })).status, 404);

  // RSS: needs the per-watch secret
  const detail = (await call('GET', `/api/watches/${id}`, { cookie: users.alice })).json;
  const token = new URL(detail.rssUrl).searchParams.get('token');
  assert.strictEqual((await call('GET', `/api/watches/${id}/rss`)).status, 404);
  assert.strictEqual((await call('GET', `/api/watches/${id}/rss?token=wrong${token.slice(5)}`)).status, 404);
  const rss = await call('GET', `/api/watches/${id}/rss?token=${token}`);
  assert.strictEqual(rss.status, 200); assert.match(rss.text, /<rss/);

  // bob adds the same page: shares the target but still cannot touch alice's watch
  const bobs = await call('POST', '/api/watches', { cookie: bob, body: { url: 'http://127.0.0.1:4120/page?utm_source=x' } });
  assert.strictEqual(bobs.json.sharedTarget, true);
  assert.strictEqual((await call('DELETE', `/api/watches/${id}`, { cookie: bob })).status, 404);
});

test('alert channels are validated when saved', async (t) => {
  if (!ready) return t.skip('Mongo/Redis not running');
  const bad = [{ discordWebhook: 'https://evil.example/api/webhooks/1/abc' }, { email: 'not-an-email' }, { telegramChatId: 'drop table' }];
  for (const channels of bad) {
    assert.strictEqual((await call('POST', '/api/watches', { cookie: users.alice, body: { url: 'http://127.0.0.1:4120/x', channels } })).status, 400, JSON.stringify(channels));
  }
});
