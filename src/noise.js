// Noise filtering: everything that makes a page "differ on every load".
const cheerio = require('cheerio');
const crypto = require('crypto');

// Elements that are noise on almost every site.
const NOISE_SELECTORS = [
  'script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'template', 'link', 'meta',
  '[class*="advert" i]', '[id*="advert" i]', '[class*="ad-slot" i]', '[class*="adsbygoogle" i]',
  '[id^="google_ads" i]', '[class*="sponsor" i]', '[data-ad]', '[data-ad-slot]',
  '[class*="cookie" i]', '[id*="cookie" i]', '[class*="consent" i]', '[id*="consent" i]',
  '[class*="carousel" i]', '[class*="slider" i]', '[class*="swiper" i]', '[class*="marquee" i]',
  '[class*="banner-rotat" i]', '[aria-live]', '[role="marquee"]', '[role="timer"]',
  '[class*="countdown" i]', '[class*="visitor-count" i]', '[class*="view-count" i]',
  'input[type="hidden"]',
];

// Regexes applied to text after extraction. Order matters: longest patterns first.
const NOISE_PATTERNS = [
  // ISO timestamps and dates
  [/\b\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?\b/g, '<date>'],
  // 16/10/2026, 10-16-26
  [/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/g, '<date>'],
  // 16 Oct 2026, October 16, 2026
  [/\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+\d{4}\b/gi, '<date>'],
  [/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?,?\s+\d{4}\b/gi, '<date>'],
  // times 14:29, 2:29 pm
  [/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm|ist|utc|gmt)?\b/gi, '<time>'],
  // relative times: "5 minutes ago", "just now", "updated 2h ago"
  [/\b(\d+|a|an)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?|mo|months?|y|yrs?|years?)\s+ago\b/gi, '<ago>'],
  [/\bjust now\b/gi, '<ago>'],
  // UUIDs, long hex/base64 tokens (CSRF, session ids, cache busters)
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  [/\b[0-9a-f]{24,}\b/gi, '<token>'],
  [/\b(?=[A-Za-z0-9_\-]*\d)(?=[A-Za-z0-9_\-]*[A-Za-z])[A-Za-z0-9_\-]{32,}\b/g, '<token>'],
  // counters: "1,234 views", "12k likes", "3 comments", "57 online"
  [/\b\d[\d,.]*\s*[km]?\s+(views?|likes?|comments?|shares?|followers?|online|visitors?|reads?|plays?|watching|people)\b/gi, '<count>'],
];

// learned = { ignore: [selectors], mask: [{ selector, words }] } from learnNoise.
// (A plain array is accepted too, as a list of selectors to ignore.)
function cleanHtml(html, learned = {}) {
  const $ = cheerio.load(html);
  applyLearned($, Array.isArray(learned) ? { ignore: learned } : learned);
  $(NOISE_SELECTORS.join(',')).remove();
  $('*').each((_, el) => {
    // strip attributes that commonly hold random tokens
    for (const attr of Object.keys(el.attribs || {})) {
      if (/^(nonce|data-reactid|data-react-checksum|data-csrf|data-token|data-nonce|data-timestamp)$/i.test(attr)) {
        $(el).removeAttr(attr);
      }
    }
  });
  return $.html();
}

