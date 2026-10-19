import { store, esc, refreshStatus, fmtLeft, closeModal, toast, PAGES, APPS, appOf, setApp, fmtCount, api } from './core.js';
import { icon } from './icons.js';
import { reveal, scramble, reduced, booted, markBooted, initPointer, initRipple } from './fx.js';
import * as overview from './overview.js';
import * as requests from './requests.js';
import * as events from './events.js';
import * as sessions from './sessions.js';
import * as providers from './providers.js';
import * as settings from './settings.js';
import * as guide from './guide.js';
import * as codex from './codex.js';
import * as codexRequests from './codex-requests.js';
import * as codexGuide from './codex-guide.js';
import * as palette from './palette.js';

const MODULES = { overview, requests, events, sessions, providers, settings, guide, codex, 'codex-requests': codexRequests, 'codex-events': events, 'codex-guide': codexGuide };
const LIVE = new Set(['overview', 'codex']);
const lastPage = { claude: 'overview', codex: 'codex', ...JSON.parse(localStorage.getItem('sr-last') || '{}') };
let page = null;
let view = null;
let settleTimer = 0;

const main = document.getElementById('main');
document.getElementById('logo').innerHTML = icon('route');
const nav = document.getElementById('nav');

// ---------- App switch (top bar) ----------
const sw = document.getElementById('app-sw');
sw.innerHTML = `<span class="knob" aria-hidden="true"></span>` + Object.entries(APPS).map(([k, a]) =>
  `<button type="button" data-app="${k}" role="tab" aria-selected="false"><span class="dot"></span>${a.name}</button>`).join('');
sw.onclick = (e) => {
  const b = e.target.closest('[data-app]');
  if (b && b.dataset.app !== store.app) switchApp(b.dataset.app);
};
// Switching apps swaps the whole panel; each app remembers the page you were on.
function switchApp(app) {
  location.hash = lastPage[app] || APPS[app].pages[0][0];
}
function drawSwitch() {
  sw.classList.toggle('codex', store.app === 'codex');
  const st = store.status;
  const health = {
    claude: st ? (st.activeProviderId ? 'ok' : 'err') : '',
    codex: st && st.codex && st.codex.accounts ? (st.codex.available ? 'ok' : 'err') : '',
  };
  sw.querySelectorAll('[data-app]').forEach((b) => {
    const on = b.dataset.app === store.app;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
    b.querySelector('.dot').className = 'dot ' + health[b.dataset.app];
    b.title = on ? `当前：${APPS[b.dataset.app].name}` : `切换到 ${APPS[b.dataset.app].name}（按 \` 键）`;
  });
}

// ---------- Dock ----------
let navApp = null;
function buildNav() {
  navApp = store.app;
  nav.classList.remove('ready');
  nav.innerHTML = `<span class="ind" aria-hidden="true"></span>` + PAGES.map(([id, name, ic]) =>
    `<a href="#${id}" data-p="${id}">${icon(ic)}<span class="lbl">${name}</span><span class="n"></span></a>`).join('');
}

function placeInd() {
  const a = nav.querySelector('a.active');
  const ind = nav.querySelector('.ind');
  if (!a || !ind) return;
  ind.style.width = a.offsetWidth + 'px';
  ind.style.transform = `translateX(${a.offsetLeft}px)`;
}
// Per-page figure shown in the dock: what the page is about, not its position.
function counts() {
  const st = store.status;
  if (!st) return {};
  const t = (st.stats && st.stats.totals) || {};
  const cx = store.codex;
  const cxReq = cx ? cx.accounts.reduce((n, a) => n + ((a.stats && a.stats.requests24h) || 0), 0) : null;
  return {
    overview: [st.providers.filter((p) => p.usable).length, '条线路可用'],
    requests: [t.total || 0, '个请求（24 小时）'],
    sessions: [st.compaction ? st.compaction.sessions : 0, '个会话有压缩记录'],
    providers: [st.providers.length, '条中转线路'],
    codex: st.codex ? [st.codex.available, `个账号可用（共 ${st.codex.accounts} 个）`] : null,
    'codex-requests': cxReq == null ? null : [cxReq, '个请求（24 小时）'],
  };
}
function drawNav() {
  if (navApp !== store.app) buildNav();
  const st = store.status;
  const downs = st ? st.providers.filter((p) => p.enabled && p.health && p.health.status === 'down').length : 0;
  const cxDown = st && st.codex && st.codex.accounts ? st.codex.accounts - st.codex.available : 0;
  const c = counts();
  nav.querySelectorAll('a').forEach((a, i) => {
    a.classList.toggle('active', a.dataset.p === page);
    a.toggleAttribute('aria-current', a.dataset.p === page);
    const n = a.querySelector('.n');
    const v = c[a.dataset.p];
    const txt = v ? fmtCount(v[0]) : '';
    if (n.textContent !== txt) n.textContent = txt;
    a.title = `${PAGES[i][1]}${v ? ` · ${v[0].toLocaleString('en-US')} ${v[1]}` : ''}（按 ${i + 1}）`;
    let b = a.querySelector('.badge');
    const want = a.dataset.p === 'overview' && downs ? String(downs) : a.dataset.p === 'codex' && cxDown ? String(cxDown) : '';
    if (want && !b) a.insertAdjacentHTML('beforeend', `<span class="badge" title="不可用">${want}</span>`);
    else if (b && !want) b.remove();
    else if (b) b.textContent = want;
  });
  drawSwitch();
  placeInd();
  if (!nav.classList.contains('ready')) requestAnimationFrame(() => requestAnimationFrame(() => nav.classList.add('ready')));
}
addEventListener('resize', placeInd);
document.fonts?.ready.then(placeInd);

