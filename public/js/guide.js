import { store, esc, api, refreshStatus, copy, busy, toast, ask, pageHead } from './core.js';
import { reveal } from './fx.js';
import { icon } from './icons.js';

export function render(el) {
  const st = store.status;
  const s = st.settings;
  const field = (label, v) => `<div class="small muted" style="margin-top:10px">${label}</div><div class="copy"><code>${esc(v)}</code><button class="btn sm" data-copy="${esc(v)}">${icon('copy')}复制</button></div>`;
  el.innerHTML = `
    ${pageHead('guide')}
    <div class="cols2">
      <section class="card hud" data-rv>
        <div class="card-title"><h3>三步接入</h3></div>
        <ol class="steps">
          <li><b>在 CC Switch 添加供应商</b><span class="muted small">Claude → 添加 → 自定义，名称随意</span>
            ${field('请求地址', st.baseUrl)}${field('API Key', s.routerKey)}</li>
          <li><b>模型都留空</b><span class="muted small">某条线路没有的模型会自动走其他线路</span></li>
          <li style="padding-bottom:0"><b>切换过去，重开 Claude Code</b><span class="muted small">在「请求记录」能看到每个请求走了哪条线路</span></li>
        </ol>
      </section>
      <section class="card hud" data-rv>
        <div class="card-title"><h3>常驻运行</h3></div>
        <ul class="rules">
          <li><code>start.bat</code>：前台运行，关窗口即停止</li>
          <li><code>start-hidden.vbs</code>：后台运行，放进 <code>shell:startup</code> 可开机自启</li>
          <li><code>stop.bat</code>：停止后台运行</li>
        </ul>
        <div class="card-title" style="margin-top:20px"><h3>规则速览</h3></div>
        <ul class="rules">
          <li>优先级：${st.providers.map((p) => esc(p.name)).join(' › ')}</li>
          <li>出错当场换线路重发；额度、令牌问题立即下线，其他错误连续 ${s.failureThreshold} 次下线</li>
          <li>下线的线路每 ${s.probeIntervalMin} 分钟探测，恢复后自动切回</li>
          <li>上下文超限：被拒后换线路，开启压缩的线路之后继续用</li>
        </ul>
      </section>
    </div>
    <section class="card" style="margin-top:16px" data-rv>
      <div class="keybar"><span class="ic">${icon('key')}</span><span class="grow small muted">只监听本机 ${esc(s.host)}，所有请求都要带路由密钥，防止其他程序盗用额度。${s.requireKey ? '' : '<b style="color:var(--err)">当前已关闭密钥校验</b>'}</span>
      <button class="btn sm danger" id="regen">重新生成密钥</button></div>
    </section>`;
  el.onclick = async (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) copy(c.dataset.copy, c);
    if (e.target.closest('#regen')) {
      if (!(await ask('旧密钥会立即失效，需要同步更新 CC Switch。确定吗？', { ok: '重新生成', danger: true }))) return;
      await busy(e.target.closest('#regen'), async () => {
        await api('regenerate-key', { method: 'POST' });
        await refreshStatus();
        render(el);
        reveal(el);
        toast('已生成新密钥，记得更新 CC Switch', 'warn', 8000);
      });
    }
  };
}
