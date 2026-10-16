// End-to-end workflow test against a RUNNING stack (API + worker + MongoDB + Redis + demo store).
//   node scripts/e2e.js [apiBase] [demoBase]
// Defaults: http://localhost:3000 and http://localhost:4000 (inside Docker: http://demo:4000 for the worker).
// Needs MANUAL_CHECK_COOLDOWN_MS small (e.g. 2000) on the API so checks can be triggered back to back.
const API = process.argv[2] || process.env.E2E_API || 'http://localhost:3000';
const DEMO_ADMIN = process.argv[3] || process.env.E2E_DEMO_ADMIN || 'http://localhost:4000';
const DEMO_URL = process.env.E2E_DEMO_URL || `${DEMO_ADMIN}/product`; // the URL the worker will fetch
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const log = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures += 1; };

async function call(method, path, { cookie, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { Origin: API, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, json, text, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const admin = (p) => fetch(DEMO_ADMIN + p, { method: 'POST' }).then((r) => r.json());

async function account(name) {
  const pw = `${name}-password-123`;
  let r = await call('POST', '/api/auth/register', { body: { username: name, password: pw } });
  if (r.status === 409) r = await call('POST', '/api/auth/login', { body: { username: name, password: pw } });
  if (!r.cookie) throw new Error(`login failed for ${name}: ${r.text}`);
  return r.cookie;
}

async function checkAndWait(cookie, id, label) {
  const before = (await call('GET', `/api/watches/${id}`, { cookie })).json.checks[0]?._id;
  for (let i = 0; i < 10; i++) {
    const q = await call('POST', `/api/watches/${id}/check`, { cookie });
    if (q.status === 200) break;
    await sleep(1500);
  }
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const d = (await call('GET', `/api/watches/${id}`, { cookie })).json;
    if (d.checks[0] && d.checks[0]._id !== before) { console.log(`      ${label}: check -> ${d.checks[0].result}`); return d; }
  }
  throw new Error(`no check result for ${label}`);
}

const alertsOf = (d) => d.alerts.map((a) => a.kind + ':' + a.summary);

(async () => {
  console.log(`API ${API}  demo ${DEMO_URL}`);
  // reset demo store
  await admin('/admin/price?value=999'); await admin('/admin/stock?value=In%20stock');
  await admin('/admin/image?theme=blue'); await admin('/admin/layout?value=left');

  const alice = await account(`alice${Date.now() % 100000}`);
  const bob = await account(`bob${Date.now() % 100000}`);
  log(true, 'two accounts created and logged in');

  // alice watches the whole page, visual alerts on; bob watches only the price, same URL in another form
  const w1 = await call('POST', '/api/watches', { cookie: alice, body: { url: DEMO_URL, name: 'Hoodie (whole page)', sensitivity: 'medium', numberSelector: '#price' } });
  log(w1.status === 201, `alice adds the page (${w1.status})`);
  const bobUrl = DEMO_URL.replace('://', '://www.') + '?utm_source=insta';
  const w2 = await call('POST', '/api/watches', { cookie: bob, body: { url: DEMO_URL + '?utm_source=insta', name: 'Hoodie price only', watchSelectors: ['#price'] } });
  log(w2.status === 201 && w2.json.sharedTarget === true, `bob adds the same page via a different URL form -> shared target (${bobUrl})`);
  const A = w1.json._id; const B = w2.json._id;

  // wait for the first (learning) check
  let d;
  for (let i = 0; i < 60; i++) { await sleep(1000); d = (await call('GET', `/api/watches/${A}`, { cookie: alice })).json; if (d.snapshots.length) break; }
  log(d.snapshots.length === 1, `baseline snapshot stored; ${d.target.autoIgnore.length + d.target.autoMask.length} noisy element(s) learned from two loads`);
  log(d.watchers === 2, `one target, ${d.watchers} watchers`);

  // 1) noise only
  d = await checkAndWait(alice, A, 'noise only (clock, ad, views, tokens)');
  log(d.checks[0].result === 'unchanged' && d.alerts.length === 0, 'noise-only reload: unchanged, no alert');

  // 2) image swapped (text identical)
  await admin('/admin/image?theme=red');
  d = await checkAndWait(alice, A, 'product photo swapped');
  log(d.checks[0].result === 'visual', 'image swap detected as a VISUAL change (text identical)');
  log(d.alerts.some((a) => a.kind === 'visual'), `alice alerted: ${alertsOf(d).join(' | ')}`);
  let db = (await call('GET', `/api/watches/${B}`, { cookie: bob })).json;
  log(!db.alerts.length, 'bob (watching only #price) is NOT alerted for the image swap');

  // 3) layout moved (text identical)
  await admin('/admin/layout?value=right');
  d = await checkAndWait(alice, A, 'layout moved');
  log(d.checks[0].result === 'visual' && d.alerts.filter((a) => a.kind === 'visual').length === 2, 'layout move detected as a second visual change');
  db = (await call('GET', `/api/watches/${B}`, { cookie: bob })).json;
  log(db.alerts.length === 1 && db.alerts[0].kind === 'visual', `bob IS alerted when the price box itself moves: ${alertsOf(db).join(' | ')}`);

  // 4) noise again after visual changes: still quiet
  d = await checkAndWait(alice, A, 'noise only again');
  log(d.checks[0].result === 'unchanged', 'noise-only reload after visual changes: unchanged');

  // 5) real text change
  await admin('/admin/price?value=799');
  d = await checkAndWait(alice, A, 'price 999 -> 799');
  log(d.checks[0].result === 'changed' && d.alerts.some((a) => a.kind === 'change' && /799/.test(a.summary)), `price change alerted: ${d.alerts[0].summary}`);
  db = (await call('GET', `/api/watches/${B}`, { cookie: bob })).json;
  log(db.alerts.some((a) => a.kind === 'change' && /799/.test(a.summary)), 'bob alerted for the price change from the same shared fetch');
  log(d.numbers.map((n) => n.value).join('->') === '999->799', `number tracking: ${d.numbers.map((n) => n.value).join(' -> ')}`);

  // 6) compare + screenshots
  const [newer, older] = d.snapshots;
  const cmp = await call('GET', `/api/compare?watch=${A}&a=${older._id}&b=${newer._id}`, { cookie: alice });
  log(cmp.status === 200 && cmp.json.parts.some((p) => p.added && p.value.includes('799')), 'text diff shows the new price');
  const shot = await fetch(`${API}/screenshots/${cmp.json.image.file}`, { headers: { Cookie: alice } });
  log(shot.status === 200 && shot.headers.get('content-type') === 'image/png', 'highlighted screenshot diff served to the owner');
  const shotBob = await fetch(`${API}/screenshots/${cmp.json.image.file}`, { headers: { Cookie: await account(`eve${Date.now() % 100000}`) } });
  log(shotBob.status === 404, 'a third user who does not watch the page cannot load it (404)');

  // 7) RSS + isolation
  const rss = await fetch(d.rssUrl.replace(/^https?:\/\/[^/]+/, API)).then((r) => r.text());
  log(/<item>/.test(rss) && /799/.test(rss), 'private RSS feed lists the change');
  const steal = await call('GET', `/api/watches/${A}`, { cookie: bob });
  log(steal.status === 404, "bob cannot open alice's watch even though they share the page");

  // 8) SSRF through the full stack
  const ssrf = await call('POST', '/api/watches', { cookie: alice, body: { url: 'http://169.254.169.254/latest/meta-data/' } });
  log(ssrf.status === 400, `metadata URL refused: ${ssrf.json?.error}`);

  // reset demo
  await admin('/admin/price?value=999'); await admin('/admin/image?theme=blue'); await admin('/admin/layout?value=left');
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('E2E error:', e); process.exit(2); });
