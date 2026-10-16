// URL normalization + SSRF protection.
const dns = require('dns').promises;
const net = require('net');

const TRACKING = /^(utm_|fbclid$|gclid$|mc_eid$|mc_cid$|ref$|ref_src$|igshid$|_ga$)/i;

function normalizeUrl(input) {
  const u = new URL(String(input).trim());
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) URLs are allowed');
  if (u.username || u.password) throw new Error('URLs with credentials are not allowed');
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  u.hash = '';
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

// ---- IP classification ----
function v4ToInt(ip) { return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0; }
const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [v4ToInt(base), bits]);

function isPublicIPv4(ip) {
  const n = v4ToInt(ip);
  return !V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
}

function expandV6(ip) {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (s.includes('.')) { // embedded IPv4 (::ffff:1.2.3.4)
    const v4 = s.slice(s.lastIndexOf(':') + 1);
    const n = v4ToInt(v4);
    s = s.slice(0, s.lastIndexOf(':') + 1) + ((n >>> 16).toString(16)) + ':' + ((n & 0xffff).toString(16));
  }
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = s.includes('::') ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => parseInt(x || '0', 16));
}

function isPublicIPv6(ip) {
  const w = expandV6(ip);
  if (w.length !== 8 || w.some((x) => Number.isNaN(x))) return false;
  const v4From = (a, b) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  if (w.slice(0, 7).every((x) => x === 0)) return false;                                   // :: and ::1
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return isPublicIPv4(v4From(w[6], w[7])); // ::ffff:a.b.c.d
  if (w[0] === 0x64 && w[1] === 0xff9b) return isPublicIPv4(v4From(w[6], w[7]));          // NAT64
  if (w[0] === 0x2002) return isPublicIPv4(v4From(w[1], w[2]));                            // 6to4
  if ((w[0] & 0xfe00) === 0xfc00) return false;  // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80) return false;  // fe80::/10 link local
  if ((w[0] & 0xffc0) === 0xfec0) return false;  // site local (deprecated)
  if ((w[0] & 0xff00) === 0xff00) return false;  // multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return false; // documentation
  if (w[0] === 0x0100 && w.slice(1, 4).every((x) => x === 0)) return false; // discard prefix
  return true;
}

function isPublicIp(ip) {
  const kind = net.isIP(String(ip).replace(/^\[|\]$/g, ''));
  if (kind === 4) return isPublicIPv4(ip);
  if (kind === 6) return isPublicIPv6(ip);
  return false;
}

// Fast, DNS-free check on the hostname string (used for input validation).
function isPublicHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return false;
  if (net.isIP(h)) return isPublicIp(h);
  if (!h.includes('.')) return false; // single-label names resolve on the internal network
  return true;
}

// Exact host:port pairs allowed even though private (local demo only). From PRIVATE_HOST_ALLOWLIST.
function allowlisted(u, allowlist = []) {
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return allowlist.includes(`${u.hostname.replace(/^\[|\]$/g, '')}:${port}`);
}

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const dnsCache = new Map(); // hostname -> { ok, at }

// Full check: scheme, port, hostname AND every address it resolves to.
async function checkUrl(raw, { allowlist = [], lookup = dns.lookup } = {}) {
  let u;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'Invalid URL' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, reason: `Scheme ${u.protocol} not allowed` };
  if (u.username || u.password) return { ok: false, reason: 'Credentials in URL not allowed' };
  if (allowlisted(u, allowlist)) return { ok: true };
  if (!ALLOWED_PORTS.has(u.port)) return { ok: false, reason: `Port ${u.port} not allowed` };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!isPublicHost(host)) return { ok: false, reason: 'Private or internal address' };
  if (net.isIP(host)) return { ok: true };
  const cached = dnsCache.get(host);
  if (cached && Date.now() - cached.at < 60000) return cached.ok ? { ok: true } : { ok: false, reason: 'Resolves to a private address' };
  let addrs;
  try { addrs = await lookup(host, { all: true, verbatim: true }); } catch { return { ok: false, reason: 'DNS lookup failed' }; }
  const ok = addrs.length > 0 && addrs.every((a) => isPublicIp(a.address));
  dnsCache.set(host, { ok, at: Date.now() });
  return ok ? { ok: true } : { ok: false, reason: 'Resolves to a private address' };
}

// A lookup() for http/https agents that refuses private addresses at connect time
// (closes the DNS-rebinding gap between "check" and "connect").
function safeLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  require('dns').lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const bad = addrs.find((a) => !isPublicIp(a.address));
    if (bad) return cb(Object.assign(new Error(`Blocked private address ${bad.address}`), { code: 'EBLOCKED' }));
    if (options.all) return cb(null, addrs);
    return cb(null, addrs[0].address, addrs[0].family);
  });
}

module.exports = { normalizeUrl, isPublicHost, isPublicIp, checkUrl, safeLookup, allowlisted };