function crumb() {
  const i = PAGES.findIndex((p) => p[0] === page);
  document.getElementById('crumb-a').textContent = APPS[store.app].code;
  document.getElementById('crumb-i').textContent = String(i + 1).padStart(2, '0');
  scramble(document.getElementById('crumb-t'), PAGES[i][3], { dur: 500, wait: false });
  document.title = `${PAGES[i][1]} · ${APPS[store.app].name} · 智能路由`;
}

// ---------- Page transitions ----------
async function show(name) {
  const app = appOf(name) || store.app;
  const next = MODULES[name] && appOf(name) ? name : APPS[app].pages[0][0];
  const appChanged = app !== store.app;
  if (appChanged) setApp(app);
  lastPage[app] = next;
  localStorage.setItem('sr-last', JSON.stringify(lastPage));
  if (!store.status) await refreshStatus();
  if (store.app === 'codex' && !store.codex) await refreshCodex();
  const old = view;
  const same = next === page;
  page = next;
  drawNav();
  crumb();
  if (old && appChanged && !reduced) {
    old.classList.add('leaving', 'swap');
    await new Promise((r) => setTimeout(r, 260));
  } else if (old && !same && !reduced) {
    old.classList.add('leaving');
    await new Promise((r) => setTimeout(r, 200));
  }
  view = document.createElement('div'); // fresh container so handlers don't leak between pages
  view.className = 'view';
  if (page === 'overview') view.onclick = (e) => overview.onClick(e, rerender);
  main.replaceChildren(view);
  window.scrollTo(0, 0);
  const done = MODULES[page].render(view);
  reveal(view);
  clearTimeout(settleTimer);
  const v = view;
  booted.then(() => (settleTimer = setTimeout(() => v.classList.add('settled'), 2400)));
  await done;
}

async function refreshCodex() {
  try {
    store.codex = await api('codex/status');
  } catch {
    store.codex = null;
  }
}

async function rerender() {
  // Don't yank an open menu or dialog out from under the user; try again shortly.
  if (document.querySelector('details.menu[open]')) {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(rerender, 1500);
    return;
  }
  await refreshStatus();
  if (store.app === 'codex') await refreshCodex();
  drawNav();
  if (LIVE.has(page) && view) await MODULES[page].render(view, { quiet: true });
}
export { rerender };

function tick() {
  document.querySelectorAll('[data-left]').forEach((e) => (e.textContent = fmtLeft(Number(e.dataset.left))));
  const d = new Date();
  document.getElementById('clock').textContent = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}
setInterval(tick, 1000);
tick();

