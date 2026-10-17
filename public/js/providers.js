import { store, esc, api, refreshStatus, toast, busy, modal, closeModal, providerStatus, pill, ask, pageHead } from './core.js';
import { reveal } from './fx.js';
import { icon } from './icons.js';
import { providerForm, readForm } from './pform.js';

let openId = null;

export function render(el) {
  const st = store.status;
  el.innerHTML = `
    ${pageHead('providers', `<button class="btn" id="imp" ${st.ccSwitchDb ? '' : 'disabled title="没找到 CC Switch"'}>${icon('download')}从 CC Switch 导入</button>
      <button class="btn primary" id="add">${icon('plus')}添加</button>`)}
    <p class="muted small" style="margin:0 0 18px" data-rv>从上到下就是优先级，在概览页可以调整顺序。</p>
    ${st.providers.map((p, i) => {
      const ps = providerStatus(p);
      return `<details class="card pedit" data-id="${p.id}" ${openId === p.id ? 'open' : ''} data-rv>
        <summary><span class="rank">${String(i + 1).padStart(2, '0')}</span><span class="pname">${esc(p.name)}</span>
          <span class="faint small mono grow">${esc(p.baseUrl.replace(/^https?:\/\//, ''))}</span>${pill(ps.cls, ps.text)}<span class="chev">${icon('chev')}</span></summary>
        ${providerForm(p)}
      </details>`;
    }).join('')}
    <details class="card pedit" id="new-box" ${openId === 'new' ? 'open' : ''} data-rv>
      <summary><span class="rank">${icon('plus')}</span><span class="pname grow">新线路</span><span class="chev">${icon('chev')}</span></summary>
      ${providerForm(null)}
    </details>`;
  reveal(el);
  el.addEventListener('toggle', (e) => {
    if (e.target.matches('details.pedit') && e.target.open) openId = e.target.dataset.id || 'new';
  }, true);
  el.onsubmit = (e) => save(e, el);
  el.onclick = (e) => click(e, el);
}

async function save(e, el) {
  e.preventDefault();
  const f = e.target.closest('form[data-form]');
  const id = f.dataset.form;
  await busy(f.querySelector('[type=submit]'), async () => {
    if (id === 'new') await api('providers', { method: 'POST', body: readForm(f) });
    else await api('providers/' + id, { method: 'PUT', body: readForm(f) });
    toast(id === 'new' ? '已添加' : '已保存', 'success');
    openId = id === 'new' ? null : id;
    await refreshStatus();
    render(el);
  });
}

async function click(e, el) {
  const del = e.target.closest('[data-del]');
  if (del) {
    const p = store.status.providers.find((x) => x.id === del.dataset.del);
    if (!(await ask(`删除「${p.name}」？此操作不可撤销。`, { ok: '删除', danger: true }))) return;
    await busy(del, async () => {
      await api('providers/' + p.id, { method: 'DELETE' });
      await refreshStatus();
      render(el);
    });
  }
  if (e.target.closest('#add')) {
    const box = el.querySelector('#new-box');
    box.open = true;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    box.querySelector('input').focus();
  }
  if (e.target.closest('#imp')) openImport(el);
}

async function openImport(el) {
  const list = await api('ccswitch');
  const opts = store.status.providers.map((p) => `<option value="${p.id}">更新「${esc(p.name)}」的令牌</option>`).join('');
  const body = modal('从 CC Switch 导入', `
    <div class="tablebox"><table><thead><tr><th>名称</th><th>地址</th><th>导入为</th></tr></thead><tbody>
    ${list.map((c) => `<tr>
      <td>${esc(c.name)} ${c.isCurrent ? '<span class="tag">当前</span>' : ''}${c.imported ? '<span class="tag">已导入</span>' : ''}<div class="faint small mono">${esc(c.apiKeyMasked)}</div></td>
      <td class="small mono faint">${esc(c.baseUrl.replace(/^https?:\/\//, ''))}</td>
      <td><select data-cc="${c.id}"><option value="">—</option><option value="__new">新线路</option>${opts}</select></td></tr>`).join('')}
    </tbody></table></div>
    <div class="row" style="margin-top:16px"><span class="muted small grow">只读取，不会修改 CC Switch</span><button class="btn primary" id="do-imp">导入</button></div>`);
  body.querySelector('#do-imp').onclick = async (e) => {
    const items = [...body.querySelectorAll('select[data-cc]')].filter((s) => s.value)
      .map((s) => ({ ccSwitchId: s.dataset.cc, targetId: s.value === '__new' ? null : s.value, name: list.find((c) => c.id === s.dataset.cc).name }));
    if (!items.length) return toast('还没选择要导入的条目', 'warn');
    await busy(e.target, async () => {
      await api('import', { method: 'POST', body: { items } });
      toast(`已导入 ${items.length} 项`, 'success');
      closeModal();
      await refreshStatus();
      render(el);
    });
  };
}
