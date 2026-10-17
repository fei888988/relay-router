import { store, esc, api, fmtK, fmtAgo, pname, pill, modal, busy, toast, empty, ask, pageHead } from './core.js';
import { icon } from './icons.js';

const STATUS = { ready: ['ok', '可用'], running: ['info', '压缩中'], stale: ['warn', '待更新'], failed: ['err', '失败'], idle: ['', '未压缩'] };

export async function render(el) {
  const cs = store.status.settings.compaction;
  const targets = store.status.providers.filter((p) => p.allowCompaction).map((p) => esc(p.name)).join('、');
  el.innerHTML = `
    ${pageHead('sessions', pill(cs.enabled ? 'ok' : '', cs.enabled ? '已开启' : '已关闭'))}
    <section class="card hud" data-rv>
      <div class="explain"><span class="glyph">${icon('layers')}</span>
      <p>长对话被 <b>${targets || '（没有线路开启）'}</b> 拒绝后，会在后台把早期消息总结成摘要，之后继续用这条线路。本地会话不受影响。</p></div>
      <details class="fold" style="margin-top:10px"><summary>${icon('chev', 'chev')}具体怎么做的</summary><div class="fold-body small muted">
        <p style="margin:0 0 6px">被拒绝的那次请求会立刻改走下一条线路，不用等待；摘要生成好以后，后续请求发「摘要 + 最近的消息原文」。</p>
        <p style="margin:0 0 6px">上下文接近已知上限的 ${Math.round(cs.triggerRatio * 100)}% 时会提前开始准备，大多数时候感觉不到。</p>
        <p style="margin:0">在 Claude Code 里执行 /compact 之后历史会变，旧摘要会自动作废。</p>
      </div></details>
    </section>
    <div class="tablebox" style="margin-top:16px" data-rv><table>
      <thead><tr><th>会话</th><th>状态</th><th>压缩效果</th><th>已摘要</th><th>使用</th><th>最近</th><th></th></tr></thead>
      <tbody id="s-body" class="stagger"><tr><td colspan="7"><div class="skel" style="width:60%"></div></td></tr></tbody>
    </table></div>`;
  el.querySelector('#s-body').onclick = (e) => act(e, el);
  await load(el);
}

async function load(el) {
  const list = await api('sessions');
  const tb = el.querySelector('#s-body');
  if (!tb) return;
  if (!list.length) return (tb.innerHTML = `<tr><td colspan="7">${empty('还没有被压缩过的会话', 'package')}</td></tr>`);
  tb.innerHTML = list.map((s, i) => {
    const [cls, txt] = s.running ? STATUS.running : STATUS[s.status] || STATUS.idle;
    const saved = s.lastFullEst && s.lastSentEst ? Math.round((1 - s.lastSentEst / s.lastFullEst) * 100) : null;
    return `<tr style="--i:${Math.min(i, 24)}">
      <td><span class="mono small">${esc(s.key.slice(0, 8))}</span><div class="faint small">${esc(pname(s.providerId))}</div></td>
      <td>${pill(cls, txt)}${s.lastError ? `<div class="small" style="color:var(--err);margin-top:4px">${esc(s.lastError.slice(0, 80))}</div>` : ''}</td>
      <td class="small">${s.lastFullEst ? `<div class="ratio"><span class="track"><i style="--w:${Math.max(3, Math.min(100, 100 - (saved || 0)))}%"></i></span><span class="txt">${fmtK(s.lastFullEst)} → <b>${fmtK(s.lastSentEst)}</b>${saved > 0 ? ` <span class="faint">−${saved}%</span>` : ''}</span></div>` : '-'}</td>
      <td class="small">${s.coveredCount ? `前 ${s.coveredCount} 条` : '-'}</td>
      <td class="small">${s.uses || 0} 次</td>
      <td class="small faint">${fmtAgo(s.lastUsedAt)}</td>
      <td><div class="row" style="justify-content:flex-end">
        ${s.summaryPreview ? `<button class="btn sm" data-view="${s.key}">看摘要</button>` : ''}
        <button class="btn sm ghost icon" data-reset="${s.key}" aria-label="丢弃摘要" title="丢弃摘要">${icon('trash')}</button></div></td>
    </tr>`;
  }).join('');
}

async function act(e, el) {
  const v = e.target.closest('[data-view]');
  const r = e.target.closest('[data-reset]');
  if (v) {
    const s = await api('sessions/' + v.dataset.view);
    modal('会话摘要', `<p class="muted small" style="margin:0 0 10px">覆盖前 ${s.coveredCount} 条消息 · ${esc(s.summarizer || '-')} 生成 · 第 ${s.builds} 版</p><pre style="font-family:inherit;font-size:13px;line-height:1.7">${esc(s.summary)}</pre>`);
  }
  if (r) {
    if (!(await ask('丢弃后，需要时会重新生成。确定吗？', { ok: '丢弃摘要', danger: true }))) return;
    await busy(r, async () => {
      await api(`sessions/${r.dataset.reset}/reset`, { method: 'POST' });
      toast('已丢弃', 'success');
      await load(el);
    });
  }
}
