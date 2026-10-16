// The worker: runs checks from the queue, the scheduler tick and the daily digest.
const fs = require('fs');
const path = require('path');
const { Worker, DelayedError } = require('bullmq');
const cheerio = require('cheerio');
const config = require('./config');
const db = require('./db');
const { Target, Watch, Snapshot, Check, NumberPoint } = db;
const { connection, systemQueue, enqueueCheck } = require('./queue');
const { render } = require('./render');
const { cleanHtml, extractText, hash, detectBlocked, learnNoise } = require('./noise');
const { changeRatio, addedText } = require('./diff');
const polite = require('./polite');
const alerts = require('./alerts');
const { summarize } = require('./summarize');
const { compareScreens, readShot } = require('./visual');

fs.mkdirSync(config.screenshotDir, { recursive: true });

const MAX_HTML = 5 * 1024 * 1024;

async function activeWatches(targetId) {
  return Watch.find({ target: targetId, active: true });
}

async function scheduleNext(target) {
  target.nextCheckAt = new Date(Date.now() + target.intervalMin * 60000 + polite.jitter(target.intervalMin));
  await target.save();
}

// ---------- Failure handling: outages and CAPTCHAs are a status, never a change ----------
async function recordFailure(target, kind, message, httpStatus, retryAfter) {
  target.status = kind;
  target.lastError = message;
  target.lastCheckedAt = new Date();
  target.consecutiveFailures += 1;
  if (!target.failingSince) target.failingSince = new Date();
  const wait = polite.retryAfterMs(retryAfter) ?? polite.backoffMs(target.consecutiveFailures);
  target.backoffUntil = new Date(Date.now() + wait);
  await Check.create({ target: target._id, result: kind, httpStatus, error: message });

  if (target.consecutiveFailures >= config.failuresBeforeDownAlert) {
    for (const w of await activeWatches(target._id)) {
      if (w.downNotified) continue;
      await alerts.raise(w, {
        kind: 'down',
        summary: `${kind === 'blocked' ? 'Blocked' : 'Unreachable'} after ${target.consecutiveFailures} attempts: ${message}`,
        dedupeKey: `${w._id}:down:${target.failingSince.getTime()}`,
        url: target.url,
      });
      w.downNotified = true;
      await w.save();
    }
  }
  target.nextCheckAt = new Date(Math.max(target.backoffUntil.getTime(), Date.now() + target.intervalMin * 60000));
  await target.save();
}

async function recordRecovery(target) {
  if (target.consecutiveFailures === 0) return;
  for (const w of await Watch.find({ target: target._id, downNotified: true })) {
    await alerts.raise(w, {
      kind: 'recovered',
      summary: 'Page is reachable again.',
      dedupeKey: `${w._id}:up:${target.failingSince?.getTime()}`,
      url: target.url,
    });
    w.downNotified = false;
    await w.save();
  }
  target.consecutiveFailures = 0;
  target.failingSince = undefined;
  target.backoffUntil = undefined;
  target.lastError = undefined;
}

// ---------- Per-watch evaluation against the shared snapshot ----------
function extractNumber(html, selector) {
  try {
    const $ = cheerio.load(html);
    const txt = $(selector).first().text().replace(/,/g, '');
    const m = txt.match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  } catch { return null; }
}

