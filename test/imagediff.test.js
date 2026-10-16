const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-'));
const { PNG } = require('pngjs');
const config = require('../src/config');
const { imageDiff } = require('../src/diff');

function png(w, h, red) {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < p.data.length; i += 4) { p.data[i] = red ? 255 : 0; p.data[i + 1] = 0; p.data[i + 2] = 0; p.data[i + 3] = 255; }
  return PNG.sync.write(p);
}

test('screenshot diff handles different heights and highlights changes', () => {
  fs.mkdirSync(config.screenshotDir, { recursive: true });
  fs.writeFileSync(path.join(config.screenshotDir, 'a.png'), png(50, 40, false));
  fs.writeFileSync(path.join(config.screenshotDir, 'b.png'), png(50, 60, true));
  const r = imageDiff('a.png', 'b.png');
  assert.ok(fs.existsSync(path.join(config.screenshotDir, r.file)));
  assert.ok(r.percent > 50);
});
