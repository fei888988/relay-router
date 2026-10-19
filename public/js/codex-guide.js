// Codex handbook: how to point Codex at the router, and how account switching behaves.
import { store, esc, copy, pageHead } from './core.js';
import { icon } from './icons.js';

export function render(el) {
  const st = store.status;
  const endpoint = `${st.baseUrl}/codex/v1`;
  const key = st.settings.routerKey;
  const toml = `model_provider = "smartrouter"

[model_providers.smartrouter]
name = "智能路由"
base_url = "${endpoint}"
wire_api = "responses"
experimental_bearer_token = "${key}"`;
  const names = ((store.codex && store.codex.accounts) || []).filter((a) => a.enabled).map((a) => esc(a.name));
  el.innerHTML = `
    ${pageHead('codex-guide')}
    <div class="cols2">
      <section class="card hud" data-rv>
        <div class="card-title"><h3>三步接入</h3></div>
        <ol class="steps cx-steps">
          <li><b>在「账号」页导入官方账号</b><span class="muted small">先在 Codex 里用 ChatGPT 登录这些号，CC Switch 会记下它们</span></li>
          <li><b>CC Switch → Codex → 添加自定义供应商</b><span class="muted small">把下面的配置合并进 config.toml，<code>model_provider</code> 这一行要放在最上面</span>
            <div class="cx-code"><pre>${esc(toml)}</pre><button class="btn sm" data-copy="${esc(toml)}">${icon('copy')}复制</button></div></li>
          <li style="padding-bottom:0"><b>切换到这个供应商，重开 Codex</b><span class="muted small">Codex 端不需要登录，账号由路由轮换；在「请求记录」能看到每次用的是哪个号</span></li>
        </ol>
      </section>
      <section class="card hud" data-rv>
        <div class="card-title"><h3>规则速览</h3></div>
        <ul class="rules">
          <li>优先级：${names.length ? names.join(' › ') : '还没有账号'}</li>
          <li>当前账号额度用完，同一个请求立即换下一个号重发，Codex 那边无感</li>
          <li>用完的号到重置时间自动恢复，路由切回排在前面的号</li>
          <li>锁定某个号后只用它；它额度用完时仍会临时借用下一个号，避免中断</li>
          <li>登录失效的号会被跳过，重新登录后再导入一次即可</li>
        </ul>
        <div class="small muted" style="margin-top:16px">接入地址</div>
        <div class="copy"><code>${esc(endpoint)}</code><button class="btn sm" data-copy="${esc(endpoint)}">${icon('copy')}复制</button></div>
      </section>
    </div>`;
  el.onclick = (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) copy(c.dataset.copy, c);
  };
}
