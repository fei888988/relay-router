// Provider card on the overview page + its actions.
import { esc, api, fmtK, fmtMs, fmtAgo, providerStatus, pill, toast, busy, modal, CATEGORY_TEXT, store } from './core.js';
import { icon } from './icons.js';

export function providerCard(p, i, { isCur, pinned, stats, count }) {
  const ps = providerStatus(p);
  const h = p.health || {};
  const l = p.learned || {};
  const s = stats || {};
  const off = !p.enabled || !p.hasKey;
  const host = (p.baseUrl || '').replace(/^https?:\/\//, '');
  const ctx = l.minRejected ? fmtK(l.minRejected) : p.contextLimit && !p.hintDisproven ? fmtK(p.contextLimit) : '未触顶';
  const recentErr = h.lastError && (h.status !== 'healthy' || h.consecutiveFailures > 0 || Date.now() - h.lastError.ts < 600000);
  const mu = p.modelUnavailable || [];
  const tags = [
    p.allowCompaction ? `<span class="tag">${icon('package')}可压缩</span>` : '',
    l.minRejected ? `<span class="tag" title="被拒绝过的最小上下文（估算）">上限 ${fmtK(l.minRejected)} · 实测</span>` : '',
    p.hintDisproven ? `<span class="tag" title="预设上限 ${fmtK(p.contextLimit)}，但已成功处理 ${fmtK(l.maxAccepted)}；以真实拒绝为准">预设上限未生效</span>` : '',
    ...mu.map((m) => `<span class="tag" title="暂时改走其他线路">无 ${esc(m.model.replace(/^claude-/, ''))} · <span data-left="${m.until}"></span></span>`),
  ].join('');
  return `
  <article class="card pcard ${isCur ? 'cur' : ''} ${off ? 'off' : ''}">
    <div class="ptop">
      <span class="rank">${i + 1}</span>
      <span class="pname grow">${esc(p.name)}</span>
      ${pinned ? `<span class="pill warn">${icon('lock')}锁定</span>` : isCur ? '<span class="pill accent">使用中</span>' : ''}
      ${pill(ps.cls, ps.text)}
    </div>
    <div class="pmeta" title="${esc(p.baseUrl)}">${esc(host)} · ${esc(p.apiKeyMasked || '无令牌')}</div>
    <div class="pstatus">${ps.detail}${h.lastProbe && h.status !== 'healthy' ? ` · 上次探测${h.lastProbe.ok ? '成功' : '失败'}` : ''}</div>
    ${recentErr ? `<div class="errbox">${icon('alert')}<span><b>${esc(h.lastError.label || CATEGORY_TEXT[h.lastError.category] || '错误')}</b> ${fmtAgo(h.lastError.ts)} · ${esc((h.lastError.message || '').slice(0, 120))}</span></div>` : ''}
    <div class="mini">
      <div><b>${s.total || 0}</b><span>今日请求</span></div>
      <div><b>${s.total ? Math.round((s.ok / s.total) * 100) + '%' : '-'}</b><span>成功率</span></div>
      <div><b>${fmtMs(s.avg_ttfb)}</b><span>首字</span></div>
      <div><b>${ctx}</b><span>上下文</span></div>
    </div>
    ${tags ? `<div class="tags">${tags}</div>` : ''}
    <div class="pfoot">
      <button class="btn sm" data-act="probe" data-id="${p.id}" ${p.probing || off ? 'disabled' : ''}>${icon('activity')}${p.probing ? '探测中' : '探测'}</button>
      ${pinned ? `<button class="btn sm" data-act="auto">${icon('unlock')}解除锁定</button>` : `<button class="btn sm" data-act="pin" data-id="${p.id}" ${off ? 'disabled' : ''}>${icon('lock')}锁定</button>`}
      <span class="grow"></span>
      ${menu(p, i, count, h, l)}
    </div>
  </article>`;
}

function menu(p, i, count, h, l) {
  const bad = h.status !== 'healthy' || h.consecutiveFailures;
  const item = (act, ic, text, dis) => `<button data-act="${act}" data-id="${p.id}" ${dis ? 'disabled' : ''}>${icon(ic)}${text}</button>`;
  return `<details class="menu"><summary class="btn sm icon ghost" aria-label="更多操作">${icon('more')}</summary><div class="menu-pop">
    ${item('balance', 'coins', '查看用量')}
    ${bad ? item('reset', 'refresh', '恢复为正常') : item('offline', 'pause', '暂时下线')}
    ${item('toggle', 'power', p.enabled ? '停用' : '启用')}
    ${l.minRejected || l.maxAccepted ? item('forget', 'eraser', '清除学到的上限') : ''}
    <hr />${item('up', 'up', '提高优先级', i === 0)}${item('down', 'down', '降低优先级', i === count - 1)}
  </div></details>`;
}

export async function onAction(b, rerender) {
  const id = b.dataset.id;
  const act = b.dataset.act;
  const st = store.status;
  b.closest('details.menu')?.removeAttribute('open');
  await busy(b, async () => {
    if (act === 'auto') await api('mode', { method: 'POST', body: { mode: 'auto' } });
    else if (act === 'pin' || act === 'pin-cur') {
      const pid = act === 'pin' ? id : st.activeProviderId;
      if (!pid) return toast('没有可锁定的线路', 'warn');
      await api('mode', { method: 'POST', body: { mode: 'pinned', providerId: pid } });
    } else if (act === 'probe') {
      const { result: r } = await api(`providers/${id}/probe`, { method: 'POST' });
      toast(r.ok ? `探测正常 · ${esc(r.model)} · ${r.ms}ms` : `探测失败 · ${esc(r.label)}`, r.ok ? 'success' : 'error', 6000);
    } else if (act === 'balance') return showBalance(id);
    else {
      if (act === 'offline' && !confirm('暂时下线后会按周期自动探测，恢复了自动切回。确定吗？')) return;
      await api(`providers/${id}/${act}`, { method: 'POST' });
    }
    await rerender();
  });
}

async function showBalance(id) {
  const r = await api(`providers/${id}/balance`);
  if (r.error) return toast('查询失败：' + esc(r.error), 'warn');
  const usd = (q) => '$' + (q / 500000).toFixed(2);
  modal(`用量 · ${store.status.providers.find((p) => p.id === id).name}`, `<dl class="kv">
    <dt>令牌</dt><dd>${esc(r.name)}</dd>
    <dt>已用</dt><dd>${usd(r.total_used || 0)}</dd>
    <dt>剩余</dt><dd>${r.unlimited_quota ? '令牌不限额' : usd(r.total_available || 0)}</dd>
    <dt>过期</dt><dd>${r.expires_at > 0 ? new Date(r.expires_at * 1000).toLocaleString() : '永不'}</dd></dl>
    <p class="muted small" style="margin:14px 0 0">账户余额请到中转站网页查看。余额用尽时，路由会根据报错自动下线这条线路。</p>`);
}
