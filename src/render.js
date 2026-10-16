// Headless rendering with Playwright. One shared browser, a fresh context per check (no cookies, no credentials).
const { chromium } = require('playwright');
const config = require('./config');
const { checkUrl } = require('./url');
const { NOISE_SELECTORS, NOISE_PATTERNS } = require('./noise');

const AD_HOSTS = /doubleclick\.net|googlesyndication\.com|adservice\.google|googletagmanager\.com|google-analytics\.com|facebook\.net|scorecardresearch\.com|taboola\.com|outbrain\.com|criteo\.|amazon-adsystem\.com|hotjar\.com/i;
const VIEWPORT = { width: 1280, height: 900 };
const MAX_SHOT_HEIGHT = 5000;

let browserPromise;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ executablePath: config.chromiumPath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }
  return browserPromise;
}

// Runs inside the page: build a short, stable CSS selector for an element.
function cssPathInPage() {
  window.__cssPath = function cssPath(el) {
    if (!(el instanceof Element)) return '';
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.body && parts.length < 6) {
      if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && !/\d{3,}/.test(el.id)) {
        parts.unshift('#' + el.id);
        break;
      }
      let part = el.tagName.toLowerCase();
      const stableClass = [...el.classList].find((c) => /^[A-Za-z][\w-]{2,}$/.test(c) && !/\d{3,}|active|hover|open|selected|css-/.test(c));
      if (stableClass) part += '.' + stableClass;
      const parent = el.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === el.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
      }
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(' > ');
  };
}

// Every request the page makes goes through this guard. The browser never follows a redirect by
// itself: the main document's redirects are re-validated hop by hop, sub-resource redirects are
// followed here with each hop checked. Anything resolving to a private/internal address is aborted.
const MAX_HOPS = 5;
async function guardedFetch(route, url, hops = 0) {
  const verdict = await checkUrl(url, { allowlist: config.privateHostAllowlist });
  if (!verdict.ok) return { blocked: verdict.reason };
  const resp = await route.fetch({ url, maxRedirects: 0, timeout: config.renderTimeoutMs });
  const status = resp.status();
  const location = resp.headers().location;
  if (status >= 300 && status < 400 && location) {
    if (hops >= MAX_HOPS) return { blocked: 'Too many redirects' };
    return { redirect: new URL(location, url).toString(), resp };
  }
  return { resp };
}

// Runs in the page before the screenshot: hide (not remove, so layout is kept) everything that is
// noise: known noisy elements, learned noisy elements, and any text that matches the noise patterns.
function maskScript({ selectors, patterns }) {
  const hide = (el) => { if (el && el.style) el.style.setProperty('visibility', 'hidden', 'important'); };
  for (const sel of selectors) { try { document.querySelectorAll(sel).forEach(hide); } catch (e) { /* bad selector */ } }
  const res = patterns.map(([src, flags]) => new RegExp(src, flags.replace('g', '')));
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent;
    if (t.trim() && res.some((re) => re.test(t))) hide(n.parentElement);
  }
}
const MASK_PATTERNS = NOISE_PATTERNS.map(([re]) => [re.source, re.flags]);
const VISUAL_NOISE_SELECTORS = NOISE_SELECTORS.filter((s) => !['script', 'style', 'link', 'meta', 'template', 'noscript'].includes(s));

