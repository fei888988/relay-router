import { store, esc, api, fmtK, fmtMs, fmtTime, pname, modal, empty, pageHead, CATEGORY_TEXT } from './core.js';
import { icon } from './icons.js';

let rows = [];
const filters = { kind: 'messages', ok: '', providerId: '', q: '' };
const KIND = { messages: '对话', probe: '探测', compact: '摘要', count_tokens: '计数' };
const RESULT = [['', '全部'], ['0', '失败'], ['failover', '有切换']];

export function chainHtml(attempts) {
  return `<div class="chain">${(attempts || []).map((a, i) => {
    const x = i ? `<span class="x">${icon('chev')}</span>` : '';
    if (a.skipped) return `${x}<span class="hop skip" title="${esc(a.reason)}">${esc(pname(a.providerId))}</span>`;
    const why = a.ok ? '' : ` · ${esc(a.label || CATEGORY_TEXT[a.category] || '失败')}`;
    return `${x}<span class="hop ${a.ok ? '' : 'bad'}" title="${esc(a.message || '')}">${a.variant === 'compacted' ? icon('package') : ''}${esc(pname(a.providerId))}${why}</span>`;
  }).join('')}</div>`;
}

function rowHtml(r, fresh, i = 0) {
  const ctx = r.compacted ? `${fmtK(r.est_tokens)} → ${fmtK(r.sent_tokens)}` : fmtK(r.est_tokens);
  return `<tr class="click ${fresh ? 'fresh' : ''}" data-id="${r.id}" style="--i:${Math.min(i, 24)}">
    <td class="faint small mono">${fmtTime(r.ts)}</td>
    <td>${r.client_compact ? '<span class="tag">客户端 /compact</span> ' : ''}${r.kind !== 'messages' ? `<span class="tag">${KIND[r.kind] || r.kind}</span> ` : ''}${esc((r.model || '-').replace(/^claude-/, ''))}</td>
    <td>${chainHtml(r.attempts)}</td>
    <td class="small mono">${ctx}</td>
    <td class="small mono">${durBar(r.duration_ms)}</td>
    <td class="small mono">${r.input_tokens != null ? `${fmtK(r.input_tokens)} / ${fmtK(r.output_tokens)}` : '-'}</td>
  </tr>`;
}

// Duration as text plus a tiny log-scale bar (0.5s → 2min).
const durBar = (ms) => ms == null ? '-' : `<span class="dur"><i style="background:var(${ms < 20000 ? '--ok' : ms < 90000 ? '--warn' : '--err'});transform:scaleX(${Math.min(1, Math.max(0.04, Math.log10(Math.max(ms, 500) / 500) / Math.log10(240))).toFixed(3)})"></i></span>${fmtMs(ms)}`;

const qs = (extra = {}) => 'requests?' + new URLSearchParams({ limit: 100, ...Object.fromEntries(Object.entries({ ...filters, ...extra }).filter(([, v]) => v)) });

