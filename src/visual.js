// Visual (screenshot) comparison, for changes that leave the text alone: a swapped image, a new
// colour, a moved block. Screenshots are taken with noise hidden (see render.js maskScript), so
// clocks, counters, ads and carousels do not count as visual changes.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');
const config = require('./config');

function pad(png, width, height) {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  out.data.fill(255);
  PNG.bitblt(png, out, 0, 0, Math.min(png.width, width), Math.min(png.height, height), 0, 0);
  return out;
}

// Returns a function that tells, for any set of boxes (or the whole page), what % of pixels changed.
function compareScreens(bufA, bufB) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const pa = pad(a, width, height);
  const pb = pad(b, width, height);
  const diff = new PNG({ width, height });
  const changed = pixelmatch(pa.data, pb.data, diff.data, width, height, { threshold: 0.1, includeAA: false, diffMask: true });
  const isChanged = (x, y) => diff.data[(y * width + x) * 4 + 3] > 0;
  return {
    width, height, heightChanged: a.height !== b.height,
    percent(boxes) {
      if (!boxes || !boxes.length) return (100 * changed) / (width * height);
      let total = 0; let hit = 0;
      for (const bx of boxes) {
        const x0 = Math.max(0, bx.x); const y0 = Math.max(0, bx.y);
        const x1 = Math.min(width, bx.x + bx.w); const y1 = Math.min(height, bx.y + bx.h);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { total += 1; if (isChanged(x, y)) hit += 1; }
      }
      return total ? (100 * hit) / total : 0;
    },
  };
}

function readShot(file) {
  try { return fs.readFileSync(path.join(config.screenshotDir, file)); } catch { return null; }
}

module.exports = { compareScreens, readShot };
