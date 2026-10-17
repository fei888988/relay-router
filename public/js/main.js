import { store, esc, refreshStatus, fmtLeft, closeModal, toast, PAGES } from './core.js';
import { icon } from './icons.js';
import { reveal, scramble, reduced, booted, markBooted, initPointer, initRipple } from './fx.js';
import * as overview from './overview.js';
import * as requests from './requests.js';
import * as events from './events.js';
import * as sessions from './sessions.js';
import * as providers from './providers.js';
import * as settings from './settings.js';
import * as guide from './guide.js';
import * as palette from './palette.js';

const MODULES = { overview, requests, events, sessions, providers, settings, guide };
const LIVE = new Set(['overview']);
let page = null;
let view = null;
let settleTimer = 0;

const main = document.getElementById('main');
document.getElementById('logo').innerHTML = icon('route');
const nav = document.getElementById('nav');

// ---------- Dock ----------
nav.innerHTML = `<span class="ind" aria-hidden="true"></span>` + PAGES.map(([id, name, ic], i) =>
  `<a href="#${id}" data-p="${id}" title="${name}（${i + 1}）">${icon(ic)}<span class="lbl">${name}</span><span class="n">${i + 1}</span></a>`).join('');
const ind = nav.querySelector('.ind');

function placeInd() {
  const a = nav.querySelector('a.active');
  if (!a) return;
  ind.style.width = a.offsetWidth + 'px';
  ind.style.transform = `translateX(${a.offsetLeft}px)`;
}
function drawNav() {
  const st = store.status;
  const downs = st ? st.providers.filter((p) => p.enabled && p.health && p.health.status === 'down').length : 0;
  nav.querySelectorAll('a').forEach((a) => {
    a.classList.toggle('active', a.dataset.p === page);
    a.toggleAttribute('aria-current', a.dataset.p === page);
    let b = a.querySelector('.badge');
    const want = a.dataset.p === 'overview' && downs ? String(downs) : '';
    if (want && !b) a.insertAdjacentHTML('beforeend', `<span class="badge">${want}</span>`);
    else if (b && !want) b.remove();
    else if (b) b.textContent = want;
  });
  placeInd();
  if (!nav.classList.contains('ready')) requestAnimationFrame(() => nav.classList.add('ready'));
}
addEventListener('resize', placeInd);
document.fonts?.ready.then(placeInd);

function crumb() {
  const i = PAGES.findIndex((p) => p[0] === page);
  document.getElementById('crumb-i').textContent = String(i + 1).padStart(2, '0');
  scramble(document.getElementById('crumb-t'), PAGES[i][3], { dur: 500, wait: false });
  document.title = `${PAGES[i][1]} · 智能路由`;
}

// ---------- Page transitions ----------
async function show(name) {
  const next = MODULES[name] ? name : 'overview';
  if (!store.status) await refreshStatus();
  const old = view;
  const same = next === page;
  page = next;
  drawNav();
  crumb();
  if (old && !same && !reduced) {
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

async function rerender() {
  // Don't yank an open menu or dialog out from under the user; try again shortly.
  if (document.querySelector('details.menu[open]')) {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(rerender, 1500);
    return;
  }
  await refreshStatus();
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
      if (['down', 'recover', 'cooldown', 'compaction'].includes(e.type) || (e.level === 'error' && e.type !== 'probe')) {
        toast(esc(e.message), e.level, e.level === 'error' ? 9000 : 5000);
      }
      if (page === 'events') events.onLive(view, e);
    }
    if (msg.kind === 'request') {
      if (page === 'requests') requests.onLive(view, msg.data);
      if (page === 'overview') overview.onRequest(msg.data);
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
});
document.getElementById('open-palette').onclick = () => palette.open();
palette.init({ rerender, go: (id) => (location.hash = id) });

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

  const start = location.hash.slice(1) || 'overview';
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