// opts.maskSelectors: extra selectors to hide in screenshots (learned noise, user ignore regions)
// opts.boxSelectors: selectors whose on-page boxes are reported (for per-region visual comparison)
async function render(url, { screenshot = true, collectElements = false, maskNoise = false, maskSelectors = [], boxSelectors = [] } = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent: config.userAgent,
    javaScriptEnabled: true,
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  const page = await context.newPage();
  const blockedRequests = [];
  let mainRedirect = null;
  await context.route('**/*', async (route) => {
    const req = route.request();
    const reqUrl = req.url();
    if (/^(data|blob|about):/i.test(reqUrl)) return route.continue();
    if (AD_HOSTS.test(reqUrl) || ['media', 'websocket', 'eventsource'].includes(req.resourceType())) return route.abort();
    try {
      const isMain = req.isNavigationRequest() && req.frame() === page.mainFrame();
      let target = reqUrl;
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        const r = await guardedFetch(route, target, hop);
        if (r.blocked) { blockedRequests.push({ url: target, reason: r.blocked }); return route.abort('blockedbyclient'); }
        if (r.redirect) {
          if (isMain) { mainRedirect = r.redirect; return route.abort('aborted'); } // re-navigate after validation
          target = r.redirect; continue;
        }
        return route.fulfill({ response: r.resp });
      }
      return route.abort('blockedbyclient');
    } catch {
      return route.abort('failed');
    }
  });
  await page.addInitScript(cssPathInPage);
  const started = Date.now();
  try {
    let resp = null;
    let current = url;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      mainRedirect = null;
      try {
        resp = await page.goto(current, { waitUntil: 'domcontentloaded', timeout: config.renderTimeoutMs });
      } catch (e) {
        if (!mainRedirect) {
          const why = blockedRequests.find((b) => b.url === current);
          if (why) throw Object.assign(new Error(`Blocked: ${why.reason} (${current})`), { blocked: true });
          throw e;
        }
      }
      if (!mainRedirect) break;
      current = mainRedirect;
      if (hop === MAX_HOPS) throw new Error('Too many redirects');
    }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    // pause animations so screenshots are comparable
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' }).catch(() => {});
    const status = resp ? resp.status() : 0;
    const headers = resp ? resp.headers() : {};
    const title = await page.title();
    const html = await page.content();

    let boxes = {};
    if (boxSelectors.length) {
      boxes = await page.evaluate((sels) => {
        const out = {};
        for (const sel of sels) {
          try {
            out[sel] = [...document.querySelectorAll(sel)].map((el) => {
              const r = el.getBoundingClientRect();
              return { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
            }).filter((b) => b.w > 0 && b.h > 0);
          } catch (e) { out[sel] = []; }
        }
        return out;
      }, boxSelectors).catch(() => ({}));
    }

    let shot = null;
    if (screenshot) {
      if (maskNoise) await page.evaluate(maskScript, { selectors: [...VISUAL_NOISE_SELECTORS, ...maskSelectors], patterns: MASK_PATTERNS }).catch(() => {});
      const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => VIEWPORT.height);
      shot = await page.screenshot({
        type: 'png',
        fullPage: true,
        clip: { x: 0, y: 0, width: VIEWPORT.width, height: Math.min(Math.max(height, VIEWPORT.height), MAX_SHOT_HEIGHT) },
      });
    }

    let elements = [];
    if (collectElements) {
      elements = await page.evaluate((maxH) => {
        const out = [];
        const seen = new Set();
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 10 || r.top + window.scrollY > maxH) continue;
          const style = getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ');
          if (!ownText && !['IMG', 'SECTION', 'ARTICLE', 'UL', 'TABLE', 'NAV', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN'].includes(el.tagName)) continue;
          const selector = window.__cssPath(el);
          if (!selector || seen.has(selector)) continue;
          seen.add(selector);
          out.push({
            selector,
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || '').trim().slice(0, 200),
            x: Math.round(r.left + window.scrollX),
            y: Math.round(r.top + window.scrollY),
            w: Math.round(r.width),
            h: Math.round(r.height),
          });
          if (out.length > 1500) break;
        }
        return out;
      }, MAX_SHOT_HEIGHT);
    }
    return { status, headers, title, html, screenshot: shot, elements, finalUrl: current, blockedRequests, boxes, durationMs: Date.now() - started };
  } finally {
    await context.close().catch(() => {});
  }
}

async function closeBrowser() {
  if (browserPromise) (await browserPromise).close();
  browserPromise = null;
}

module.exports = { render, closeBrowser, VIEWPORT };
