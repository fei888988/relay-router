import { api, empty, pageHead, store } from './core.js';
import { feedItem } from './overview.js';

// Filter groups shown as chips; each maps to one or more event types.
const CODEX_GROUPS = [
  ['', '全部'], ['codex_switch', '切换'], ['codex_exhaustion,codex_recovery', '额度与冷却'], ['codex_auth,codex_sync', '登录与同步'],
];
const CLAUDE_GROUPS = [
  ['', '全部'], ['switch', '切换'], ['down,recover,cooldown', '上下线'], ['compaction,learn', '压缩'], ['probe', '探测'], ['config,settings,mode,reset,model,start', '其他'],
];
let group = '';
let shownApp = null;
const isCodex = () => store.app === 'codex';
// Each app sees only its own telemetry.
const mine = (e) => String(e.type).startsWith('codex_') === isCodex();
let level = '';
let list = [];

const matches = (e) => mine(e) && (!group || group.split(',').includes(e.type)) && (!level || e.level === level);

export async function render(el) {
  if (shownApp !== store.app) (group = ''), (shownApp = store.app);
  const GROUPS = isCodex() ? CODEX_GROUPS : CLAUDE_GROUPS;
  el.innerHTML = `
    ${pageHead(isCodex() ? 'codex-events' : 'events', '<span class="tag" id="ev-count">…</span>')}
    <div class="filters" data-rv>
      <div class="chips" id="e-g">${GROUPS.map(([k, v]) => `<button data-v="${k}" class="${group === k ? 'on' : ''}">${v}</button>`).join('')}</div>
      <span class="grow"></span>
      <select id="e-l" aria-label="级别">
        ${[['', '全部级别'], ['error', '错误'], ['warn', '警告'], ['success', '成功'], ['info', '信息']].map(([k, v]) => `<option value="${k}" ${level === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </div>
    <section class="card hud ev-card" data-rv><ul class="feed stagger" id="ev-list"></ul>
      <div class="row" style="justify-content:center;margin-top:10px"><button class="btn ghost" id="e-more">加载更多</button></div></section>`;
  el.querySelector('#e-g').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    group = b.dataset.v;
    el.querySelectorAll('#e-g button').forEach((x) => x.classList.toggle('on', x === b));
    paint(el);
  };
  el.querySelector('#e-l').onchange = (e) => ((level = e.target.value), paint(el));
  el.querySelector('#e-more').onclick = async () => {
    if (list.length) list = list.concat(await api('events?limit=500&beforeId=' + list[list.length - 1].id));
    paint(el);
  };
  list = await api('events?limit=500');
  paint(el);
}

function paint(el) {
  const box = el.querySelector('#ev-list');
  const shown = list.filter(matches);
  if (box) {
    box.innerHTML = shown.length ? shown.map((e) => feedItem(e)).join('') : `<li style="display:block">${empty('没有符合条件的事件')}</li>`;
    box.querySelectorAll('li').forEach((li, i) => li.style.setProperty('--i', Math.min(i, 30)));
  }
  const c = el.querySelector('#ev-count');
  if (c) c.textContent = `${shown.length} / ${list.filter(mine).length}`;
}

export function onLive(el, e) {
  if (!mine(e)) return;
  list.unshift(e);
  if (!matches(e)) return;
  const box = el.querySelector('#ev-list');
  if (!box) return;
  if (box.querySelector('.empty')) box.innerHTML = '';
  box.insertAdjacentHTML('afterbegin', feedItem(e, true));
}
