// Regression: learning noise from a changing counter must never hide a price update.
const test = require('node:test');
const assert = require('node:assert');
const { learnNoise, cleanHtml, extractText, hash } = require('../src/noise');

// The counter sits INSIDE the same card as the price. The card has an id, so a css-path picker
// would give the counter a selector like "#card > span" that is not a prefix of the card's own
// selector. The old learner then marked the whole card as noisy and the price vanished.
const page = ({ price, viewers, cart }) => `<html><body>
  <header><b>VIT Campus Store</b></header>
  <main>
    <div id="card" class="product">
      <h2>VIT Official Hoodie</h2>
      <p class="price">${price}</p>
      <span class="live">${viewers} shoppers looking now</span>
      <p class="mixed">${price} · ${cart} in carts</p>
    </div>
  </main>
</body></html>`;

const learnFrom = () => learnNoise(page({ price: '₹999', viewers: 12, cart: 3 }), page({ price: '₹999', viewers: 47, cart: 9 }));
const textOf = (html, learned) => extractText(cleanHtml(html, learned));

test('learning ignores only the counter, never its container or the price', () => {
  const learned = learnFrom();
  const all = [...learned.ignore, ...learned.mask.map((m) => m.selector)];
  assert.ok(all.length > 0, 'the counter should be learned');
  for (const sel of all) {
    assert.ok(!/#card$|div:nth-child\(1\)$|main:nth-child\(\d+\)$/.test(sel), `container learned as noise: ${sel}`);
    assert.ok(!/p:nth-child\(2\)$/.test(sel), `price element learned as noise: ${sel}`);
  }
});

test('after learning, the counter alone does not change the hash', () => {
  const learned = learnFrom();
  const h1 = hash(textOf(page({ price: '₹999', viewers: 12, cart: 3 }), learned));
  const h2 = hash(textOf(page({ price: '₹999', viewers: 860, cart: 41 }), learned));
  assert.strictEqual(h1, h2);
});

test('after learning, a price update is still detected (even inside a partly-noisy line)', () => {
  const learned = learnFrom();
  const before = textOf(page({ price: '₹999', viewers: 12, cart: 3 }), learned);
  const after = textOf(page({ price: '₹799', viewers: 13, cart: 4 }), learned);
  assert.notStrictEqual(hash(before), hash(after));
  assert.ok(after.includes('₹799'), 'price visible in the standalone price element');
  assert.match(after, /₹799 · <noise> in carts/, 'stable words of the mixed line are kept, only the counter is masked');
});

test('a fully-changing leaf (rotating text) is ignored as a whole', () => {
  const a = '<body><div><h1>News</h1><p>Tip: drink water</p></div></body>';
  const b = '<body><div><h1>News</h1><p>Did you know? Owls can rotate their heads</p></div></body>';
  const learned = learnNoise(a, b);
  assert.deepStrictEqual(learned.ignore, ['body > div:nth-child(1) > p:nth-child(2)']);
  assert.strictEqual(extractText(cleanHtml(b, learned)), 'News');
});

test('counter with its own id inside an id-ed card (the case the old learner got wrong)', () => {
  const html = (p, v) => `<body><div id="card"><h2>Hoodie</h2><p class="price">${p}</p><span id="live-count">${v} shoppers looking now</span></div></body>`;
  const learned = learnNoise(html('₹999', 12), html('₹999', 47));
  const before = extractText(cleanHtml(html('₹999', 12), learned));
  const after = extractText(cleanHtml(html('₹799', 51), learned));
  assert.notStrictEqual(hash(before), hash(after), 'price change must be detected');
  assert.strictEqual(hash(before), hash(extractText(cleanHtml(html('₹999', 300), learned))), 'counter alone is noise');
});
