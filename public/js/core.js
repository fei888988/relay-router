// Shared helpers for the panel.
import { icon, LEVEL_ICON } from './icons.js';

export const store = { status: null };

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api/' + path, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-panel': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export async function refreshStatus() {
  store.status = await api('status');
  return store.status;
}

export const pname = (id) => {
  const p = store.status && store.status.providers.find((x) => x.id === id);
  return p ? p.name : id || '-';
};

const pad = (n) => String(n).padStart(2, '0');
export function fmtTime(ts, withDate) {
  if (!ts) return '-';
  const d = new Date(ts);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withDate || new Date().toDateString() !== d.toDateString() ? `${d.getMonth() + 1}/${d.getDate()} ${t}` : t;
}
export function fmtAgo(ts) {
  if (!ts) return '从未';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
export function fmtLeft(ts) {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
export const fmtK = (n) => (n == null ? '-' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n));
export const fmtMs = (n) => (n == null ? '-' : n >= 1000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + 'ms');

const REASONS = { quota: '额度不足', auth: '令牌无效', failures: '连续报错', rate_limit: '频繁限流', manual: '手动下线' };

// Short human status of a provider: { cls, text, detail }
export function providerStatus(p) {
  const h = p.health || {};
  if (!p.enabled) return { cls: '', text: '已停用', detail: '不参与路由' };
  if (!p.hasKey) return { cls: '', text: '待配置', detail: '还没填令牌' };
  if (h.status === 'down')
    return { cls: 'err', text: REASONS[h.downReason] || '已下线', detail: h.nextProbeAt ? `<span data-left="${h.nextProbeAt}"></span> 后自动探测` : '已下线' };
  if (h.status === 'cooldown' && h.cooldownUntil > Date.now())
    return { cls: 'warn', text: '冷却中', detail: `<span data-left="${h.cooldownUntil}"></span> 后恢复` };
  if (h.consecutiveFailures > 0) return { cls: 'warn', text: '不稳定', detail: `连续失败 ${h.consecutiveFailures} 次` };
  return { cls: 'ok', text: '正常', detail: h.lastOkAt ? `${fmtAgo(h.lastOkAt)}成功` : '等待请求' };
}

export const pill = (cls, text) => `<span class="pill ${cls}"><span class="d"></span>${text}</span>`;
export const empty = (text, ic = 'inbox') => `<div class="empty"><div class="radar">${icon(ic)}</div>${text}</div>`;

// Two equal workspaces, switched as a whole from the top bar (like CC Switch's app switch).
// Page registry per app: id, 中文名, icon, English code shown in the top bar.
export const APPS = {
  claude: {
    name: 'Claude', code: 'CLAUDE', pages: [
      ['overview', '概览', 'grid', 'OVERVIEW'],
      ['requests', '请求记录', 'list', 'REQUEST LOG'],
      ['events', '事件日志', 'bell', 'TELEMETRY'],
      ['sessions', '会话压缩', 'layers', 'COMPACTION'],
      ['providers', '中转站', 'server', 'RELAYS'],
      ['settings', '设置', 'sliders', 'CONTROLS'],
      ['guide', '接入指南', 'book', 'HANDBOOK'],
    ],
  },
  codex: {
    name: 'Codex', code: 'CODEX', pages: [
      ['codex', '号池', 'grid', 'POOL'],
      ['codex-requests', '请求记录', 'list', 'REQUEST LOG'],
      ['codex-events', '事件日志', 'bell', 'TELEMETRY'],
      ['codex-guide', '接入指南', 'book', 'HANDBOOK'],
    ],
  },
};
export const appOf = (page) => Object.keys(APPS).find((k) => APPS[k].pages.some((p) => p[0] === page)) || null;
store.app = appOf(location.hash.slice(1)) || (localStorage.getItem('sr-app') === 'codex' ? 'codex' : 'claude');
// Live binding: modules importing PAGES always see the current app's pages.
export let PAGES = APPS[store.app].pages;
export function setApp(app) {
  store.app = APPS[app] ? app : 'claude';
  PAGES = APPS[store.app].pages;
  localStorage.setItem('sr-app', store.app);
  document.body.dataset.app = store.app;
}
document.body.dataset.app = store.app;

// Compact count: 999 → 999, 1234 → 1.2k, 12345 → 12k, 1.5e6 → 1.5m.
export function fmtCount(n) {
  n = Number(n) || 0;
  const unit = (v, u) => (v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.floor(v))) + u;
  if (n >= 1e6) return unit(n / 1e6, 'm');
  if (n >= 1000) return unit(n / 1000, 'k');
  return String(n);
}

