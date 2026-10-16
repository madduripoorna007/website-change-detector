// Accounts + cookie sessions.
const crypto = require('crypto');
const { promisify } = require('util');
const config = require('./config');
const { User, Session } = require('./db');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'cd_session';
const USERNAME = /^[a-z0-9._-]{3,32}$/;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [alg, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = Buffer.from(keyB64, 'base64');
  const test = await scrypt(password, Buffer.from(saltB64, 'base64'), key.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, test);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, token, maxAgeSec) {
  const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (config.cookieSecure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

async function startSession(res, username) {
  const token = crypto.randomBytes(32).toString('base64url');
  const maxAge = config.sessionDays * 86400;
  await Session.create({ tokenHash: sha256(token), user: username, expiresAt: new Date(Date.now() + maxAge * 1000) });
  setCookie(res, token, maxAge);
}

// Brute-force protection: 10 failed logins per username+IP per 15 minutes.
const failures = new Map();
function tooManyFailures(key) {
  const f = failures.get(key);
  return f && f.count >= 10 && Date.now() - f.first < 15 * 60000;
}
function noteFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > 15 * 60000) failures.set(key, { count: 1, first: Date.now() });
  else f.count += 1;
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

async function register(req, res) {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!USERNAME.test(username)) throw httpError(400, 'Username: 3-32 characters, letters, numbers, . _ -');
  if (password.length < 8 || password.length > 200) throw httpError(400, 'Password must be at least 8 characters');
  if (await User.exists({ username })) throw httpError(409, 'That username is taken');
  await User.create({ username, passwordHash: await hashPassword(password) });
  await startSession(res, username);
  res.status(201).json({ username });
}

async function login(req, res) {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const key = `${username}|${req.ip}`;
  if (tooManyFailures(key)) throw httpError(429, 'Too many attempts. Try again in 15 minutes.');
  const user = await User.findOne({ username });
  const ok = user ? await verifyPassword(password, user.passwordHash) : (await hashPassword(password), false); // same timing either way
  if (!ok) { noteFailure(key); throw httpError(401, 'Wrong username or password'); }
  failures.delete(key);
  await startSession(res, username);
  res.json({ username });
}

async function logout(req, res) {
  const token = parseCookies(req.get('cookie'))[COOKIE];
  if (token) await Session.deleteOne({ tokenHash: sha256(token) });
  setCookie(res, '', 0);
  res.json({ ok: true });
}

// Attaches req.user (username) or responds 401.
async function requireUser(req, res, next) {
  try {
    const token = parseCookies(req.get('cookie'))[COOKIE];
    if (!token) throw httpError(401, 'Please log in');
    const s = await Session.findOne({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } });
    if (!s) throw httpError(401, 'Session expired, please log in again');
    req.user = s.user;
    next();
  } catch (e) { next(e); }
}

// CSRF defence for cookie auth: state-changing requests must come from our own origin.
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin') || req.get('referer');
  const host = req.get('host');
  if (!origin) return next(httpError(403, 'Missing Origin header'));
  try {
    if (new URL(origin).host !== host) return next(httpError(403, 'Cross-site request blocked'));
  } catch { return next(httpError(403, 'Bad Origin header')); }
  return next();
}

module.exports = { register, login, logout, requireUser, sameOrigin, hashPassword, verifyPassword, parseCookies, COOKIE };
