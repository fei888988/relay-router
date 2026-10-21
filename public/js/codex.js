// Codex pool: official ChatGPT accounts and custom relays in one priority order. The router serves
// Codex from the first member that can take the request and moves on when it runs out or fails.
import { store, esc, api, toast, busy, modal, closeModal, ask, pill, empty, copy, pageHead, fmtK, fmtMs, fmtTime, fmtAgo } from './core.js';
import { icon } from './icons.js';
import { reveal, countUp } from './fx.js';

let cx = null; // last /api/codex/status

const STATUS = {
  ok: ['ok', '可用'],
  exhausted: ['err', '额度用完'],
  cooldown: ['warn', '限流冷却'],
  auth: ['err', '需重新登录'],
  disabled: ['', '已停用'],
};

// "2 小时 13 分" style distance to a future timestamp.
function until(ts) {
  if (!ts) return '';
  const m = Math.max(0, Math.round((ts - Date.now()) / 60000));
  if (m < 1) return '不到 1 分钟';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} 小时${m % 60 ? ` ${m % 60} 分` : ''}`;
  return `${Math.floor(h / 24)} 天${h % 24 ? ` ${h % 24} 小时` : ''}`;
}
const resetAt = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const same = d.toDateString() === new Date().toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return same ? `今天 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

function windowName(w, fallback) {
  const m = w && w.windowMinutes;
  if (!m) return fallback;
  if (m % 10080 === 0) return m === 10080 ? '每周' : `${m / 10080} 周`;
  if (m % 1440 === 0) return `${m / 1440} 天`;
  if (m % 60 === 0) return `${m / 60} 小时`;
  return `${m} 分钟`;
}