// ---------- Live stream ----------
let stateTimer = null;
function connect() {
  const conn = document.getElementById('conn');
  const es = new EventSource('/api/stream');
  es.onopen = () => {
    conn.className = 'conn on';
    conn.querySelector('.txt').textContent = 'LIVE';
  };
  es.onerror = () => {
    conn.className = 'conn off';
    conn.querySelector('.txt').textContent = '重连中…';
  };
  es.onmessage = (m) => {
    let msg;
    try {
      msg = JSON.parse(m.data);
    } catch {
      return;
    }
    if (msg.kind === 'event') {
      const e = msg.data;
      // Only pop up what matters; switches are already announced by the down/recover that caused them.
      const cxe = String(e.type).startsWith('codex_');
      if (['down', 'recover', 'cooldown', 'compaction', 'codex_exhaustion', 'codex_recovery', 'codex_switch', 'codex_auth'].includes(e.type) || (e.level === 'error' && e.type !== 'probe')) {
        toast(esc(e.message), e.level, e.level === 'error' ? 9000 : 5000);
      }
      if ((page === 'events' && !cxe) || (page === 'codex-events' && cxe)) events.onLive(view, e);
    }
    if (msg.kind === 'request') {
      const cxr = msg.data.kind === 'codex';
      if (page === 'requests' && !cxr) requests.onLive(view, msg.data);
      if (page === 'codex-requests' && cxr) codexRequests.onLive(view, msg.data);
      if (page === 'overview' && !cxr) overview.onRequest(msg.data);
    }
    clearTimeout(stateTimer);
    stateTimer = setTimeout(rerender, 800);
  };
}

// ---------- Dialogs ----------
const modalEl = document.getElementById('modal');
modalEl.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]') || e.target === modalEl) closeModal();
});
modalEl.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeModal();
});
document.addEventListener('click', (e) => {
  // Close any open row menu when clicking elsewhere.
  document.querySelectorAll('details.menu[open]').forEach((d) => !d.contains(e.target) && d.removeAttribute('open'));
});
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
// Periodic refresh so countdowns and due probes stay accurate.
setInterval(() => document.visibilityState === 'visible' && rerender(), 30000);

// Number keys jump between pages; Ctrl/⌘+K or / opens the palette.
document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    return palette.open();
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (e.key === '/') {
    e.preventDefault();
    return palette.open();
  }
  const n = Number(e.key);
  if (n >= 1 && n <= PAGES.length) location.hash = PAGES[n - 1][0];
  if (e.key === '`') switchApp(store.app === 'codex' ? 'claude' : 'codex');
});
document.getElementById('open-palette').onclick = () => palette.open();
palette.init({ rerender, go: (id) => (location.hash = id), switchApp });

// ---------- Boot sequence ----------
async function boot() {
  const el = document.getElementById('boot');
  const log = document.getElementById('boot-log');
  const fast = reduced || sessionStorage.getItem('sr-booted');
  const line = (k, v, bad) => log.insertAdjacentHTML('beforeend', `<li><span>${k}</span><b class="${bad ? 'bad' : ''}">${esc(v)}</b></li>`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let skip = false;
  const skipNow = () => (skip = true);
  el.addEventListener('click', skipNow);
  addEventListener('keydown', skipNow, { once: true });
  const pause = (ms) => (skip || fast ? Promise.resolve() : wait(ms));

  if (fast) el.classList.add('fast');
  else scramble(el.querySelector('.boot-name'), 'SMART · ROUTER', { dur: 900, wait: false });

  const start = location.hash.slice(1) || lastPage[store.app];
  const ready = refreshStatus().then(() => true, () => false);
  await pause(380);
  line('LINK  /api/stream', '…');
  const ok = await ready;
  log.lastElementChild.querySelector('b').textContent = ok ? 'OK' : 'FAIL';
  if (ok) {
    const st = store.status;
    await pause(220);
    const up = st.providers.filter((p) => p.usable).length;
    line(`RELAYS  ${st.providers.length}`, `${up} ONLINE`, !up);
    await pause(220);
    const cur = st.providers.find((p) => p.id === st.activeProviderId);
    line('ROUTE', cur ? cur.name : 'NONE', !cur);
    if (st.codex && st.codex.accounts) {
      await pause(220);
      line(`CODEX  ${st.codex.accounts}`, `${st.codex.available} READY`, !st.codex.available);
    }
  }
  // Paint the first page under the shutters so it's ready when they part.
  const shown = show(start).catch((e) => {
    main.innerHTML = `<div class="card">${esc('无法连接智能路由：' + e.message)}</div>`;
  });
  await pause(380);
  el.classList.add('slit');
  await wait(fast ? 60 : 340);
  el.classList.add('open');
  document.body.classList.remove('booting');
  markBooted();
  sessionStorage.setItem('sr-booted', '1');
  el.removeEventListener('click', skipNow);
  setTimeout(() => el.classList.add('gone'), 1000);
  await shown;
}

initPointer();
initRipple();
boot();
connect();
