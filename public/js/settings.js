import { store, esc, api, refreshStatus, toast, busy, pageHead } from './core.js';
import { icon } from './icons.js';

const num = (name, label, v, { hint = '', step = 1, unit = '' } = {}) =>
  `<div class="f"><label for="s-${name}">${label}${unit ? `<span class="faint">（${unit}）</span>` : ''}</label><input id="s-${name}" name="${name}" type="number" step="${step}" min="0" value="${v}" />${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
const sw = (name, label, v) => `<label class="switch f wide"><input type="checkbox" name="${name}" ${v ? 'checked' : ''} />${label}</label>`;

const PATTERNS = {
  context: '上下文超限 → 换线路或压缩', quota: '额度不足 → 立即下线', auth: '令牌无效 → 立即下线',
  model: '没有该模型 → 仅该模型换线路', rateLimit: '限流 → 短暂冷却', overloaded: '过载 → 计入失败次数',
};

export function render(el) {
  const s = store.status.settings;
  const c = s.compaction;
  el.innerHTML = `
    ${pageHead('settings')}
    <form id="set-form">
      <div class="cols2">
        <section class="card hud mod" data-rv><div class="card-title"><span class="no">M-01</span><h3>故障切换</h3></div><div class="fields">
          ${num('failureThreshold', '连续失败几次后下线', s.failureThreshold, { hint: '额度不足、令牌无效会立即下线' })}
          ${num('probeIntervalMin', '下线后探测间隔', s.probeIntervalMin, { unit: '分钟' })}
          ${num('cooldownSec', '限流冷却', s.cooldownSec, { unit: '秒' })}
          ${num('sameProviderRetry', '同线路快速重试', s.sameProviderRetry, { unit: '次' })}
          ${num('cacheTtlSec', '会话缓存有效期', s.cacheTtlSec, { unit: '秒', hint: '按线路、会话和发送版本记忆最近成功时间' })}
          ${num('f.minTokens', '缓存保护起点', s.costAwareFailover.minTokens, { unit: 'tokens', hint: '大请求切到冷缓存前，临时故障优先原线路重试' })}
          ${num('f.extraRetries', '缓存保护额外重试', s.costAwareFailover.extraRetries, { unit: '次', hint: '0 关闭；退避 1.5 秒、4 秒；不占普通最多尝试次数' })}
          ${sw('sizeFailover', '超限时允许切换到更贵的线路', s.sizeFailover)}
          <span class="hint">关闭时留在原线路；图片超限先优化图片，文本超限交给 Claude Code 压缩会话</span>
        </div></section>
        <section class="card hud mod" data-rv><div class="card-title"><span class="no">M-02</span><h3>会话压缩</h3></div><div class="fields">
          ${sw('c.enabled', '开启会话压缩', c.enabled)}
          ${sw('i.enabled', '图片超限时自动优化，保留全部图片', s.imageCompression?.enabled !== false)}
          ${num('i.minLongestEdge', '自动缩图的长边下限', s.imageCompression?.minLongestEdge || 1024, { unit: '像素', hint: '1024–4096；小图不放大。先无损优化，再逐级调整清晰度，近期图片优先保真；原文件不变' })}
          <span class="hint">达到清晰度底线仍超限时提示分批检查，不通过删除图片续跑；可关闭图片优化以坚持原图传输</span>
          ${sw('c.compactOnFailover', '切换线路时沿用已有摘要', c.compactOnFailover)}
          <span class="hint">可用于未开启压缩的目标线路以减少缓存写入；客户端 /compact 始终优先完整历史</span>
          ${sw('c.reportFullUsage', '让 Claude Code 照常自动压缩', c.reportFullUsage)}
          <span class="hint">路由压缩后仍按完整历史报告用量，原生压缩到点就会触发</span>
          ${sw('c.preemptive', '接近上限时提前准备摘要', c.preemptive)}
          ${num('c.keepRatio', '保留原文比例', c.keepRatio, { step: 0.05, hint: '越大越保真，但更频繁地重新压缩' })}
          <div class="f"><label for="s-c.summarizerProviderId">由谁生成摘要</label>
            <select id="s-c.summarizerProviderId" name="c.summarizerProviderId"><option value="">自动</option>
            ${store.status.providers.map((p) => `<option value="${p.id}" ${c.summarizerProviderId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
        </div></section>
      </div>
      <details class="card hud fold mod" style="margin-top:16px" data-rv><summary>${icon('chev', 'chev')}<span class="no" style="font:700 13px var(--mono);color:var(--sig);letter-spacing:.1em">M-03</span>高级设置</summary><div class="fold-body">
        <div class="fields">
          ${num('maxAttempts', '单个请求最多尝试', s.maxAttempts, { unit: '次' })}
          ${num('modelUnavailableTtlMin', '"无此模型"记忆时长', s.modelUnavailableTtlMin, { unit: '分钟' })}
          ${num('firstByteTimeoutSec', '首个响应超时', s.firstByteTimeoutSec, { unit: '秒', hint: '这之前出错都能无缝切换' })}
          ${num('idleTimeoutSec', '输出中途空闲超时', s.idleTimeoutSec, { unit: '秒' })}
          ${num('nonStreamTimeoutSec', '非流式超时', s.nonStreamTimeoutSec, { unit: '秒' })}
          ${num('learnedLimitTtlHours', '学到的上限有效期', s.learnedLimitTtlHours, { unit: '小时' })}
          ${num('c.summaryMaxTokens', '摘要最大长度', c.summaryMaxTokens, { step: 500, unit: 'tokens' })}
          <div class="f"><label for="s-c.summarizerModel">摘要用模型</label><input id="s-c.summarizerModel" name="c.summarizerModel" placeholder="同请求" value="${esc(c.summarizerModel)}" /></div>
          ${num('logRetentionDays', '日志保留', s.logRetentionDays, { unit: '天' })}
          ${sw('saveErrorBodies', '保存原始错误响应', s.saveErrorBodies)}
          ${sw('requireKey', '校验路由密钥（建议开启）', s.requireKey)}
        </div>
        <div class="subhead">错误识别关键词</div>
        <p class="hint" style="margin:0 0 12px">每行一个，不区分大小写。遇到没识别出来的报错，把它的关键字加进来。</p>
        <div class="fields">${Object.entries(PATTERNS).map(([k, label]) => `<div class="f"><label for="p-${k}">${label}</label><textarea id="p-${k}" name="p.${k}" rows="6">${esc((s.patterns[k] || []).join('\n'))}</textarea></div>`).join('')}</div>
      </div></details>
      <div class="savebar" id="savebar"><button class="btn primary" type="submit">保存</button><span class="muted small" id="save-hint">保存后立即生效</span></div>
    </form>`;
  const form = el.querySelector('#set-form');
  const bar = el.querySelector('#savebar');
  const hint = el.querySelector('#save-hint');
  form.oninput = () => {
    bar.classList.add('dirty');
    hint.textContent = '有未保存的修改';
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const patch = { compaction: {}, costAwareFailover: {}, imageCompression: {}, patterns: {} };
    for (const inp of e.target.querySelectorAll('[name]')) {
      const v = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Number(inp.value) : inp.value;
      if (inp.name.startsWith('c.')) patch.compaction[inp.name.slice(2)] = v;
      else if (inp.name.startsWith('i.')) patch.imageCompression[inp.name.slice(2)] = v;
      else if (inp.name.startsWith('f.')) patch.costAwareFailover[inp.name.slice(2)] = v;
      else if (inp.name.startsWith('p.')) patch.patterns[inp.name.slice(2)] = String(v).split('\n').map((x) => x.trim()).filter(Boolean);
      else patch[inp.name] = v;
    }
    await busy(e.submitter, async () => {
      await api('settings', { method: 'POST', body: patch });
      await refreshStatus();
      bar.classList.remove('dirty');
      hint.textContent = '已保存，立即生效';
      toast('已保存', 'success');
    });
  };
}
