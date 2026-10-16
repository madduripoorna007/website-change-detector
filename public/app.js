// Dashboard SPA (vanilla JS, hash routing).
const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (d) => {
  if (!d) return '—';
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 0) return 'in ' + fmtDur(-s);
  return fmtDur(s) + ' ago';
};
const fmtDur = (s) => (s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`);
const when = (d) => (d ? new Date(d).toLocaleString() : '—');
const INTERVALS = [[15, '15 min'], [30, '30 min'], [60, '1 hour'], [180, '3 hours'], [360, '6 hours'], [720, '12 hours'], [1440, '24 hours']];

let me = null; // logged-in username

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && !path.startsWith('/api/auth/')) { me = null; showUser(); viewLogin(); throw new Error('Please log in'); }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showUser() {
  const el = document.getElementById('user');
  el.innerHTML = me ? `@${esc(me)} <button class="ghost" id="logout">Log out</button>` : '';
  const b = document.getElementById('logout');
  if (b) b.onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); me = null; showUser(); viewLogin(); };
}

// ---------------- Login / sign up ----------------
function viewLogin() {
  $app.innerHTML = `
    <div class="card" style="max-width:420px;margin:40px auto">
      <h2>Log in</h2>
      <form id="login">
        <label>Username</label><input name="username" autocomplete="username" required minlength="3" maxlength="32">
        <label>Password</label><input name="password" type="password" autocomplete="current-password" required minlength="8">
        <p class="row"><button type="submit" name="act" value="login">Log in</button>
        <button type="submit" class="ghost" name="act" value="register">Create account</button></p>
        <p class="muted">Passwords are stored as salted scrypt hashes. At least 8 characters.</p>
      </form>
    </div>`;
  const f = document.getElementById('login');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const act = e.submitter?.value === 'register' ? 'register' : 'login';
    try {
      const r = await api(`/api/auth/${act}`, { method: 'POST', body: { username: f.elements.username.value, password: f.elements.password.value } });
      me = r.username; showUser();
      if (!location.hash || location.hash === '#/login') location.hash = '#/'; else route();
    } catch (err) { toast(err.message); }
  };
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ---------------- Dashboard ----------------
async function viewDashboard() {
  $app.innerHTML = '<p class="muted">Loading…</p>';
  const watches = await api('/api/watches');
  if (!watches.length) {
    $app.innerHTML = `<div class="card"><h2>No pages yet</h2><p class="muted">Add a public URL to start watching it for meaningful changes.</p><a class="btn" href="#/new">+ Add page</a></div>`;
    return;
  }
  $app.innerHTML = `
    <div class="card">
      <table>
        <thead><tr><th>Name</th><th>Status</th><th>Every</th><th>Last checked</th><th>Last changed</th><th>Next check</th><th></th></tr></thead>
        <tbody>${watches.map((w) => `
          <tr>
            <td><a href="#/watch/${w._id}"><b>${esc(w.name)}</b></a><br><span class="muted">${esc(w.url)}</span></td>
            <td><span class="badge ${esc(w.status)}">${esc(w.status)}</span>${w.lastError ? `<br><span class="muted">${esc(w.lastError)}</span>` : ''}${w.active ? '' : '<br><span class="muted">paused</span>'}</td>
            <td>${esc(INTERVALS.find(([m]) => m === w.intervalMin)?.[1] || w.intervalMin + ' min')}</td>
            <td title="${when(w.lastCheckedAt)}">${ago(w.lastCheckedAt)}</td>
            <td title="${when(w.lastChangedAt)}">${ago(w.lastChangedAt)}</td>
            <td title="${when(w.nextCheckAt)}">${ago(w.nextCheckAt)}</td>
            <td><button class="ghost" data-check="${w._id}">Check now</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  $app.querySelectorAll('[data-check]').forEach((b) => b.onclick = async () => {
    try { await api(`/api/watches/${b.dataset.check}/check`, { method: 'POST' }); toast('Check queued'); } catch (e) { toast(e.message); }
  });
}

// ---------------- Add / edit form with visual picker ----------------
function formHtml(w = {}) {
  const ch = w.channels || {};
  return `
  <div class="card">
    <h2>${w._id ? 'Edit' : 'Add a page'}</h2>
    <form id="f">
      <div class="grid2">
        <div><label>URL (public pages only)</label><input name="url" required placeholder="https://example.com/pricing" value="${esc(w.url || '')}" ${w._id ? 'disabled' : ''}></div>
        <div><label>Name</label><input name="name" placeholder="Pricing page" value="${esc(w.name || '')}"></div>
        <div><label>Check every</label><select name="intervalMin">${INTERVALS.map(([m, l]) => `<option value="${m}" ${(w.intervalMin || 60) === m ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><label>Sensitivity</label><select name="sensitivity">
          ${[['low', 'Low: only big changes (≥10% of text)'], ['medium', 'Medium: ≥2% of text'], ['high', 'High: any change']].map(([v, l]) => `<option value="${v}" ${(w.sensitivity || 'medium') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>
      </div>
      <h3>Regions</h3>
      <p class="muted">Load a preview, then click elements: <b style="color:var(--ok)">watch</b> mode limits checks to those regions, <b style="color:var(--err)">ignore</b> mode removes them. Leave empty to watch the whole page.</p>
      <div class="row">
        <button type="button" id="loadPreview" class="ghost">Load preview</button>
        <label class="row" style="margin:0"><input type="radio" name="mode" value="watch" checked style="width:auto"> Watch</label>
        <label class="row" style="margin:0"><input type="radio" name="mode" value="ignore" style="width:auto"> Ignore</label>
        <span id="pickStatus" class="muted"></span>
      </div>
      <div id="picker"></div>
      <div class="grid2">
        <div><label>Watch selectors (one per line)</label><textarea name="watchSelectors">${esc((w.watchSelectors || []).join('\n'))}</textarea></div>
        <div><label>Ignore selectors (one per line)</label><textarea name="ignoreSelectors">${esc((w.ignoreSelectors || []).join('\n'))}</textarea></div>
      </div>
      <h3>Alerts</h3>
      <div class="grid2">
        <div><label>Email</label><input name="email" type="email" value="${esc(ch.email || '')}"></div>
        <div><label>Discord webhook URL</label><input name="discordWebhook" value="${esc(ch.discordWebhook || '')}"></div>
        <div><label>Telegram chat ID</label><input name="telegramChatId" value="${esc(ch.telegramChatId || '')}"></div>
        <div><label class="row" style="margin-top:34px"><input type="checkbox" name="digest" style="width:auto" ${w.digest ? 'checked' : ''}> Send a daily digest instead of instant alerts</label>
        <label class="row"><input type="checkbox" name="visualAlerts" style="width:auto" ${w.visualAlerts === false ? '' : 'checked'}> Also alert when it only <i>looks</i> different (image or layout changed, text the same)</label></div>
      </div>
      <h3>Extras</h3>
      <div class="grid2">
        <div><label>Keyword-only alerts (comma separated, alert only if added text contains one)</label><input name="keywords" value="${esc((w.keywords || []).join(', '))}"></div>
        <div><label>Track a number (CSS selector, e.g. a price)</label><input name="numberSelector" value="${esc(w.numberSelector || '')}"></div>
      </div>
      <p><button type="submit">${w._id ? 'Save' : 'Start watching'}</button></p>
    </form>
  </div>`;
}

function readForm(f) {
  const v = (n) => f.elements[n]?.value?.trim();
  return {
    url: v('url'), name: v('name'), intervalMin: Number(v('intervalMin')), sensitivity: v('sensitivity'),
    watchSelectors: v('watchSelectors'), ignoreSelectors: v('ignoreSelectors'),
    keywords: v('keywords'), numberSelector: v('numberSelector'),
    channels: { email: v('email'), discordWebhook: v('discordWebhook'), telegramChatId: v('telegramChatId') },
    digest: f.elements.digest.checked,
    visualAlerts: f.elements.visualAlerts.checked,
  };
}

function attachPicker(f) {
  document.getElementById('loadPreview').onclick = async () => {
    const url = f.elements.url.value.trim();
    const status = document.getElementById('pickStatus');
    if (!url) return toast('Enter a URL first');
    status.textContent = 'Rendering page…';
    try {
      const p = await api('/api/preview', { method: 'POST', body: { url } });
      status.textContent = `${p.elements.length} selectable elements`;
      if (!f.elements.name.value) f.elements.name.value = p.title || '';
      const holder = document.getElementById('picker');
      holder.innerHTML = `<div class="picker"><img src="/screenshots/${p.screenshot}"></div>`;
      const wrap = holder.firstChild;
      const img = wrap.querySelector('img');
      img.onload = () => {
        const scale = img.clientWidth / img.naturalWidth;
        // smaller elements on top so they are clickable inside big containers
        const els = [...p.elements].sort((a, b) => b.w * b.h - a.w * a.h);
        for (const el of els) {
          const d = document.createElement('div');
          d.className = 'box';
          Object.assign(d.style, { left: el.x * scale + 'px', top: el.y * scale + 'px', width: el.w * scale + 'px', height: el.h * scale + 'px' });
          d.title = `${el.selector}\n${el.text}`;
          d.onclick = (ev) => {
            ev.stopPropagation();
            const mode = f.elements.mode.value;
            const ta = f.elements[mode === 'watch' ? 'watchSelectors' : 'ignoreSelectors'];
            const lines = ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
            const i = lines.indexOf(el.selector);
            if (i >= 0) { lines.splice(i, 1); d.classList.remove(mode); } else { lines.push(el.selector); d.classList.add(mode); }
            ta.value = lines.join('\n');
          };
          wrap.appendChild(d);
        }
      };
    } catch (e) { status.textContent = e.message; }
  };
}

async function viewNew() {
  $app.innerHTML = formHtml();
  const f = document.getElementById('f');
  attachPicker(f);
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/watches', { method: 'POST', body: readForm(f) });
      toast(r.sharedTarget ? 'Already monitored by others: sharing the same checks' : 'Watching! First check is running.');
      location.hash = `#/watch/${r._id}`;
    } catch (err) { toast(err.message); }
  };
}

// ---------------- Watch detail: timeline, checks, alerts, chart ----------------
function deliveryBadges(a) {
  if (!a.deliveries?.length) return '';
  const cls = { sent: 'ok', failed: 'blocked', dead: 'error', pending: 'pending' };
  const label = { sent: 'sent', failed: 'retrying', dead: 'failed', pending: 'sending' };
  return ' ' + a.deliveries.map((d) => `<span class="badge ${cls[d.status]}" title="${esc(d.lastError || '')}${d.nextAttemptAt ? ` · next try ${esc(when(d.nextAttemptAt))}` : ''} · ${d.attempts} attempt(s)">${esc(d.channel)} ${label[d.status]}</span>`).join(' ');
}

function chart(points) {
  if (points.length < 2) return '<p class="muted">Not enough data yet.</p>';
  const W = 700; const H = 160; const vals = points.map((p) => p.value);
  const min = Math.min(...vals); const max = Math.max(...vals); const span = max - min || 1;
  const xy = points.map((p, i) => `${(i / (points.length - 1)) * W},${H - ((p.value - min) / span) * (H - 20) - 10}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;background:#0b0d11;border-radius:8px">
    <polyline fill="none" stroke="#5b8cff" stroke-width="2" points="${xy}"/></svg>
    <p class="muted">Min ${min} · Max ${max} · Latest ${vals[vals.length - 1]}</p>`;
}

async function viewWatch(id) {
  $app.innerHTML = '<p class="muted">Loading…</p>';
  const d = await api(`/api/watches/${id}`);
  const { watch: w, target: t, snapshots, checks, alerts, numbers, watchers } = d;
  $app.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div><h2 style="margin:0">${esc(w.name)}</h2><a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.url)}</a></div>
        <div class="row">
          <span class="badge ${esc(t.status)}">${esc(t.status)}</span>
          <button class="ghost" id="checkNow">Check now</button>
          <button class="ghost" id="toggle">${w.active ? 'Pause' : 'Resume'}</button>
          <a class="btn ghost" href="${esc(d.rssUrl)}" target="_blank" rel="noopener" title="Private feed link: anyone with it can read this page's changes">RSS</a>
          <button class="danger" id="del">Delete</button>
        </div>
      </div>
      <p class="muted">Last checked ${ago(t.lastCheckedAt)} · Last changed ${ago(w.lastChangedAt)} · Next check ${ago(t.nextCheckAt)} · ${watchers} watcher(s) share this page's checks${(t.autoIgnore?.length || t.autoMask?.length) ? ` · ${(t.autoIgnore?.length || 0) + (t.autoMask?.length || 0)} noisy element(s) auto-ignored` : ''}</p>
      ${t.lastError ? `<p style="color:var(--err)">${esc(t.lastError)}</p>` : ''}
    </div>
    <div class="grid2">
      <div class="card">
        <h3>Version timeline</h3>
        <p class="muted">Tick two versions to compare them.</p>
        <ul class="timeline">${snapshots.map((s, i) => `<li><label class="row" style="margin:0;color:var(--text)"><input type="checkbox" value="${s._id}" class="pick" style="width:auto" ${i < 2 ? 'checked' : ''}> ${when(s.createdAt)} ${i === 0 ? '<span class="badge ok">latest</span>' : ''}${s.visualOnly ? ' <span class="badge pending">visual</span>' : ''}</label></li>`).join('') || '<li class="muted">No snapshots yet.</li>'}</ul>
        <button id="compare" ${snapshots.length < 2 ? 'disabled' : ''}>Compare selected</button>
      </div>
      <div class="card">
        <h3>Alerts</h3>
        <ul>${alerts.map((a) => `<li>${when(a.createdAt)}: ${['change', 'visual'].includes(a.kind) ? `<a href="#/compare/${w._id}/${a.fromSnapshot}/${a.toSnapshot}">${esc(a.summary)}</a>` : `<b>${esc(a.kind)}</b> ${esc(a.summary)}`}${a.pendingDigest ? ' <span class="muted">(in next digest)</span>' : ''}${deliveryBadges(a)}</li>`).join('') || '<li class="muted">No alerts yet.</li>'}</ul>
      </div>
    </div>
    ${w.numberSelector ? `<div class="card"><h3>Tracked number <span class="muted">${esc(w.numberSelector)}</span></h3>${chart(numbers)}</div>` : ''}
    <div class="card">
      <h3>Recent checks</h3>
      <table><thead><tr><th>Time</th><th>Result</th><th>HTTP</th><th>Duration</th><th>Error</th></tr></thead>
      <tbody>${checks.map((c) => `<tr><td>${when(c.createdAt)}</td><td>${esc(c.result)}</td><td>${esc(c.httpStatus ?? '')}</td><td>${c.durationMs ? (c.durationMs / 1000).toFixed(1) + 's' : ''}</td><td class="muted">${esc(c.error || '')}</td></tr>`).join('')}</tbody></table>
    </div>
    <div id="edit"></div>`;

  document.getElementById('checkNow').onclick = async () => { try { await api(`/api/watches/${id}/check`, { method: 'POST' }); toast('Check queued'); } catch (e) { toast(e.message); } };
  document.getElementById('toggle').onclick = async () => { await api(`/api/watches/${id}`, { method: 'PATCH', body: { active: !w.active } }); viewWatch(id); };
  document.getElementById('del').onclick = async () => { if (confirm('Delete this watch?')) { await api(`/api/watches/${id}`, { method: 'DELETE' }); location.hash = '#/'; } };
  document.getElementById('compare').onclick = () => {
    const picked = [...document.querySelectorAll('.pick:checked')].map((c) => c.value);
    if (picked.length !== 2) return toast('Pick exactly two versions');
    location.hash = `#/compare/${id}/${picked[1]}/${picked[0]}`;
  };
  document.getElementById('edit').innerHTML = formHtml({ ...w, url: t.url });
  const f = document.getElementById('f');
  attachPicker(f);
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/api/watches/${id}`, { method: 'PATCH', body: readForm(f) }); toast('Saved'); viewWatch(id); } catch (err) { toast(err.message); }
  };
}

// ---------------- Compare two versions ----------------
async function viewCompare(watchId, a, b) {
  $app.innerHTML = '<p class="muted">Building diff…</p>';
  const d = await api(`/api/compare?watch=${watchId}&a=${a}&b=${b}`);
  const lines = d.parts.flatMap((p) => p.value.replace(/\n$/, '').split('\n').map((l) => `<span class="${p.added ? 'add' : p.removed ? 'rem' : 'same'}">${p.added ? '+ ' : p.removed ? '- ' : '  '}${esc(l)}</span>`));
  const changed = d.parts.some((p) => p.added || p.removed);
  $app.innerHTML = `
    <p><a href="#/watch/${watchId}">← Back</a></p>
    <div class="card">
      <h3>Text diff <span class="muted">${when(d.older.createdAt)} → ${when(d.newer.createdAt)}</span></h3>
      ${changed ? '' : '<p class="muted">No change inside your watched regions between these versions.</p>'}
      <div class="diff">${lines.join('')}</div>
    </div>
    <div class="card">
      <h3>Screenshots ${d.image?.percent !== undefined ? `<span class="muted">${d.image.percent}% of pixels changed</span>` : ''}</h3>
      <div class="shots">
        <div><p class="muted">Before</p><a href="/screenshots/${d.older.screenshot}" target="_blank"><img src="/screenshots/${d.older.screenshot}"></a></div>
        <div><p class="muted">After</p><a href="/screenshots/${d.newer.screenshot}" target="_blank"><img src="/screenshots/${d.newer.screenshot}"></a></div>
        <div><p class="muted">Highlighted changes</p>${d.image?.file ? `<a href="/screenshots/${d.image.file}" target="_blank"><img src="/screenshots/${d.image.file}"></a>` : `<p class="muted">${esc(d.image?.error || 'Unavailable')}</p>`}</div>
      </div>
    </div>`;
}

// ---------------- Router ----------------
async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  try {
    if (parts[0] === 'new') return await viewNew();
    if (parts[0] === 'watch' && parts[1]) return await viewWatch(parts[1]);
    if (parts[0] === 'compare' && parts[3]) return await viewCompare(parts[1], parts[2], parts[3]);
    return await viewDashboard();
  } catch (e) {
    $app.innerHTML = `<div class="card"><p style="color:var(--err)">${esc(e.message)}</p></div>`;
  }
}
window.addEventListener('hashchange', () => (me ? route() : viewLogin()));
(async () => {
  try { me = (await api('/api/auth/me')).username; showUser(); route(); } catch { viewLogin(); }
})();
setInterval(() => { if (me && (!location.hash || location.hash === '#/')) route(); }, 30000);