export async function render(el) {
  el.innerHTML = `
    ${pageHead('requests', '<span class="tag" id="req-count">…</span>')}
    <div class="filters" role="search" data-rv>
      <div class="chips" id="f-ok">${RESULT.map(([k, v]) => `<button data-v="${k}" class="${filters.ok === k ? 'on' : ''}">${v}</button>`).join('')}</div>
      <select id="f-kind" aria-label="类型">${Object.entries({ '': '全部类型', ...KIND }).map(([k, v]) => `<option value="${k}" ${filters.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <select id="f-p" aria-label="线路"><option value="">全部线路</option>${store.status.providers.map((p) => `<option value="${p.id}" ${filters.providerId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <span class="grow"></span>
      <label class="search">${icon('search')}<input id="f-q" placeholder="搜索模型或错误" value="${esc(filters.q)}" aria-label="搜索" /></label>
    </div>
    <div class="tablebox" data-rv><table>
      <thead><tr><th>时间</th><th>模型</th><th>路由</th><th>上下文</th><th>耗时</th><th>输入 / 输出</th></tr></thead>
      <tbody id="req-body" class="stagger">${skelRows()}</tbody>
    </table></div>
    <div class="row" style="justify-content:center;margin-top:14px"><button class="btn ghost" id="more">加载更多</button></div>`;
  const reload = async () => {
    const tb = el.querySelector('#req-body');
    if (tb && rows.length) tb.style.opacity = '.45';
    rows = await api(qs());
    if (tb) tb.style.opacity = '';
    paint(el);
  };
  el.querySelector('#f-ok').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filters.ok = b.dataset.v;
    el.querySelectorAll('#f-ok button').forEach((x) => x.classList.toggle('on', x === b));
    reload();
  };
  el.querySelector('#f-kind').onchange = (e) => ((filters.kind = e.target.value), reload());
  el.querySelector('#f-p').onchange = (e) => ((filters.providerId = e.target.value), reload());
  el.querySelector('#f-q').onkeydown = (e) => e.key === 'Enter' && ((filters.q = e.target.value.trim()), reload());
  el.querySelector('#more').onclick = async () => {
    if (rows.length) rows = rows.concat(await api(qs({ beforeId: rows[rows.length - 1].id })));
    paint(el);
  };
  el.querySelector('#req-body').onclick = (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) detail(rows.find((r) => String(r.id) === tr.dataset.id));
  };
  await reload();
}

const skelRows = () => Array.from({ length: 8 }, (_, i) => `<tr style="--i:${i}">${[60, 120, 220, 70, 60, 90].map((w) => `<td><div class="skel" style="width:${w}px"></div></td>`).join('')}</tr>`).join('');

function paint(el) {
  const tb = el.querySelector('#req-body');
  if (tb) tb.innerHTML = rows.length ? rows.map((r, i) => rowHtml(r, false, i)).join('') : `<tr><td colspan="6">${empty('暂无记录')}</td></tr>`;
  const c = el.querySelector('#req-count');
  if (c) c.textContent = `${rows.length} 条`;
}

export function onLive(el, r) {
  if ((filters.kind && filters.kind !== r.kind) || filters.ok || filters.providerId || filters.q) return;
  const row = {
    id: r.id, ts: r.ts, kind: r.kind, model: r.model, stream: r.stream, est_tokens: r.estTokens, sent_tokens: r.sentTokens,
    input_tokens: r.inputTokens, output_tokens: r.outputTokens, cache_read: r.cacheRead, cache_write: r.cacheWrite, provider_id: r.providerId,
    ok: r.ok ? 1 : 0, duration_ms: r.durationMs, ttfb_ms: r.ttfbMs, attempts: r.attempts, compacted: r.compacted ? 1 : 0, error: r.error, session: r.session,
    client_compact: r.clientCompact, cost_aware_retry: r.costAwareRetry, compacted_failover: r.compactedFailover,
  };
  rows.unshift(row);
  const tb = el.querySelector('#req-body');
  if (!tb) return;
  if (!tb.querySelector('tr[data-id]')) tb.innerHTML = '';
  tb.insertAdjacentHTML('afterbegin', rowHtml(row, true));
}

function detail(r) {
  if (!r) return;
  const att = (r.attempts || []).map((a, i) => `<div class="attempt ${a.skipped ? 'skip' : a.ok ? '' : 'bad'}" style="--i:${i}">
    <div class="row"><b>${i + 1}. ${esc(pname(a.providerId))}</b>
      ${a.skipped ? `<span class="pill">跳过</span><span class="muted small">${esc(a.reason)}</span>` : a.ok ? '<span class="pill ok">成功</span>' : `<span class="pill err">${esc(a.label || CATEGORY_TEXT[a.category] || '失败')}</span>`}
      ${a.variant === 'compacted' ? `<span class="tag">${icon('package')}发送摘要版</span>` : ''}
      ${a.costAwareRetry ? `<span class="tag">缓存保护重试 ${a.costAwareRetry}</span>` : ''}
      ${a.compactedFailover ? '<span class="tag">切换沿用摘要</span>' : ''}
      <span class="grow"></span>
      <span class="faint small">${[a.status ? 'HTTP ' + a.status : '', a.sentEst ? '≈' + fmtK(a.sentEst) : '', a.sentBytes != null ? a.sentBytes + ' bytes' : '', a.ms != null ? fmtMs(a.ms) : ''].filter(Boolean).join(' · ')}</span></div>
    ${a.next ? `<div class="small muted" style="margin-top:4px">→ ${esc(a.next)}</div>` : ''}
    ${a.message ? `<pre>${esc(a.message)}</pre>` : ''}
    ${a.raw && a.raw !== a.message ? `<details style="margin-top:6px"><summary class="small muted">原始响应</summary><pre>${esc(a.raw)}</pre></details>` : ''}
  </div>`).join('');
  modal(`请求详情 · ${fmtTime(r.ts, true)}`, `
    <dl class="kv">
      <dt>模型</dt><dd>${esc(r.model)}${r.stream ? '' : '（非流式）'}</dd>
      <dt>结果</dt><dd>${r.ok ? `由 ${esc(pname(r.provider_id))} 完成` : `<span style="color:var(--err)">${esc(r.error || '失败')}</span>`}</dd>
      <dt>上下文</dt><dd>≈${fmtK(r.est_tokens)}${r.compacted ? `，压缩后发送 ≈${fmtK(r.sent_tokens)}` : ''}</dd>
      <dt>tokens</dt><dd>输入 ${fmtK(r.input_tokens)}（缓存命中 ${fmtK(r.cache_read)}） · 输出 ${fmtK(r.output_tokens)}</dd>
      <dt>耗时</dt><dd>${fmtMs(r.duration_ms)}${r.ttfb_ms ? `，首字 ${fmtMs(r.ttfb_ms)}` : ''}</dd>
    </dl>
    <div class="subhead">经过的线路</div>${att || '<p class="muted">无</p>'}`);
}