async function evaluateWatch(watch, snapshot, target, force = false, visual = null) {
  const due = force || !watch.lastEvaluatedAt || Date.now() - watch.lastEvaluatedAt.getTime() >= watch.intervalMin * 60000 * 0.95;
  if (!due) return;
  watch.lastEvaluatedAt = new Date();

  // learned noise was already applied when the shared snapshot was cleaned
  const text = extractText(snapshot.html, { watchSelectors: watch.watchSelectors, ignoreSelectors: watch.ignoreSelectors });
  const h = hash(text);

  if (watch.numberSelector) {
    const n = extractNumber(snapshot.html, watch.numberSelector);
    if (n !== null) {
      const last = await NumberPoint.findOne({ watch: watch._id }).sort({ createdAt: -1 });
      if (!last || last.value !== n) await NumberPoint.create({ watch: watch._id, value: n });
    }
  }

  if (!watch.lastHash) { // first time: baseline, no alert
    Object.assign(watch, { lastHash: h, lastText: text, lastSnapshot: snapshot._id });
    return watch.save();
  }
  if (h === watch.lastHash) {
    // Text is identical. Did it *look* different (image swapped, layout moved)?
    if (visual && watch.visualAlerts !== false && watch.lastSnapshot && String(watch.lastSnapshot) !== String(snapshot._id)) {
      const pct = visual(watch);
      const need = config.visualSensitivity[watch.sensitivity] ?? 1;
      if (pct !== null && pct >= need) {
        const where = watch.watchSelectors.length ? 'of the watched area' : 'of the page';
        await alerts.raise(watch, {
          kind: 'visual',
          fromSnapshot: watch.lastSnapshot,
          toSnapshot: snapshot._id,
          summary: `Visual change: ${pct.toFixed(1)}% ${where} looks different (text unchanged)`,
          dedupeKey: `${watch._id}:visual:${snapshot._id}`,
          url: target.url,
        });
        Object.assign(watch, { lastSnapshot: snapshot._id, lastChangedAt: new Date() });
      }
    }
    return watch.save();
  }

  const ratio = changeRatio(watch.lastText, text);
  const threshold = config.sensitivity[watch.sensitivity] ?? 0.02;
  if (threshold > 0 && ratio < threshold) {
    // too small to matter; keep the old baseline so small changes still add up over time
    return watch.save();
  }

  if (watch.keywords.length) {
    const added = addedText(watch.lastText, text).toLowerCase();
    const hit = watch.keywords.some((k) => added.includes(k.toLowerCase()));
    if (!hit) {
      Object.assign(watch, { lastHash: h, lastText: text, lastSnapshot: snapshot._id });
      return watch.save();
    }
  }

  const summary = await summarize(watch.name, watch.lastText, text);
  await alerts.raise(watch, {
    kind: 'change',
    fromSnapshot: watch.lastSnapshot,
    toSnapshot: snapshot._id,
    summary,
    dedupeKey: `${watch._id}:${h}`,
    url: target.url,
  });
  Object.assign(watch, { lastHash: h, lastText: text, lastSnapshot: snapshot._id, lastChangedAt: new Date() });
  return watch.save();
}

