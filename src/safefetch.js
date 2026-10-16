// Server-side HTTP GET that cannot be pointed at internal hosts:
// every hop (including redirects) is validated, and the socket's DNS lookup itself refuses private IPs.
const http = require('http');
const https = require('https');
const config = require('./config');
const { checkUrl, safeLookup, allowlisted } = require('./url');

function requestOnce(url, { headers = {}, timeoutMs = 10000, maxBytes = 512 * 1024 } = {}) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  const lookup = allowlisted(u, config.privateHostAllowlist) ? undefined : safeLookup;
  return new Promise((resolve, reject) => {
    const req = lib.get(u, { headers, lookup, timeout: timeoutMs }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= maxBytes) chunks.push(c); else res.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('close', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
  });
}

async function safeFetch(url, opts = {}) {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    const verdict = await checkUrl(current, { allowlist: config.privateHostAllowlist });
    if (!verdict.ok) throw Object.assign(new Error(`Blocked URL ${current}: ${verdict.reason}`), { code: 'EBLOCKED' });
    const res = await requestOnce(current, opts);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    return { ...res, url: current };
  }
  throw new Error('Too many redirects');
}

module.exports = { safeFetch };