const PLAN = { plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', free: 'Free', edu: 'Edu' };
const planTag = (p) => (p ? `<span class="tag">${esc(PLAN[String(p).toLowerCase()] || p)}</span>` : '');

function meter(w, fallback) {
  const name = windowName(w, fallback);
  if (!w || w.usedPercent == null) {
    return `<div class="cx-meter none"><div class="cx-mh"><span>${name}</span><b>–</b></div><div class="cx-bar"><i></i></div><div class="cx-mf">暂无数据</div></div>`;
  }
  const used = Math.max(0, Math.min(100, Number(w.usedPercent)));
  const left = Math.round(100 - used);
  const cls = left <= 0 ? 'err' : left <= 15 ? 'warn' : 'ok';
  // The bar is remaining quota (a fuel gauge), matching the "剩 N%" label.
  return `<div class="cx-meter ${cls}" role="meter" aria-label="${name}额度剩余" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${left}">
    <div class="cx-mh"><span>${name}</span><b>剩 ${left}%</b></div>
    <div class="cx-bar"><i style="transform:scaleX(${(left / 100).toFixed(3)})"></i></div>
    <div class="cx-mf">${w.resetsAt ? `${until(w.resetsAt)}后重置 · ${resetAt(w.resetsAt)}` : `已用 ${Math.round(used)}%`}</div>
  </div>`;
}

const isRelay = (a) => a.type === 'relay';
const host = (u) => { try { return new URL(u).host; } catch { return u || ''; } };

async function closeModalAndWait() {
  const dialog = document.getElementById('modal');
  if (!dialog?.open) return;
  const closed = new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
  closeModal();
  await closed;
}

function statusLine(a) {
  if (isRelay(a)) {
    if (a.status === 'cooldown') return a.until ? `暂时不可用，${until(a.until)}后自动重试` : '暂时不可用，稍后自动重试';
    if (a.status === 'auth') return '密钥被拒绝：编辑这个中转站，填入新的密钥';
    if (a.status === 'disabled') return '不参与路由';
    return a.lastUsedAt ? `${fmtAgo(a.lastUsedAt)}使用` : '待命';
  }
  if (a.status === 'exhausted') return a.exhaustedUntil ? `额度预计 ${resetAt(a.exhaustedUntil)} 恢复（${until(a.exhaustedUntil)}后），届时自动切回` : '额度用完，等待恢复';
  if (a.status === 'cooldown') return a.exhaustedUntil ? `被限流，${until(a.exhaustedUntil)}后再试` : '被限流，稍后再试';
  if (a.status === 'auth') return '登录已失效：在 Codex 里重新登录这个号，再从 CC Switch 导入一次';
  if (a.status === 'disabled') return '不参与路由';
  return a.lastUsedAt ? `${fmtAgo(a.lastUsedAt)}使用` : '待命';
}

function accountCard(a, i, n) {
  const [cls, text] = STATUS[a.status] || ['', a.status];
  const isCur = a.id === cx.activeAccountId;
  const pinned = cx.mode === 'pinned' && cx.pinnedAccountId === a.id;
  const u = a.usage || {};
  const s = a.stats || {};
  const off = a.status === 'disabled' || !a.enabled;
  return `<article class="cx-acc ${isCur ? 'cur' : ''} ${off ? 'off' : ''} s-${cls || 'off'}" data-id="${esc(a.id)}" data-rv>
    <div class="cx-rank">
      <button class="btn sm icon ghost" data-act="up" data-id="${esc(a.id)}" ${i === 0 ? 'disabled' : ''} aria-label="提高「${esc(a.name)}」的优先级">${icon('up')}</button>
      <span class="num" aria-label="优先级 ${i + 1}">${String(i + 1).padStart(2, '0')}</span>
      <button class="btn sm icon ghost" data-act="down" data-id="${esc(a.id)}" ${i === n - 1 ? 'disabled' : ''} aria-label="降低「${esc(a.name)}」的优先级">${icon('down')}</button>
    </div>
    <div class="cx-main">
      <div class="lane-top">
        <span class="pname" title="${esc(a.name)}">${esc(a.name)}</span>
        ${pinned ? `<span class="pill warn">${icon('lock')}锁定</span>` : isCur ? '<span class="pill accent">● 正在使用</span>' : ''}
        ${pill(cls, text)}
      </div>
      <div class="lane-meta"><span class="st">${statusLine(a)}</span>${isRelay(a) ? '<span class="tag cx-kind">中转站</span>' : `${a.email ? `<span>${esc(a.email)}</span>` : ''}${planTag(a.planType)}`}</div>
      <div class="cx-meters">
        ${isRelay(a) ? relayFacts(a) : `${meter(u.primary, '短周期')}${meter(u.secondary, '长周期')}`}
        <div class="cx-stat"><b>${s.requests24h || 0}</b><span>24H 请求</span></div>
        <div class="cx-stat"><b>${fmtK((s.inputTokens24h || 0) + (s.outputTokens24h || 0))}</b><span>TOKENS</span></div>
      </div>
      ${a.lastError && a.status !== 'ok' ? `<div class="errbox">${icon('alert')}<span>${esc(String(a.lastError.message || a.lastError).slice(0, 160))}</span></div>` : ''}
      <div class="lane-foot">
        ${isRelay(a)
          ? `<button class="btn sm" data-act="test" data-id="${esc(a.id)}">${icon('activity')}测试连接</button>`
          : `<button class="btn sm" data-act="usage" data-id="${esc(a.id)}" ${off ? 'disabled' : ''}>${icon('gauge')}刷新额度</button>`}
        ${pinned ? `<button class="btn sm" data-act="auto">${icon('unlock')}解除锁定</button>` : `<button class="btn sm" data-act="pin" data-id="${esc(a.id)}" ${off || a.status === 'auth' ? 'disabled' : ''}>${icon('lock')}只用这个</button>`}
        ${syncCtl(a)}
        ${isRelay(a)
          ? `<span class="faint small mono grow" title="密钥">${esc(a.keyHint || '')}${a.ccSwitchId ? ' · 来自 CC Switch' : ''}</span>`
          : `<span class="faint small mono grow" title="ChatGPT 账号 ID">${esc(a.accountIdMasked || '')}${u.updatedAt ? ` · 额度 ${fmtAgo(u.updatedAt)}更新` : ''}</span>`}
        ${menu(a)}
      </div>
    </div>
  </article>`;
}

function relayFacts(a) {
  return `<div class="cx-facts">
    <div><span>地址</span><b class="mono" title="${esc(a.baseUrl)}">${esc(host(a.baseUrl))}</b></div>
    <div><span>模型</span><b class="mono">${a.model ? esc(a.model) : '<i>跟随 Codex</i>'}</b></div>
  </div>`;
}

function syncCtl(a) {
  if (!a.bound) return '';
  const ss = a.syncState || {};
  const DIR = { to_ccswitch: '已推送到 CC Switch', from_ccswitch: '已从 CC Switch 取回', to_authfile: '已写入 Codex 登录文件', from_authfile: '已从 Codex 登录文件取回' };
  const state = !a.sync ? '关闭' : ss.lastError ? '同步出错' : ss.inSync ? '一致' : '待同步';
  const tip = !a.sync
    ? '关闭后两边各自刷新令牌，可能导致一边需要重新登录'
    : ss.lastError ? ss.lastError : `${ss.lastDirection ? DIR[ss.lastDirection] || '' : '尚未发生同步'}${ss.lastSyncAt ? ' · ' + fmtAgo(ss.lastSyncAt) : ''}`;
  return `<button class="cx-sync ${a.sync ? 'on' : ''} ${a.sync && ss.lastError ? 'bad' : ''}" data-act="sync-toggle" data-id="${esc(a.id)}" role="switch" aria-checked="${!!a.sync}" title="${esc(tip)}">
    <span class="sw" aria-hidden="true"><i></i></span><span>凭据同步 CC Switch</span><b>${state}</b></button>`;
}

function menu(a) {
  const item = (act, ic, text, dis) => `<button data-act="${act}" data-id="${esc(a.id)}" ${dis ? 'disabled' : ''}>${icon(ic)}${text}</button>`;
  return `<details class="menu"><summary class="btn sm icon ghost" aria-label="更多操作">${icon('more')}</summary><div class="menu-pop">
    ${a.status !== 'ok' && a.status !== 'disabled' ? item('reset', 'refresh', '恢复为可用') : ''}
    ${a.bound && a.sync ? item('sync-now', 'refresh', '立即同步凭据') : ''}
    ${item('toggle', 'power', a.enabled ? '停用' : '启用')}
    ${isRelay(a) ? item('edit', 'sliders', '编辑') : item('rename', 'sliders', '重命名')}
    <hr />${item('delete', 'trash', '从路由移除')}
  </div></details>`;
}

function hero() {
  const cur = cx.accounts.find((a) => a.id === cx.activeAccountId);
  const pinned = cx.mode === 'pinned';
  const name = cur ? cur.name : cx.accounts.length ? '没有可用线路' : '还没有账号或中转站';
  return `<section class="ov-hero ${cur ? '' : 'dead'}" data-rv>
    <div class="eyebrow"><span class="live">${cur ? 'NOW SERVING' : 'NO ROUTE'}</span><span class="rule"></span><span>${esc(cx.endpoint.replace(/^https?:\/\//, ''))}</span></div>
    <h1 class="ov-name"><span class="glyph">›</span><span>${esc(name)}</span></h1>
    <div class="ov-side">
      <div class="seg ${pinned ? 'locked' : ''}" role="group" aria-label="Codex 路由模式">
        <button class="${pinned ? '' : 'on'}" data-act="auto" aria-pressed="${!pinned}">${icon('zap')}自动切换</button>
        <button class="${pinned ? 'on' : ''}" data-act="pin-cur" aria-pressed="${pinned}" ${cur ? '' : 'disabled'}>${icon('lock')}锁定</button>
      </div>
      <div class="ov-sub">${pinned ? '已锁定；它不可用时仍会临时借用下一个' : '额度用完或出错就换下一个，恢复后切回排在前面的'}</div>
    </div>
  </section>`;
}

function notices() {
  const list = cx.accounts.filter((a) => a.enabled);
  if (!list.length) return '';
  const usable = list.filter((a) => a.status === 'ok');
  if (!usable.length) {
    const next = list.map((a) => a.exhaustedUntil || a.until).filter(Boolean).sort((a, b) => a - b)[0];
    return `<div class="notice err">${icon('alert')}所有账号和中转站都不可用${next ? `，最早 ${resetAt(next)} 恢复（${until(next)}后）` : ''}</div>`;
  }
  const auth = list.filter((a) => a.status === 'auth' && !isRelay(a));
  if (auth.length) return `<div class="notice warn">${icon('key')}${auth.map((a) => `「${esc(a.name)}」`).join('')}登录已失效，已跳过。重新登录后从 CC Switch 再导入一次即可<button class="btn sm" data-act="import">${icon('download')}导入</button></div>`;
  return '';
}

function recentCard() {
  const rows = cx.recent || [];
  const nameOf = (id) => cx.accounts.find((a) => a.id === id)?.name || id || '-';
  const body = rows.length
    ? `<div class="tablebox cx-recent"><table><thead><tr><th>时间</th><th>账号</th><th>模型</th><th>结果</th><th>耗时</th><th>输入 / 输出</th></tr></thead><tbody>
      ${rows.map((r) => {
        const ok = r.status >= 200 && r.status < 400;
        return `<tr><td class="faint small mono">${fmtTime(r.ts)}</td><td>${esc(nameOf(r.accountId))}</td><td class="small mono">${esc(r.model || '-')}</td>
          <td>${pill(ok ? 'ok' : 'err', r.status || '-')}${r.note ? ` <span class="tag" title="${esc(r.note)}">${icon('shuffle')}${esc(r.note.slice(0, 40))}</span>` : ''}</td>
          <td class="small mono">${fmtMs(r.durationMs)}</td><td class="small mono">${r.inputTokens != null ? `${fmtK(r.inputTokens)} / ${fmtK(r.outputTokens)}` : '-'}</td></tr>`;
      }).join('')}</tbody></table></div>`
    : empty('还没有 Codex 请求。<br>按 <a href="#codex-guide">接入指南</a> 把 Codex 指向路由后，请求会出现在这里。', 'activity');
  return `<section class="card hud" style="margin-top:16px" data-rv><div class="card-title"><h3>最近请求</h3><a href="#codex-requests">查看全部 →</a></div>${body}</section>`;
}

function strip() {
  const list = cx.accounts.filter((a) => a.enabled);
  const usable = list.filter((a) => a.status === 'ok').length;
  const req = cx.accounts.reduce((n, a) => n + ((a.stats && a.stats.requests24h) || 0), 0);
  const tok = cx.accounts.reduce((n, a) => n + ((a.stats && (a.stats.inputTokens24h || 0) + (a.stats.outputTokens24h || 0)) || 0), 0);
  const switches = (cx.recent || []).filter((r) => r.note).length;
  const cell = (key, c, ic, label, n, fmt, sub) => `<div class="cell" style="--c:${c}" data-rv><div class="k">${icon(ic)}${label}</div>
    <div class="v"><span data-count="${n}" data-fmt="${fmt}" data-key="cx-${key}">0</span></div><div class="d">${sub}</div></div>`;
  return `<section class="strip cx-strip">
    ${cell('ok', usable ? 'var(--ok)' : 'var(--err)', 'checkCircle', '可用线路', usable, 'int', `共 ${list.length} 个启用`)}
    ${cell('req', 'var(--sig)', 'activity', '24H 请求', req, 'int', '账号与中转站合计')}
    ${cell('tok', 'var(--info)', 'package', 'TOKENS', tok, 'k', '输入 + 输出')}
    ${cell('sw', 'var(--warn)', 'shuffle', '切换', switches, 'int', '最近 30 条请求中')}
  </section>`;
}

export async function render(el, { quiet = false } = {}) {
  // Don't rebuild under an open dialog (rename/import) on live refreshes.
  if (quiet && document.querySelector('dialog[open]')) return;
  try {
    cx = store.codex = await api('codex/status');
    if (store.status) {
      store.status.codex = {
        accounts: cx.accounts.length,
        available: cx.accounts.filter((a) => a.enabled && a.status === 'ok').length,
      };
      window.dispatchEvent(new Event('smart-router:codex-status-updated'));
    }
  } catch (e) {
    const stale = /not found|HTTP 404/i.test(e.message);
    el.innerHTML = `${pageHead('codex')}<div class="notice err">${icon('alert')}${stale
      ? '正在运行的路由还是旧版本，没有 Codex 功能。重启路由（stop.bat 后再 start-hidden.vbs）即可。'
      : '读取 Codex 账号失败：' + esc(e.message)}</div>`;
    return;
  }
  el.classList.toggle('quiet', quiet);
  const official = cx.accounts.some((a) => !isRelay(a));
  const acts = `${official ? `<button class="btn" data-act="usage-all" title="已启用账号每 5 分钟自动刷新额度；需要重新登录的账号除外">${icon('gauge')}刷新额度 · 每5分钟自动</button>` : ''}
    <button class="btn" data-act="add-relay">${icon('plus')}添加中转站</button>
    <button class="btn primary" data-act="import">${icon('download')}从 CC Switch 导入</button>`;
  if (!cx.accounts.length) {
    el.innerHTML = `${pageHead('codex', acts)}
      <section class="card hud" data-rv>${empty('还没有账号或中转站。<br>官方账号：先在 Codex 里登录，再从 CC Switch 导入；中转站：从 CC Switch 导入或手动添加。', 'key')}
        <div class="row" style="justify-content:center;margin-bottom:24px;gap:10px"><button class="btn" data-act="add-relay">${icon('plus')}添加中转站</button><button class="btn primary" data-act="import">${icon('download')}从 CC Switch 导入</button></div></section>
      <section class="card" style="margin-top:16px" data-rv><div class="keybar"><span class="ic">${icon('book')}</span>
        <span class="grow small muted">导入后，按「接入指南」把 Codex 指向路由即可。</span><a class="btn sm" href="#codex-guide">${icon('arrow')}接入指南</a></div></section>`;
  } else {
    el.innerHTML = `${pageHead('codex', acts)}
      ${notices()}
      ${hero()}
      <section class="card hud" data-rv>
        <div class="card-title"><h3>使用顺序</h3><span class="faint small">账号和中转站从上到下依次使用，用箭头调整</span></div>
        <div class="cx-list">${cx.accounts.map((a, i) => accountCard(a, i, cx.accounts.length)).join('')}</div>
      </section>
      ${strip()}
      ${recentCard()}`;
  }
  reveal(el);
  countUp(el);
  el.onclick = (e) => onClick(e, el);
}

async function onClick(e, el) {
  const c = e.target.closest('[data-copy]');
  if (c) return copy(c.dataset.copy, c);
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const id = b.dataset.id;
  const act = b.dataset.act;
  const a = cx.accounts.find((x) => x.id === id);
  b.closest('details.menu')?.removeAttribute('open');
  if (act === 'import') return openImport(el);
  if (act === 'rename') return openRename(a, el);
  if (act === 'edit') return openRelay(el, a);
  if (act === 'add-relay') return openRelay(el);
  await busy(b, async () => {
    if (act === 'auto') await api('codex/settings', { method: 'PUT', body: { mode: 'auto' } });
    else if (act === 'pin' || act === 'pin-cur') {
      const pid = act === 'pin' ? id : cx.activeAccountId;
      if (!pid) return toast('没有可锁定的线路', 'warn');
      await api('codex/settings', { method: 'PUT', body: { mode: 'pinned', pinnedAccountId: pid } });
    } else if (act === 'up' || act === 'down') {
      const ids = cx.accounts.map((x) => x.id);
      const i = ids.indexOf(id);
      const j = act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await api('codex/order', { method: 'PUT', body: { ids } });
    } else if (act === 'usage') {
      const r = await api(`codex/accounts/${encodeURIComponent(id)}/usage`, { method: 'POST' });
      toast(r && r.usage ? `已更新「${esc(a.name)}」的额度` : '没有拿到额度数据，下次请求后会自动更新', r && r.usage ? 'success' : 'warn');
    } else if (act === 'usage-all') {
      const list = cx.accounts.filter((x) => !isRelay(x) && x.enabled && x.status !== 'auth');
      const res = await Promise.allSettled(list.map((x) => api(`codex/accounts/${encodeURIComponent(x.id)}/usage`, { method: 'POST' })));
      const bad = res.filter((r) => r.status === 'rejected').length;
      toast(bad ? `${list.length - bad} 个已更新，${bad} 个失败` : `已更新 ${list.length} 个账号的额度`, bad ? 'warn' : 'success');
    } else if (act === 'test') {
      const t = await api(`codex/accounts/${encodeURIComponent(id)}/test`, { method: 'POST' });
      toast(t.ok ? `「${esc(a.name)}」连接正常 · ${fmtMs(t.ms)}${t.models && t.models.length ? ` · ${t.models.length} 个模型` : ''}`
        : `「${esc(a.name)}」连接失败：${esc(t.error || 'HTTP ' + t.status)}`, t.ok ? 'success' : 'error', t.ok ? 4000 : 8000);
    } else if (act === 'sync-toggle') {
      if (a.sync && !(await ask(`关闭「${a.name}」的凭据同步？之后路由和 CC Switch 会各自刷新令牌，一边刷新后另一边可能需要重新登录。`, { ok: '关闭同步' }))) return;
      const r = await api(`codex/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: { sync: !a.sync } });
      toast(r.sync ? (r.syncState && r.syncState.lastError ? '已开启，但这次同步失败：' + esc(r.syncState.lastError) : '已开启凭据同步，两边始终用最新的登录凭据') : '已关闭凭据同步', r.sync && r.syncState && r.syncState.lastError ? 'warn' : 'success');
    } else if (act === 'sync-now') {
      const r = await api(`codex/accounts/${encodeURIComponent(id)}/sync`, { method: 'POST' });
      toast(r.syncState && r.syncState.lastError ? '同步失败：' + esc(r.syncState.lastError) : '凭据已同步', r.syncState && r.syncState.lastError ? 'warn' : 'success');
    } else if (act === 'reset') await api(`codex/accounts/${encodeURIComponent(id)}/reset`, { method: 'POST' });
    else if (act === 'toggle') await api(`codex/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: { enabled: !a.enabled } });
    else if (act === 'delete') {
      if (!(await ask(`从路由移除「${a.name}」？不会影响 CC Switch 里的配置${a.ccSwitchId || !isRelay(a) ? '，之后可以重新导入' : ''}。`, { ok: '移除', danger: true }))) return;
      await api(`codex/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await closeModalAndWait();
    }
    await render(el, { quiet: true });
  });
}

function openRename(a, el) {
  const body = modal('重命名账号', `<form id="cx-rn"><label class="f"><span class="small muted">名称</span><input name="name" value="${esc(a.name)}" maxlength="60" required /></label>
    <div class="row" style="justify-content:flex-end;margin-top:18px"><button class="btn ghost" type="button" data-close>取消</button><button class="btn primary" type="submit">保存</button></div></form>`);
  const f = body.querySelector('form');
  f.querySelector('input').select();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const name = f.name.value.trim();
    if (!name) return;
    await busy(f.querySelector('[type=submit]'), async () => {
      await api(`codex/accounts/${encodeURIComponent(a.id)}`, { method: 'PATCH', body: { name } });
      await closeModalAndWait();
      await render(el, { quiet: true });
    });
  };
}

function openRelay(el, a) {
  const edit = !!a;
  const body = modal(edit ? `编辑中转站 · ${esc(a.name)}` : '添加 Codex 中转站', `<form id="cx-rl" class="cx-form" autocomplete="off">
    <label class="f"><span class="small muted">名称</span><input name="name" value="${esc(a ? a.name : '')}" maxlength="60" required placeholder="例如 AIGateHub" /></label>
    <label class="f"><span class="small muted">接口地址 <span class="faint">base_url，需支持 Responses 接口</span></span>
      <input name="baseUrl" type="url" value="${esc(a ? a.baseUrl : '')}" required placeholder="https://example.com/v1" spellcheck="false" /></label>
    <label class="f"><span class="small muted">密钥${edit ? ' <span class="faint">留空则保持不变</span>' : ''}</span>
      <input name="apiKey" type="password" ${edit ? `placeholder="${esc(a.keyHint || '••••')}"` : 'required placeholder="sk-…"'} spellcheck="false" /></label>
    <label class="f"><span class="small muted">模型 <span class="faint">可选；填了就用它替换 Codex 请求里的模型</span></span>
      <input name="model" value="${esc(a && a.model ? a.model : '')}" placeholder="留空：跟随 Codex 的设置" spellcheck="false" /></label>
    <div class="row" style="margin-top:18px"><span class="grow"></span>
      <button class="btn ghost" type="button" data-close>取消</button><button class="btn primary" type="submit">${edit ? '保存' : '添加到末尾'}</button></div></form>`);
  const f = body.querySelector('form');
  f.name.focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = { name: f.name.value.trim(), baseUrl: f.baseUrl.value.trim(), model: f.model.value.trim() };
    const key = f.apiKey.value.trim();
    if (key || !edit) v.apiKey = key;
    await busy(f.querySelector('[type=submit]'), async () => {
      if (edit) await api(`codex/accounts/${encodeURIComponent(a.id)}`, { method: 'PATCH', body: v });
      else await api('codex/relays', { method: 'POST', body: v });
      toast(edit ? '已保存' : `已添加「${esc(v.name)}」，排在最后`, 'success');
      await closeModalAndWait();
      await render(el, { quiet: true });
    });
  };
}

async function openImport(el) {
  let list;
  try {
    list = await api('codex/ccswitch');
  } catch (e) {
    return toast('读取 CC Switch 失败：' + esc(e.message), 'error');
  }
  if (!list.length) return toast('CC Switch 里没有找到 Codex 的账号或中转站', 'warn', 7000);
  const accounts = list.filter((c) => c.type !== 'relay');
  const relays = list.filter((c) => c.type === 'relay');
  const opt = (c, sub) => {
    const no = c.importable === false;
    return `<label class="cx-opt ${no ? 'no' : ''}">
      <input type="checkbox" value="${esc(c.id)}" ${c.imported && !no ? 'checked' : ''} ${no ? 'disabled' : ''} />
      <span class="cx-opt-b"><b>${esc(c.name)}</b>${c.isCurrent ? ' <span class="tag">CC Switch 当前</span>' : ''}${c.imported ? ` <span class="tag">已导入 · ${c.type === 'relay' ? '更新配置' : '更新令牌'}</span>` : ''}
        <span class="faint small mono">${no ? `<span style="color:var(--warn)">${esc(c.reason || '无法导入')}</span>` : sub}</span></span></label>`;
  };
  const group = (title, items, sub) => items.length ? `<div class="cx-grp"><div class="subhead">${title}<span class="faint small">${items.length}</span></div>
    <div class="cx-pick">${items.map((c) => opt(c, sub(c))).join('')}</div></div>` : '';
  const body = modal('从 CC Switch 导入', `
    <p class="muted small" style="margin:0 0 6px">勾选的项目按顺序加到使用顺序的末尾，导入后可以随时调整。</p>
    ${group('官方账号', accounts, (c) => `${esc(c.email || '')}${c.planType ? ` · ${esc(PLAN[String(c.planType).toLowerCase()] || c.planType)}` : ''} · ${esc(c.accountIdMasked || '')}`)}
    ${group('中转站', relays, (c) => `${esc(host(c.baseUrl))}${c.model ? ` · ${esc(c.model)}` : ''} · ${esc(c.keyHint || '')}`)}
    <div class="row" style="margin-top:16px"><span class="muted small grow">只读取，不会修改 CC Switch 里的中转站</span><button class="btn primary" id="cx-do-imp">导入所选</button></div>`);
  body.querySelector('#cx-do-imp').onclick = async (e) => {
    const ids = [...body.querySelectorAll('input[type=checkbox]:checked')].map((x) => x.value);
    if (!ids.length) return toast('还没勾选任何项目', 'warn');
    await busy(e.target, async () => {
      const r = await api('codex/import', { method: 'POST', body: { ids } });
      toast(`新增 ${r.added || 0} 个，更新 ${r.updated || 0} 个`, 'success');
      await closeModalAndWait();
      await render(el, { quiet: true });
    });
  };
}
