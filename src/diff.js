const Diff = require('diff');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');
const config = require('./config');

function textDiff(a = '', b = '') {
  return Diff.diffLines(a, b).map((p) => ({
    value: p.value,
    added: !!p.added,
    removed: !!p.removed,
  }));
}

// Fraction of characters that changed, 0..1
function changeRatio(a = '', b = '') {
  if (a === b) return 0;
  const parts = Diff.diffWordsWithSpace(a, b);
  let changed = 0;
  for (const p of parts) if (p.added || p.removed) changed += p.value.length;
  return changed / Math.max(a.length, b.length, 1);
}

function addedText(a = '', b = '') {
  return Diff.diffLines(a, b).filter((p) => p.added).map((p) => p.value).join('\n').trim();
}

function removedText(a = '', b = '') {
  return Diff.diffLines(a, b).filter((p) => p.removed).map((p) => p.value).join('\n').trim();
}

function basicSummary(a, b) {
  const parts = Diff.diffLines(a || '', b || '');
  let add = 0; let rem = 0;
  for (const p of parts) {
    if (p.added) add += p.count || 1;
    if (p.removed) rem += p.count || 1;
  }
  const firstAdded = (addedText(a, b).split('\n')[0] || '').slice(0, 120);
  return `${add} line(s) added, ${rem} removed${firstAdded ? `: "${firstAdded}"` : ''}`;
}

function padTo(png, width, height) {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  out.data.fill(255);
  PNG.bitblt(png, out, 0, 0, Math.min(png.width, width), Math.min(png.height, height), 0, 0);
  return out;
}

// Highlighted screenshot diff (changed pixels painted red). Cached on disk.
function imageDiff(fileA, fileB) {
  const outName = `diff_${path.parse(fileA).name}_${path.parse(fileB).name}.png`;
  const outPath = path.join(config.screenshotDir, outName);
  if (fs.existsSync(outPath)) return { file: outName };
  const a = PNG.sync.read(fs.readFileSync(path.join(config.screenshotDir, fileA)));
  const b = PNG.sync.read(fs.readFileSync(path.join(config.screenshotDir, fileB)));
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const pa = padTo(a, width, height);
  const pb = padTo(b, width, height);
  const out = new PNG({ width, height });
  const changedPixels = pixelmatch(pa.data, pb.data, out.data, width, height, { threshold: 0.1, alpha: 0.3, diffColor: [255, 0, 0] });
  fs.writeFileSync(outPath, PNG.sync.write(out));
  return { file: outName, changedPixels, percent: +(100 * changedPixels / (width * height)).toFixed(2) };
}

module.exports = { textDiff, changeRatio, addedText, removedText, basicSummary, imageDiff };
