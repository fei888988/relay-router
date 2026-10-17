import { store, esc, api, fmtK, fmtTime, providerStatus, empty } from './core.js';
import { icon, LEVEL_ICON } from './icons.js';
import { providerCard, onAction } from './pcard.js';

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6'];
const colorOf = (id) => {
  const i = store.status.providers.findIndex((p) => p.id === id);
  return i < 0 ? '#9ca3af' : COLORS[i % COLORS.length];
};

export function render(el) {
  const st = store.status;
  const cur = st.providers.find((p) => p.id === st.activeProviderId);
  const pinned = st.settings.mode === 'pinned';
  const per = Object.fromEntries((st.stats.per || []).map((x) => [x.provider_id, x]));
  el.innerHTML = `
    <div class="head"><h1>概览</h1></div>
    ${notices(st, pinned)}
    <section class="card hero">
      <div>
        <div class="label">正在使用</div>
        <div class="now">${cur ? esc(cur.name) : '<span style="color:var(--err)">没有可用线路</span>'}</div>
        <div class="sub">${pinned ? '已锁定，不会自动切换' : '出错自动切换，恢复后自动切回'}</div>
      </div>
      <div class="seg" role="group" aria-label="路由模式">
        <button class="${pinned ? '' : 'on'}" data-act="auto">${icon('zap')}自动</button>
        <button class="${pinned ? 'on' : ''}" data-act="pin-cur">${icon('lock')}锁定</button>
      </div>
      <div class="flow" aria-label="优先级">
        ${st.providers.map((p, i) => `${i ? `<span class="sep">${icon('chev')}</span>` : ''}<span class="node ${p.id === st.activeProviderId ? 'cur' : ''}"><span class="d ${providerStatus(p).cls}"></span>${esc(p.name)}</span>`).join('')}
      </div>
    </section>
    ${stats(st)}
    <div class="pgrid">${st.providers.map((p, i) => providerCard(p, i, { isCur: p.id === st.activeProviderId, pinned: pinned && st.settings.pinnedProviderId === p.id, stats: per[p.id], count: st.providers.length })).join('')}</div>
    <div class="cols">
      <section class="card chart"><div class="card-title"><h3>24 小时流量</h3></div>${chart(st)}</section>
      <section class="card"><div class="card-title"><h3>最近动态</h3><a href="#events" class="small">查看全部</a></div><ul class="feed" id="ov-feed"></ul></section>
    </div>`;
  feed(el);
}

function notices(st, pinned) {
  if (pinned) return `<div class="notice warn">${icon('lock')}已锁定线路，出错也不会切换<button class="btn sm" data-act="auto">恢复自动</button></div>`;
  if (st.lastResort) return `<div class="notice err">${icon('alert')}所有线路都已下线，正在逐个尽力尝试</div>`;
  return '';
}

function stats(st) {
  const t = st.stats.totals || {};
  const tok = (st.stats.per || []).reduce((n, x) => n + (x.input_tokens || 0) + (x.output_tokens || 0), 0);
  const rate = t.total ? (Math.round((t.ok / t.total) * 1000) / 10) + '%' : '-';
  const box = (ic, cls, v, k) => `<div class="card stat"><span class="ic ${cls}">${icon(ic)}</span><div><div class="v">${v}</div><div class="k">${k}</div></div></div>`;
  return `<div class="stats">
    ${box('activity', '', t.total || 0, '24 小时请求')}
    ${box('checkCircle', 'ok', rate, '成功率')}
    ${box('shuffle', 'warn', t.failovers || 0, '自动切换')}
    ${box('package', 'info', fmtK(tok), 'tokens')}
  </div>`;
}

function chart(st) {
  const H = 3600000;
  const end = Math.floor(Date.now() / H) * H;
  const hours = Array.from({ length: 24 }, (_, i) => end - (23 - i) * H);
  const by = {};
  for (const r of st.stats.timeline || []) (by[r.hour] = by[r.hour] || []).push(r);
  const max = Math.max(1, ...hours.map((h) => (by[h] || []).reduce((n, r) => n + r.n, 0)));
  const grid = [0.5, 1].map((f) => `<line x1="0" x2="720" y1="${140 - f * 125}" y2="${140 - f * 125}" stroke="currentColor" stroke-opacity=".18" stroke-dasharray="3 4"/>`).join('');
  const bars = hours.map((h, i) => {
    let y = 140;
    return (by[h] || []).map((r) => {
      const hh = Math.max((r.n / max) * 125, 2);
      y -= hh;
      const name = r.provider_id === '_none' ? '全部失败' : esc(st.providers.find((p) => p.id === r.provider_id)?.name || r.provider_id);
      return `<rect x="${i * 30 + 6}" y="${y}" width="18" height="${hh}" rx="4" fill="${r.provider_id === '_none' ? '#ef4444' : colorOf(r.provider_id)}"><title>${new Date(h).getHours()}:00 ${name} ${r.n} 次</title></rect>`;
    }).join('');
  }).join('');
  const ticks = hours.map((h, i) => (i % 6 === 5 ? `<text x="${i * 30 + 15}" y="160" font-size="11" text-anchor="middle" fill="currentColor">${new Date(h).getHours()}:00</text>` : '')).join('');
  const used = new Set((st.stats.timeline || []).map((r) => r.provider_id));
  const legend = st.providers.filter((p) => used.has(p.id)).map((p) => `<span><i style="background:${colorOf(p.id)}"></i>${esc(p.name)}</span>`).join('');
  if (!used.size) return empty('还没有请求', 'activity');
  return `<svg viewBox="0 0 720 165" preserveAspectRatio="none" role="img" aria-label="每小时请求数">${grid}${bars}${ticks}</svg><div class="legend">${legend}${used.has('_none') ? '<span><i style="background:#ef4444"></i>全部失败</span>' : ''}</div>`;
}

export const feedItem = (e, fresh) => `<li class="${fresh ? 'fresh' : ''}">
  <span class="lv ${e.level}">${icon(LEVEL_ICON[e.level] || 'info')}</span>
  <div>${esc(e.message)}${e.detail && e.detail.message ? `<details><summary>详情</summary><pre class="small">${esc(e.detail.message)}</pre></details>` : ''}</div>
  <time>${fmtTime(e.ts)}</time></li>`;

async function feed(el) {
  try {
    const evs = (await api('events?limit=30')).filter((e) => e.type !== 'probe').slice(0, 8);
    const box = el.querySelector('#ov-feed');
    if (box) box.innerHTML = evs.length ? evs.map((e) => feedItem(e)).join('') : `<li style="display:block">${empty('一切安静')}</li>`;
  } catch {}
}

export function onClick(e, rerender) {
  const b = e.target.closest('[data-act]');
  if (b && !b.disabled) onAction(b, rerender);
}
