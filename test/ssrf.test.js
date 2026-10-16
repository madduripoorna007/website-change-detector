// SSRF protection: input validation, DNS checks, redirects and sub-resources in the real browser.
process.env.PRIVATE_HOST_ALLOWLIST = '127.0.0.1:4110'; // only the "public" test site is allowed
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const { checkUrl, normalizeUrl, isPublicHost } = require('../src/url');
const { safeFetch } = require('../src/safefetch');

test('URL checks block internal targets in every disguise', async () => {
  const blocked = [
    'http://localhost/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/',
    'http://100.64.1.1/', 'http://printer/', 'http://router.local/', 'file:///etc/passwd',
    'http://user:pw@example.com/', 'http://example.com:22/', 'http://127.0.0.1:4111/',
  ];
  for (const u of blocked) assert.strictEqual((await checkUrl(u, { allowlist: ['127.0.0.1:4110'] })).ok, false, u);
  assert.strictEqual((await checkUrl('http://127.0.0.1:4110/x', { allowlist: ['127.0.0.1:4110'] })).ok, true);
  assert.strictEqual(isPublicHost('example.com'), true);
  assert.throws(() => normalizeUrl('javascript:alert(1)'));
});

test('a public name that resolves to a private IP (DNS rebinding) is blocked', async () => {
  const fakeLookup = async () => [{ address: '10.0.0.7', family: 4 }];
  assert.strictEqual((await checkUrl('http://evil-rebind.example.org/', { lookup: fakeLookup })).ok, false);
  const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
  assert.strictEqual((await checkUrl('http://mixed.example.net/', { lookup: mixed })).ok, false);
});

// ---- live servers: 4110 = allowed site, 4111 = "internal" service that must never be reached ----
let secretHits = 0;
let pub; let secret;
test.before(async () => {
  pub = http.createServer((req, res) => {
    if (req.url === '/hop1') { res.writeHead(302, { location: '/hop2' }); return res.end(); }
    if (req.url === '/hop2') { res.writeHead(301, { location: '/final' }); return res.end(); }
    if (req.url === '/to-internal') { res.writeHead(302, { location: 'http://127.0.0.1:4111/admin' }); return res.end(); }
    if (req.url === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); return res.end(); }
    if (req.url === '/img-redirect') { res.writeHead(302, { location: 'http://127.0.0.1:4111/pixel.png' }); return res.end(); }
    if (req.url === '/robots.txt') { res.writeHead(302, { location: 'http://127.0.0.1:4111/robots.txt' }); return res.end(); }
    if (req.url === '/subresources') {
      res.setHeader('content-type', 'text/html');
      return res.end(`<html><body><h1>Store</h1>
        <img src="http://127.0.0.1:4111/direct.png"><img src="/img-redirect">
        <iframe src="http://127.0.0.1:4111/frame"></iframe>
        <script>fetch('http://127.0.0.1:4111/xhr').catch(()=>{}); new Image().src='http://[::1]:4111/v6';</script>
      </body></html>`);
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<html><body><p>public page ${req.url}</p></body></html>`);
  }).listen(4110);
  secret = http.createServer((req, res) => { secretHits += 1; res.end('<p>INTERNAL SECRET</p>'); }).listen(4111);
});
test.after(async () => {
  pub.close(); secret.close();
  try { await require('../src/render').closeBrowser(); } catch { /* none */ }
});

test('server-side fetch (robots.txt / conditional GET) refuses redirects into the network', async () => {
  await assert.rejects(safeFetch('http://127.0.0.1:4110/robots.txt'), /Blocked URL/);
  const ok = await safeFetch('http://127.0.0.1:4110/hop1');
  assert.strictEqual(ok.url, 'http://127.0.0.1:4110/final');
  assert.strictEqual(secretHits, 0);
});

const chromiumPath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const haveBrowser = fs.existsSync(chromiumPath);
if (haveBrowser) process.env.CHROMIUM_PATH = chromiumPath;

test('browser: allowed redirect chain is followed hop by hop', { skip: !haveBrowser && 'no Chromium' }, async () => {
  const { render } = require('../src/render');
  const page = await render('http://127.0.0.1:4110/hop1', { screenshot: false });
  assert.strictEqual(page.finalUrl, 'http://127.0.0.1:4110/final');
  assert.match(page.html, /public page \/final/);
});

test('browser: redirect to an internal service or cloud metadata is blocked', { skip: !haveBrowser && 'no Chromium' }, async () => {
  const { render } = require('../src/render');
  await assert.rejects(render('http://127.0.0.1:4110/to-internal', { screenshot: false }), /Blocked/);
  await assert.rejects(render('http://127.0.0.1:4110/to-metadata', { screenshot: false }), /Blocked/);
  assert.strictEqual(secretHits, 0, 'internal service was contacted');
});

test('browser: images, iframes, fetch() and redirected sub-resources cannot reach internal hosts', { skip: !haveBrowser && 'no Chromium' }, async () => {
  const { render } = require('../src/render');
  const page = await render('http://127.0.0.1:4110/subresources', { screenshot: true });
  assert.match(page.html, /Store/);
  assert.ok(page.blockedRequests.length >= 4, `blocked: ${JSON.stringify(page.blockedRequests)}`);
  assert.strictEqual(secretHits, 0, 'internal service was contacted');
});
