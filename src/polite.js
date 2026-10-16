// Politeness: robots.txt, per-domain spacing, conditional requests, backoff.
const config = require('./config');
const { safeFetch } = require('./safefetch');

const robotsCache = new Map(); // origin -> { rules, fetchedAt }

function parseRobots(txt, agent = '*') {
  const groups = [];
  let current = null;
  for (const line of txt.split(/\r?\n/)) {
    const clean = line.replace(/#.*/, '').trim();
    if (!clean) continue;
    const [k, ...rest] = clean.split(':');
    const key = k.trim().toLowerCase();
    const val = rest.join(':').trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(val.toLowerCase());
    } else if (current && (key === 'disallow' || key === 'allow')) {
      current.rules.push({ allow: key === 'allow', path: val });
    }
  }
  const ua = agent.toLowerCase();
  const group = groups.find((g) => g.agents.some((a) => a !== '*' && ua.includes(a)))
    || groups.find((g) => g.agents.includes('*'));
  return group ? group.rules : [];
}

function isAllowed(rules, pathname) {
  // longest matching rule wins
  let best = null;
  for (const r of rules) {
    if (!r.path) continue;
    const pattern = '^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
    if (new RegExp(pattern).test(pathname)) {
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    }
  }
  return !best || best.allow;
}

async function robotsAllows(url) {
  const u = new URL(url);
  const cached = robotsCache.get(u.origin);
  let rules;
  if (cached && Date.now() - cached.fetchedAt < 24 * 3600 * 1000) {
    rules = cached.rules;
  } else {
    try {
      const res = await safeFetch(`${u.origin}/robots.txt`, { headers: { 'User-Agent': config.userAgent }, timeoutMs: 8000 });
      rules = res.status >= 200 && res.status < 300 ? parseRobots(res.body, 'ChangeDetectorBot') : [];
    } catch { rules = []; }
    robotsCache.set(u.origin, { rules, fetchedAt: Date.now() });
  }
  return isAllowed(rules, u.pathname + u.search);
}

// Per-domain lock in Redis: at most one request per domain every PER_DOMAIN_GAP_MS across all workers.
async function acquireDomainSlot(redis, domain) {
  const key = `cd:domain:${domain}`;
  const ok = await redis.set(key, '1', 'PX', config.perDomainGapMs, 'NX');
  if (ok) return { ok: true };
  const ttl = await redis.pttl(key);
  return { ok: false, retryInMs: Math.max(ttl, 1000) + Math.floor(Math.random() * 2000) };
}

// Cheap check before a full browser render. Returns { notModified, etag, lastModified, status }
async function conditionalCheck(url, target) {
  if (!target.etag && !target.lastModified) return { notModified: false };
  const headers = { 'User-Agent': config.userAgent };
  if (target.etag) headers['If-None-Match'] = target.etag;
  if (target.lastModified) headers['If-Modified-Since'] = target.lastModified;
  try {
    const res = await safeFetch(url, { headers, timeoutMs: 10000, maxBytes: 1024 });
    return { notModified: res.status === 304, status: res.status, retryAfter: res.headers['retry-after'] };
  } catch {
    return { notModified: false };
  }
}

function retryAfterMs(value) {
  if (!value) return null;
  const secs = Number(value);
  if (!Number.isNaN(secs)) return secs * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(date - Date.now(), 0);
}

// Exponential backoff: 5 min, 10, 20 ... capped at 12 h
function backoffMs(failures) {
  return Math.min(5 * 60 * 1000 * 2 ** Math.max(failures - 1, 0), 12 * 3600 * 1000);
}

function jitter(intervalMin) {
  return Math.floor(Math.random() * intervalMin * 60 * 1000 * 0.1);
}

module.exports = { parseRobots, isAllowed, robotsAllows, acquireDomainSlot, conditionalCheck, retryAfterMs, backoffMs, jitter };
