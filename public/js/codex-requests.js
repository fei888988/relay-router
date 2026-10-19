// Codex request log: every request the router served from an official account, newest first.
import { store, esc, api, fmtK, fmtMs, fmtTime, modal, empty, pageHead, pill } from './core.js';
import { icon } from './icons.js';

let rows = [];
let accounts = [];
const filters = { ok: '', providerId: '' };
const RESULT = [['', '全部'], ['0', '失败'], ['failover', '有换号']];

const nameOf = (id) => accounts.find((a) => a.id === id)?.name || id || '无可用账号';
const notes = (r) => (r.attempts || []).map((a) => a.note).filter(Boolean);

function rowHtml(r, fresh, i = 0) {
  const ok = r.ok ? true : r.status >= 200 && r.status < 400;
  const sw = notes(r);
  return `<tr class="click ${fresh ? 'fresh' : ''}" data-id="${r.id}" style="--i:${Math.min(i, 24)}">
    <td class="faint small mono">${fmtTime(r.ts)}</td>
    <td class="small mono">${esc(r.model || '-')}</td>
    <td>${esc(nameOf(r.provider_id))}${sw.length ? ` <span class="tag" title="${esc(sw.join('；'))}">${icon('shuffle')}换号</span>` : ''}</td>
    <td>${pill(ok ? 'ok' : 'err', r.status || (ok ? 200 : '失败'))}</td>
    <td class="small mono">${fmtMs(r.duration_ms)}</td>
    <td class="small mono">${r.input_tokens != null ? `${fmtK(r.input_tokens)} / ${fmtK(r.output_tokens)}` : '-'}</td>
  </tr>`;
}

const qs = (extra = {}) => 'requests?' + new URLSearchParams({ limit: 100, kind: 'codex', ...Object.fromEntries(Object.entries({ ...filters, ...extra }).filter(([, v]) => v)) });

export async function render(el) {
  accounts = (store.codex && store.codex.accounts) || [];
  el.innerHTML = `
    ${pageHead('codex-requests', '<span class="tag" id="cr-count">…</span>')}
    <div class="filters" role="search" data-rv>
      <div class="chips" id="cr-ok">${RESULT.map(([k, v]) => `<button data-v="${k}" class="${filters.ok === k ? 'on' : ''}">${v}</button>`).join('')}</div>
      <select id="cr-a" aria-label="账号"><option value="">全部账号</option>${accounts.map((a) => `<option value="${esc(a.id)}" ${filters.providerId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
    </div>
    <div class="tablebox" data-rv><table>
      <thead><tr><th>时间</th><th>模型</th><th>账号</th><th>结果</th><th>耗时</th><th>输入 / 输出</th></tr></thead>
      <tbody id="cr-body" class="stagger"></tbody>
    </table></div>
    <div class="row" style="justify-content:center;margin-top:14px"><button class="btn ghost" id="cr-more">加载更多</button></div>`;
  const reload = async () => {
    rows = await api(qs());
    paint(el);
  };
  el.querySelector('#cr-ok').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filters.ok = b.dataset.v;
    el.querySelectorAll('#cr-ok button').forEach((x) => x.classList.toggle('on', x === b));
    reload();
  };
  el.querySelector('#cr-a').onchange = (e) => ((filters.providerId = e.target.value), reload());
  el.querySelector('#cr-more').onclick = async () => {
    if (rows.length) rows = rows.concat(await api(qs({ beforeId: rows[rows.length - 1].id })));
    paint(el);
  };
  el.querySelector('#cr-body').onclick = (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) detail(rows.find((r) => String(r.id) === tr.dataset.id));
  };
  await reload();
}

function paint(el) {
  const tb = el.querySelector('#cr-body');
  if (tb) tb.innerHTML = rows.length ? rows.map((r, i) => rowHtml(r, false, i)).join('') : `<tr><td colspan="6">${empty('还没有 Codex 请求')}</td></tr>`;
  const c = el.querySelector('#cr-count');
  if (c) c.textContent = `${rows.length} 条`;
}

export function onLive(el, r) {
  if (filters.ok || filters.providerId) return;
  const row = { id: r.id, ts: r.ts, kind: r.kind, model: r.model, provider_id: r.providerId, ok: r.ok ? 1 : 0, status: r.status,
    duration_ms: r.durationMs, input_tokens: r.inputTokens, output_tokens: r.outputTokens, attempts: r.attempts, error: r.error };
  rows.unshift(row);
  const tb = el.querySelector('#cr-body');
  if (!tb) return;
  if (!tb.querySelector('tr[data-id]')) tb.innerHTML = '';
  tb.insertAdjacentHTML('afterbegin', rowHtml(row, true));
  const c = el.querySelector('#cr-count');
  if (c) c.textContent = `${rows.length} 条`;
}

function detail(r) {
  if (!r) return;
  const tries = (r.attempts || []).filter((a) => a.status != null);
  const sw = notes(r);
  modal(`Codex 请求 · ${fmtTime(r.ts, true)}`, `
    <dl class="kv">
      <dt>模型</dt><dd>${esc(r.model || '-')}</dd>
      <dt>结果</dt><dd>${r.ok ? `由「${esc(nameOf(r.provider_id))}」完成` : `<span style="color:var(--err)">${esc(r.error || 'HTTP ' + (r.status || '失败'))}</span>`}</dd>
      <dt>tokens</dt><dd>输入 ${fmtK(r.input_tokens)} · 输出 ${fmtK(r.output_tokens)}</dd>
      <dt>耗时</dt><dd>${fmtMs(r.duration_ms)}</dd>
    </dl>
    ${sw.length ? `<div class="subhead">换号</div>${sw.map((n, i) => `<div class="attempt" style="--i:${i}">${icon('shuffle')} ${esc(n)}</div>`).join('')}` : ''}
    <div class="subhead">尝试过的账号</div>
    ${tries.length ? tries.map((a, i) => `<div class="attempt ${a.status < 400 ? '' : 'bad'}" style="--i:${i}"><div class="row"><b>${i + 1}. ${esc(nameOf(a.accountId))}</b>
      ${a.status < 400 ? '<span class="pill ok">成功</span>' : `<span class="pill err">HTTP ${a.status}</span>`}</div></div>`).join('') : '<p class="muted">无</p>'}`);
}