function normalizeText(text) {
  let t = text.replace(/\u00a0/g, ' ');
  for (const [re, rep] of NOISE_PATTERNS) t = t.replace(re, rep);
  return t
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// Pull visible text out of HTML, one block per line, optionally limited to watched regions.
function extractText(html, { watchSelectors = [], ignoreSelectors = [] } = {}) {
  const $ = cheerio.load(html);
  for (const sel of ignoreSelectors) {
    try { $(sel).remove(); } catch { /* skip */ }
  }
  const BLOCK = 'p,div,li,h1,h2,h3,h4,h5,h6,tr,td,th,section,article,header,footer,br,dt,dd,pre,blockquote';
  $(BLOCK).each((_, el) => { $(el).append('\n'); });
  let raw;
  if (watchSelectors.length) {
    raw = watchSelectors.map((sel) => {
      try { return $(sel).map((_, el) => $(el).text()).get().join('\n'); } catch { return ''; }
    }).join('\n');
  } else {
    raw = $('body').length ? $('body').text() : $.root().text();
  }
  return normalizeText(raw);
}

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Outages and CAPTCHAs are a status, never a change.
const BLOCK_MARKERS = [
  /g-recaptcha|recaptcha\/api|hcaptcha\.com|challenges\.cloudflare\.com|cf-challenge|cf_chl_/i,
  /verify (that )?you are (a )?human|are you a robot|unusual traffic|access denied|attention required! \| cloudflare|checking your browser|please enable cookies/i,
  /captcha/i,
];

function detectBlocked({ status, html = '', title = '', previousTextLength = 0, textLength = 0 }) {
  if (status === 429) return { blocked: true, reason: 'Rate limited (429)' };
  if (status === 403 || status === 401) return { blocked: true, reason: `Access denied (${status})` };
  const head = (title + ' ' + html.slice(0, 200000));
  for (const re of BLOCK_MARKERS) {
    if (re.test(head)) {
      // "captcha" alone is weak evidence on a big page; require the page to be small or the title to match
      if (re === BLOCK_MARKERS[2] && textLength > 3000 && !/captcha/i.test(title)) continue;
      return { blocked: true, reason: 'CAPTCHA / bot challenge detected' };
    }
  }
  // Sudden collapse of content (e.g. empty shell, error page served with 200)
  if (previousTextLength > 500 && textLength < previousTextLength * 0.1) {
    return { blocked: true, reason: 'Page content collapsed by >90% (likely error or block page)' };
  }
  return { blocked: false };
}

// ---------- Noise learning: load twice, anything that differs is noise ----------
// Works on the raw HTML of two loads. Only *leaf text holders* (elements whose text is their
// own, with no child elements carrying text) can be learned as noise, so a container that
// merely holds a changing counter can never be ignored and hide its other children (e.g. a price).
// When only some words of a leaf differ ("₹999 · 37 in cart"), just those word positions are
// masked, so the stable words in the same element are still watched.
const LEARN_LIMIT = 50;

function domPath($, el) {
  const parts = [];
  let cur = el;
  while (cur && cur.type === 'tag' && cur.name !== 'body' && cur.name !== 'html') {
    const parent = cur.parent;
    const siblings = parent ? parent.children.filter((c) => c.type === 'tag') : [cur];
    parts.unshift(`${cur.name}:nth-child(${siblings.indexOf(cur) + 1})`);
    cur = parent;
  }
  return parts.length ? 'body > ' + parts.join(' > ') : null;
}

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'meta', 'link', 'title']);

function leafTexts(html) {
  const $ = cheerio.load(html);
  const out = new Map();
  $('body *').each((_, el) => {
    if (SKIP_TAGS.has(el.name)) return;
    if ($(el).closest('script,style,noscript,template,svg').length) return;
    const childHasText = $(el).children().toArray().some((c) => !SKIP_TAGS.has(c.name) && $(c).text().trim());
    if (childHasText) return; // not a leaf: never learned as noise
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text) return;
    const p = domPath($, el);
    if (p) out.set(p, text);
  });
  return out;
}

function learnNoise(htmlA, htmlB) {
  const a = leafTexts(htmlA);
  const b = leafTexts(htmlB);
  const ignore = [];
  const mask = [];
  for (const [sel, tb] of b) {
    if (!a.has(sel)) continue;
    const ta = a.get(sel);
    const na = normalizeText(ta); const nb = normalizeText(tb);
    if (na === nb) continue; // already handled by the text rules
    const wa = ta.split(' '); const wb = tb.split(' ');
    if (wa.length === wb.length) {
      const differs = wa.map((w, i) => w !== wb[i]);
      const stable = wa.filter((w, i) => !differs[i]);
      if (stable.some((w) => /[\p{L}\p{Sc}\d]/u.test(w))) {
        mask.push({ selector: sel, words: differs.map((d, i) => (d ? i : -1)).filter((i) => i >= 0) });
        continue;
      }
    }
    ignore.push(sel);
  }
  return { ignore: ignore.slice(0, LEARN_LIMIT), mask: mask.slice(0, LEARN_LIMIT) };
}

// Apply learned noise on raw HTML (before anything is removed, so nth-child paths still match).
function applyLearned($, { ignore = [], mask = [] } = {}) {
  for (const m of mask) {
    try {
      const el = $(m.selector).first();
      if (!el.length || el.children().length) continue;
      const words = el.text().replace(/\s+/g, ' ').trim().split(' ');
      for (const i of m.words) if (i < words.length) words[i] = '<noise>';
      el.text(words.join(' '));
    } catch { /* bad selector */ }
  }
  for (const sel of ignore) {
    try { $(sel).remove(); } catch { /* skip */ }
  }
}

module.exports = { learnNoise, leafTexts, NOISE_PATTERNS, cleanHtml, normalizeText, extractText, hash, detectBlocked, NOISE_SELECTORS };