// Editorial page header: outlined index numeral + eyebrow + title + actions.
export function pageHead(id, acts = '', extra = '') {
  const pages = APPS[appOf(id) || store.app].pages;
  const i = pages.findIndex((p) => p[0] === id);
  const [, name, , code] = pages[i];
  return `<div class="head" data-rv><span class="idx" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
    <div class="ttl"><span class="eyebrow">${code}</span><h1>${name}${extra}</h1></div>
    ${acts ? `<div class="acts">${acts}</div>` : ''}</div>`;
}

export function toast(msg, level = 'info', ms = 5000) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.innerHTML = `<span class="lv">${icon(LEVEL_ICON[level] || 'info')}</span><span>${msg}</span><i class="life" style="animation-duration:${ms}ms"></i>`;
  const out = () => {
    if (el.classList.contains('out')) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 360);
  };
  el.onclick = out;
  box.appendChild(el);
  setTimeout(out, ms);
  while (box.children.length > 4) box.firstChild.remove();
}

// Close a <dialog> with an exit animation.
export function closeDialog(d) {
  if (!d.open || d.classList.contains('closing')) return;
  d.classList.add('closing');
  setTimeout(() => {
    if (!d.classList.contains('closing')) return; // re-opened meanwhile
    d.classList.remove('closing');
    d.close();
  }, 200);
}

export function modal(title, html) {
  const d = document.getElementById('modal');
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = html;
  d.classList.remove('closing');
  if (!d.open) d.showModal();
  return document.getElementById('modal-body');
}
export const closeModal = () => closeDialog(document.getElementById('modal'));

// Styled replacement for window.confirm(); resolves true/false.
export function ask(text, { ok = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    const body = modal('请确认', `<p style="margin:0 0 22px;font-size:14.5px;line-height:1.7">${esc(text)}</p>
      <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-a="0">取消</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-a="1">${esc(ok)}</button></div>`);
    const d = document.getElementById('modal');
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      d.removeEventListener('close', onClose);
      resolve(v);
    };
    const onClose = () => finish(false);
    d.addEventListener('close', onClose);
    body.onclick = (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      finish(b.dataset.a === '1');
      closeModal();
    };
    body.querySelector('[data-a="1"]').focus();
  });
}

// Disable a button while an async action runs; toast on error.
export async function busy(btn, fn) {
  if (btn) {
    btn.disabled = true;
    btn.classList.add('busy');
  }
  try {
    return await fn();
  } catch (e) {
    toast('操作失败：' + esc(e.message), 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  }
}

export async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制', 'success', 1800);
    if (btn) {
      btn.classList.add('done');
      setTimeout(() => btn.classList.remove('done'), 1600);
    }
  } catch {
    toast('复制失败，请手动选中复制', 'warn');
  }
}

export const CATEGORY_TEXT = {
  body_too_large: '请求体超限', context_overflow: '上下文超限', quota: '额度不足', auth: '令牌无效', model_unavailable: '无此模型',
  rate_limit: '限流', overloaded: '过载', server_error: '服务端错误', network: '网络错误', timeout: '超时',
  stream_error: '流中断', forbidden: '拒绝访问', bad_request: '请求被拒', aborted: '已取消', thinking_signature: '签名不兼容',
};
