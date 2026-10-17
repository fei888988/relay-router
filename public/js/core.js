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
export const empty = (text, ic = 'inbox') => `<div class="empty">${icon(ic)}${text}</div>`;

export function toast(msg, level = 'info', ms = 5000) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="lv ${level}">${icon(LEVEL_ICON[level] || 'info')}</span><span>${msg}</span>`;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
  while (box.children.length > 4) box.firstChild.remove();
}

export function modal(title, html) {
  const d = document.getElementById('modal');
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = html;
  if (!d.open) d.showModal();
  return document.getElementById('modal-body');
}
export const closeModal = () => document.getElementById('modal').close();

// Disable a button while an async action runs; toast on error.
export async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast('操作失败：' + esc(e.message), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制', 'success', 1800);
  } catch {
    toast('复制失败，请手动选中复制', 'warn');
  }
}

export const CATEGORY_TEXT = {
  body_too_large: '请求体超限', context_overflow: '上下文超限', quota: '额度不足', auth: '令牌无效', model_unavailable: '无此模型',
  rate_limit: '限流', overloaded: '过载', server_error: '服务端错误', network: '网络错误', timeout: '超时',
  stream_error: '流中断', forbidden: '拒绝访问', bad_request: '请求被拒', aborted: '已取消', thinking_signature: '签名不兼容',
};
