// Provider edit form markup + parsing.
import { esc } from './core.js';
import { icon } from './icons.js';

const AUTH = { bearer: 'Bearer（默认）', 'x-api-key': 'x-api-key', both: '两者都发' };

export function providerForm(p) {
  const isNew = !p;
  p = p || { name: '', baseUrl: '', authHeader: 'bearer', enabled: true, contextLimit: 0, allowCompaction: false, modelMap: {}, extraHeaders: {}, probeModel: '', note: '' };
  const fid = isNew ? 'new' : p.id;
  const mapText = Object.entries(p.modelMap || {}).map(([k, v]) => `${k} = ${v}`).join('\n');
  const hdrText = Object.entries(p.extraHeaders || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  const id = (x) => `${x}-${fid}`;
  return `<form data-form="${fid}" autocomplete="off">
    <div class="fields">
      <div class="f"><label for="${id('n')}">名称</label><input id="${id('n')}" name="name" required value="${esc(p.name)}" /></div>
      <div class="f"><label for="${id('u')}">地址</label><input id="${id('u')}" name="baseUrl" required placeholder="https://…" value="${esc(p.baseUrl)}" /></div>
      <div class="f"><label for="${id('k')}">令牌</label>
        <input id="${id('k')}" name="apiKey" type="password" placeholder="${isNew ? 'sk-…' : p.hasKey ? `${esc(p.apiKeyMasked)}（留空不改）` : '尚未填写'}" /></div>
      <div class="f"><label for="${id('c')}">上下文上限</label>
        <input id="${id('c')}" name="contextLimit" type="number" min="0" step="1000" value="${p.contextLimit || 0}" />
        <span class="hint">估算 tokens 提示，0 表示未知；更大的成功请求会覆盖旧提示。413 单独学习字节上限</span></div>
      <label class="switch f wide"><input type="checkbox" name="enabled" ${p.enabled ? 'checked' : ''} />启用这条线路</label>
      <label class="switch f wide"><input type="checkbox" name="allowCompaction" ${p.allowCompaction ? 'checked' : ''} />上下文超限时，压缩会话后继续使用它</label>
    </div>
    <details class="fold" style="margin-top:16px"><summary>${icon('chev', 'chev')}高级选项</summary><div class="fold-body fields">
      <div class="f"><label for="${id('a')}">鉴权方式</label><select id="${id('a')}" name="authHeader">${Object.entries(AUTH).map(([k, v]) => `<option value="${k}" ${p.authHeader === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="f"><label for="${id('pm')}">探测用模型</label><input id="${id('pm')}" name="probeModel" placeholder="自动" value="${esc(p.probeModel)}" /></div>
      <div class="f"><label for="${id('mm')}">模型映射</label><textarea id="${id('mm')}" name="modelMap" placeholder="claude-haiku-* = claude-sonnet-5">${esc(mapText)}</textarea>
        <span class="hint">不填时，没有的模型会自动走其他线路</span></div>
      <div class="f"><label for="${id('eh')}">附加请求头</label><textarea id="${id('eh')}" name="extraHeaders" placeholder="名称: 值">${esc(hdrText)}</textarea></div>
      <div class="f wide"><label for="${id('nt')}">备注</label><input id="${id('nt')}" name="note" value="${esc(p.note)}" /></div>
    </div></details>
    <div class="row" style="margin-top:18px">
      <button class="btn primary" type="submit">${isNew ? '添加' : '保存'}</button>
      ${isNew ? '' : `<span class="grow"></span><button type="button" class="btn ghost danger" data-del="${p.id}">${icon('trash')}删除</button>`}
    </div>
  </form>`;
}

function parseLines(text, sep) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf(sep);
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

export function readForm(f) {
  const fd = new FormData(f);
  const body = {
    name: fd.get('name').trim(),
    baseUrl: fd.get('baseUrl').trim(),
    authHeader: fd.get('authHeader'),
    contextLimit: Number(fd.get('contextLimit')) || 0,
    probeModel: fd.get('probeModel').trim(),
    enabled: fd.get('enabled') === 'on',
    allowCompaction: fd.get('allowCompaction') === 'on',
    modelMap: parseLines(fd.get('modelMap'), '='),
    extraHeaders: parseLines(fd.get('extraHeaders'), ':'),
    note: fd.get('note').trim(),
  };
  const key = fd.get('apiKey').trim();
  if (key) body.apiKey = key;
  return body;
}
