// Command palette (Ctrl/⌘+K or /): jump anywhere, run any provider action.
import { store, esc, copy, closeDialog, PAGES } from './core.js';
import { icon } from './icons.js';
import { onAction } from './pcard.js';

let ctx = null;
let items = [];
let shown = [];
let sel = 0;
const d = document.getElementById('palette');
const q = document.getElementById('pal-q');
const list = document.getElementById('pal-list');

// Run a pcard action without a real button (busy() tolerates the detached one).
const act = (a, id) => () => {
  const b = document.createElement('button');
  b.dataset.act = a;
  if (id) b.dataset.id = id;
  return onAction(b, ctx.rerender);
};

function build() {
  const st = store.status;
  const out = PAGES.map(([id, name, ic, code], i) => ({ grp: '页面', ic, text: `前往 ${name}`, hint: code.toLowerCase(), k: String(i + 1), run: () => ctx.go(id) }));
  if (!st) return out;
  const pinned = st.settings.mode === 'pinned';
  out.push(pinned
    ? { grp: '路由', ic: 'zap', text: '恢复自动切换', hint: 'auto', run: act('auto') }
    : { grp: '路由', ic: 'lock', text: '锁定当前线路', hint: 'pin lock', run: act('pin-cur') });
  for (const p of st.providers) {
    const off = !p.enabled || !p.hasKey;
    if (!off) out.push({ grp: '线路', ic: 'activity', text: `探测 ${p.name}`, hint: 'probe', run: act('probe', p.id) });
    if (!off && !(pinned && st.settings.pinnedProviderId === p.id)) out.push({ grp: '线路', ic: 'lock', text: `锁定到 ${p.name}`, hint: 'pin', run: act('pin', p.id) });
    out.push({ grp: '线路', ic: 'coins', text: `查看 ${p.name} 用量`, hint: 'balance usage', run: act('balance', p.id) });
  }
  out.push({ grp: '复制', ic: 'copy', text: '复制请求地址', hint: st.baseUrl, run: () => copy(st.baseUrl) });
  out.push({ grp: '复制', ic: 'key', text: '复制路由密钥', hint: 'key', run: () => copy(st.settings.routerKey) });
  return out;
}

const hl = (text, term) => {
  if (!term) return esc(text);
  const i = text.toLowerCase().indexOf(term);
  return i < 0 ? esc(text) : esc(text.slice(0, i)) + `<mark>${esc(text.slice(i, i + term.length))}</mark>` + esc(text.slice(i + term.length));
};

function paint() {
  const term = q.value.trim().toLowerCase();
  shown = items.filter((x) => !term || (x.text + ' ' + (x.hint || '')).toLowerCase().includes(term));
  sel = Math.min(sel, Math.max(0, shown.length - 1));
  let grp = '';
  list.innerHTML = shown.length ? shown.map((x, i) => {
    const g = x.grp !== grp ? `<li class="grp">${(grp = x.grp)}</li>` : '';
    return `${g}<li data-i="${i}" role="option" class="${i === sel ? 'sel' : ''}" aria-selected="${i === sel}">${icon(x.ic)}<span>${hl(x.text, term)}</span>${x.k ? `<span class="k">${x.k}</span>` : ''}</li>`;
  }).join('') : '<li class="grp">没有匹配的命令</li>';
  list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}

function run(i) {
  const x = shown[i];
  if (!x) return;
  closeDialog(d);
  setTimeout(() => x.run(), 120);
}

export function open() {
  if (d.open) return;
  items = build();
  q.value = '';
  sel = 0;
  paint();
  d.classList.remove('closing');
  d.showModal();
  q.focus();
}

export function init(c) {
  ctx = c;
  q.addEventListener('input', () => ((sel = 0), paint()));
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length);
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(sel);
    }
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) run(Number(li.dataset.i));
  });
  list.addEventListener('pointermove', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li && Number(li.dataset.i) !== sel) {
      list.querySelector('.sel')?.classList.remove('sel');
      li.classList.add('sel');
      sel = Number(li.dataset.i);
    }
  });
  d.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeDialog(d);
  });
  d.addEventListener('click', (e) => e.target === d && closeDialog(d));
}
