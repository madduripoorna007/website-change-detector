const test = require('node:test');
const assert = require('node:assert');
const { normalizeUrl, isPublicHost } = require('../src/url');
const { extractText, cleanHtml, hash, detectBlocked } = require('../src/noise');
const { changeRatio, basicSummary } = require('../src/diff');
const { parseRobots, isAllowed } = require('../src/polite');
const { learnNoise } = require('../src/noise');

test('same page, different URL forms -> one target', () => {
  const a = normalizeUrl('https://WWW.Example.com/pricing/?utm_source=x&b=2&a=1#top');
  const b = normalizeUrl('https://example.com/pricing?a=1&b=2');
  assert.strictEqual(a, b);
});

test('private hosts are rejected', () => {
  assert.strictEqual(isPublicHost('localhost'), false);
  assert.strictEqual(isPublicHost('192.168.1.4'), false);
  assert.strictEqual(isPublicHost('example.com'), true);
});

test('timestamps, counters and tokens do not change the hash', () => {
  const page = (time, views, token, ad) => cleanHtml(`<html><body>
    <h1>Pricing</h1><p>Pro plan: ₹799/month</p>
    <p>Updated ${time}</p><span>${views} views</span>
    <input type="hidden" name="csrf" value="${token}">
    <div class="ad-slot">${ad}</div><script>var t=${Math.random()}</script>
  </body></html>`);
  const h1 = hash(extractText(page('2026-10-16 14:29:01', '1,204', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', 'Buy shoes')));
  const h2 = hash(extractText(page('2026-10-16 14:44:59', '1,377', 'ffeeddccbbaa99887766554433221100', 'Buy phones')));
  assert.strictEqual(h1, h2);
});

test('a real change does change the hash', () => {
  const t1 = extractText('<body><p>Pro plan: ₹799/month</p></body>');
  const t2 = extractText('<body><p>Pro plan: ₹999/month</p></body>');
  assert.notStrictEqual(hash(t1), hash(t2));
  assert.ok(changeRatio(t1, t2) > 0);
  assert.match(basicSummary(t1, t2), /1 line\(s\) added/);
});

test('watch and ignore selectors', () => {
  const html = '<body><div id="price">₹799</div><div id="news">Breaking news</div></body>';
  assert.strictEqual(extractText(html, { watchSelectors: ['#price'] }), '₹799');
  assert.ok(!extractText(html, { ignoreSelectors: ['#news'] }).includes('Breaking'));
});

test('CAPTCHA and outages are blocked, not changes', () => {
  assert.ok(detectBlocked({ status: 200, title: 'Just a moment...', html: '<div class="cf-challenge"></div>', textLength: 50 }).blocked);
  assert.ok(detectBlocked({ status: 429 }).blocked);
  assert.ok(detectBlocked({ status: 200, html: '<p>ok</p>', previousTextLength: 5000, textLength: 100 }).blocked);
  assert.ok(!detectBlocked({ status: 200, html: '<p>normal page</p>', textLength: 2000 }).blocked);
});

test('robots.txt parsing', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\n');
  assert.strictEqual(isAllowed(rules, '/private/x'), false);
  assert.strictEqual(isAllowed(rules, '/private/ok'), true);
  assert.strictEqual(isAllowed(rules, '/public'), true);
});

test('two-load noise learning finds elements that differ', () => {
  const a = '<body><h1>Title</h1><p id="clock">Visitors right now: 12</p></body>';
  const b = '<body><h1>Title</h1><p id="clock">Visitors right now: 47</p></body>';
  const learned = learnNoise(a, b);
  assert.deepStrictEqual(learned.mask, [{ selector: 'body > p:nth-child(2)', words: [3] }]);
  assert.deepStrictEqual(learned.ignore, []);
});