// ---------- The check job ----------
async function processCheck(job, token) {
  const target = await Target.findById(job.data.targetId);
  if (!target) return 'gone';
  const watches = await activeWatches(target._id);
  if (!watches.length) { target.nextCheckAt = new Date(Date.now() + 24 * 3600 * 1000); await target.save(); return 'no-watchers'; }
  if (!job.data.manual && target.backoffUntil && target.backoffUntil > new Date()) return 'backing-off';

  if (!(await polite.robotsAllows(target.url))) {
    await recordFailure(target, 'blocked', 'Disallowed by robots.txt');
    return 'robots';
  }

  // per-domain politeness across all workers
  const slot = await polite.acquireDomainSlot(connection, target.domain);
  if (!slot.ok) {
    await job.moveToDelayed(Date.now() + slot.retryInMs, token);
    throw new DelayedError();
  }

  // cheap conditional request first
  const cond = await polite.conditionalCheck(target.url, target);
  if (cond.status === 429) { await recordFailure(target, 'blocked', 'Rate limited (429)', 429, cond.retryAfter); return 'rate-limited'; }
  if (cond.notModified && !job.data.manual) {
    await recordRecovery(target);
    target.status = 'ok';
    target.lastCheckedAt = new Date();
    await Check.create({ target: target._id, result: 'unchanged', httpStatus: 304 });
    await scheduleNext(target);
    return 'not-modified';
  }

  const renderOpts = {
    screenshot: true,
    maskNoise: true,
    maskSelectors: [...target.autoIgnore, ...target.autoMask.map((m) => m.selector), ...watches.flatMap((w) => w.ignoreSelectors)],
    boxSelectors: [...new Set(watches.flatMap((w) => w.watchSelectors))],
  };
  let page;
  try {
    page = await render(target.url, renderOpts);
    if (!target.learnedAt) {
      await new Promise((r) => setTimeout(r, 3000));
      const second = await render(target.url, renderOpts);
      const learned = learnNoise(page.html, second.html);
      target.autoIgnore = learned.ignore;
      target.autoMask = learned.mask;
      target.learnedAt = new Date();
      page = second;
    }
  } catch (err) {
    if (err.blocked) { await recordFailure(target, 'blocked', err.message); return 'ssrf-blocked'; } // never retried
    const willRetry = job.attemptsMade + 1 < (job.opts.attempts || 1);
    if (willRetry) throw err; // BullMQ retries with exponential backoff
    await recordFailure(target, 'error', err.message.split('\n')[0]);
    return 'error';
  }

  const { status, headers, html, title, screenshot, durationMs } = page;
  if (status >= 500 || status === 404 || status === 410 || status === 0) {
    await recordFailure(target, 'error', `HTTP ${status}`, status, headers['retry-after']);
    return 'http-error';
  }

  const cleaned = cleanHtml(html, { ignore: target.autoIgnore, mask: target.autoMask });
  const text = extractText(cleaned);
  const prev = target.lastSnapshot ? await Snapshot.findById(target.lastSnapshot).select('text') : null;
  const blocked = detectBlocked({ status, html, title, previousTextLength: prev?.text?.length || 0, textLength: text.length });
  if (blocked.blocked) {
    await recordFailure(target, 'blocked', blocked.reason, status, headers['retry-after']);
    return 'blocked';
  }

  await recordRecovery(target);
  const contentHash = hash(text);
  let snapshot = target.lastSnapshot ? await Snapshot.findById(target.lastSnapshot) : null;
  let result = 'unchanged';
  // visual comparison against the previous version's (noise-masked) screenshot
  let visualPct = null;
  if (snapshot && contentHash === target.lastHash && screenshot) {
    const prevShot = readShot(snapshot.screenshot);
    if (prevShot) visualPct = compareScreens(prevShot, screenshot).percent();
  }
  const textChanged = contentHash !== target.lastHash;
  const looksDifferent = visualPct !== null && visualPct >= config.visualSnapshotMinPct;
  if (textChanged || looksDifferent || !snapshot) {
    const file = `${target._id}_${Date.now()}.png`;
    fs.writeFileSync(path.join(config.screenshotDir, file), screenshot);
    snapshot = await Snapshot.create({
      target: target._id, contentHash, text, html: cleaned.slice(0, MAX_HTML), screenshot: file, title,
      visualOnly: !textChanged && !!target.lastHash, visualPct: visualPct ?? undefined, boxes: page.boxes || {},
    });
    if (target.lastHash) target.lastChangedAt = new Date();
    result = textChanged || !target.lastHash ? 'changed' : 'visual';
    target.lastHash = contentHash;
    target.lastSnapshot = snapshot._id;
  }

  target.status = 'ok';
  target.lastCheckedAt = new Date();
  target.etag = headers.etag;
  target.lastModified = headers['last-modified'];
  await Check.create({ target: target._id, result, httpStatus: status, durationMs });
  await scheduleNext(target);

  // per-watch visual check: compare the watch's own last version with this one, inside its regions
  const shotCache = new Map();
  const visualFor = (w) => {
    if (!snapshot.visualOnly && result !== 'visual') return null;
    const key = String(w.lastSnapshot);
    if (!shotCache.has(key)) {
      shotCache.set(key, null);
      return Snapshot.findById(w.lastSnapshot).select('screenshot boxes').then((prev) => {
        const buf = prev && readShot(prev.screenshot);
        const cmp = buf ? compareScreens(buf, screenshot) : null;
        shotCache.set(key, cmp);
        return cmp;
      });
    }
    return shotCache.get(key);
  };
  for (const w of watches) {
    try {
      const cmp = await visualFor(w);
      const visual = cmp ? (watch) => {
        if (!watch.watchSelectors.length) return cmp.percent();
        const boxes = watch.watchSelectors.flatMap((sel) => snapshot.boxes?.[sel] || []);
        return boxes.length ? cmp.percent(boxes) : null;
      } : null;
      await evaluateWatch(w, snapshot, target, job.data.manual, visual);
    } catch (e) { console.error('[watch]', w._id, e.message); }
  }
  return result;
}

// ---------- Scheduler tick: queue every target that is due ----------
async function schedulerTick() {
  const due = await Target.find({ nextCheckAt: { $lte: new Date() } }).select('_id').limit(500);
  for (const t of due) await enqueueCheck(t._id);
  return due.length;
}

async function main() {
  await db.connect();
  await systemQueue.upsertJobScheduler('tick', { every: 60000 }, { name: 'tick' });
  await systemQueue.upsertJobScheduler('alert-retry', { every: 60000 }, { name: 'alert-retry' });
  await systemQueue.upsertJobScheduler('digest', { pattern: `0 ${config.digestHourUtc} * * *`, tz: 'UTC' }, { name: 'digest' });

  const checks = new Worker('checks', processCheck, {
    connection,
    concurrency: config.workerConcurrency,
    lockDuration: 120000,
    limiter: { max: 30, duration: 60000 }, // global cap: 30 checks per minute per worker
  });
  checks.on('completed', (job, r) => console.log(`[check] ${job.data.targetId} -> ${r}`));
  checks.on('failed', (job, e) => console.warn(`[check] ${job?.data?.targetId} failed (attempt ${job?.attemptsMade}): ${e.message}`));

  new Worker('system', async (job) => {
    if (job.name === 'tick') return schedulerTick();
    if (job.name === 'digest') return alerts.sendDigests();
    if (job.name === 'alert-retry') return alerts.retryDeliveries();
    return null;
  }, { connection });

  console.log('Worker running');
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { evaluateWatch, processCheck };
