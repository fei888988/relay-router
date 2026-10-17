import { store, esc, refreshStatus, fmtLeft, closeModal } from './core.js';
import { icon } from './icons.js';
import * as overview from './overview.js';
import * as requests from './requests.js';
import * as events from './events.js';
import * as sessions from './sessions.js';
import * as providers from './providers.js';
import * as settings from './settings.js';
import * as guide from './guide.js';

const PAGES = [
  ['overview', '概览', 'grid'],
  ['requests', '请求记录', 'list'],
  ['events', '事件日志', 'bell'],
  ['sessions', '会话压缩', 'layers'],
  ['providers', '中转站', 'server'],
  ['settings', '设置', 'sliders'],
  ['guide', '接入指南', 'book'],
];
const MODULES = { overview, requests, events, sessions, providers, settings, guide };
const LIVE = new Set(['overview']);
let page = 'overview';
let view = null;

const main = document.getElementById('main');
document.getElementById('logo').innerHTML = icon('route');
const nav = document.getElementById('nav');

function drawNav() {
  const st = store.status;
  const downs = st ? st.providers.filter((p) => p.health && p.health.status === 'down').length : 0;
  nav.innerHTML = PAGES.map(([id, name, ic]) =>
    `<a href="#${id}" class="${page === id ? 'active' : ''}">${icon(ic)}<span>${name}</span>${id === 'overview' && downs ? `<span class="badge">${downs}</span>` : ''}</a>`
  ).join('');
}

async function show(name, { keepScroll } = {}) {
  page = MODULES[name] ? name : 'overview';
  if (!store.status) await refreshStatus();
  drawNav();
  const y = window.scrollY;
  view = document.createElement('div'); // fresh container so handlers don't leak between pages
  if (page === 'overview') view.onclick = (e) => overview.onClick(e, rerender);
  main.replaceChildren(view);
  await MODULES[page].render(view);
  if (keepScroll) window.scrollTo(0, y);
}

async function rerender() {
  // Don't yank an open menu out from under the user; try again shortly.
  if (document.querySelector('details.menu[open]')) {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(rerender, 1500);
    return;
  }
  await refreshStatus();
  if (LIVE.has(page)) await show(page, { keepScroll: true });
  else drawNav();
}

function tick() {
  document.querySelectorAll('[data-left]').forEach((e) => (e.textContent = fmtLeft(Number(e.dataset.left))));
}
setInterval(tick, 1000);

let stateTimer = null;
function connect() {
  const conn = document.getElementById('conn');
  const es = new EventSource('/api/stream');
  es.onopen = () => {
    conn.className = 'conn on';
    conn.querySelector('.txt').textContent = '实时连接';
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
    if (msg.kind === 'request' && page === 'requests') requests.onLive(view, msg.data);
    clearTimeout(stateTimer);
    stateTimer = setTimeout(rerender, 800);
  };
}

document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]') || e.target.id === 'modal') closeModal();
});
document.addEventListener('click', (e) => {
  // Close any open row menu when clicking elsewhere.
  document.querySelectorAll('details.menu[open]').forEach((d) => !d.contains(e.target) && d.removeAttribute('open'));
});
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
// Periodic refresh so countdowns and due probes stay accurate.
setInterval(() => document.visibilityState === 'visible' && rerender(), 30000);

show(location.hash.slice(1) || 'overview').catch((e) => {
  main.innerHTML = `<div class="card empty">无法连接智能路由：${esc(e.message)}</div>`;
});
connect();
