// Overview: a live signal map. First render builds everything and plays the
// entrance; later updates (render(el, { quiet: true })) patch in place so
// counters tween, wires re-colour and in-flight packets keep flying.
import { store, esc, api, fmtK, fmtTime, empty } from './core.js';
import { icon, LEVEL_ICON } from './icons.js';
import { providerCard, laneState, onAction } from './pcard.js';
import { countUp, scramble, reveal } from './fx.js';
import * as signal from './signal.js';
import { dial, bindDial } from './dial.js';

const COLORS = ['#d4ff3a', '#6ee7ff', '#ff7ae0', '#ffb547', '#a78bfa', '#7dffb0'];
const FAIL = '#ff4d3d';
const colorOf = (id) => {
  if (!id || id === '_none') return FAIL;
  const i = store.status.providers.findIndex((p) => p.id === id);
  return i < 0 ? '#565c64' : COLORS[i % COLORS.length];
};
const nameOf = (id) => (!id || id === '_none' ? '全部失败' : store.status.providers.find((p) => p.id === id)?.name || id);

let layoutKey = '';
let laneHtml = new Map();
let laneSig = new Map();
let dialSig = '';
let lastEventId = 0;

const H = 3600000;
function hoursAndBy(st) {
  const end = Math.floor(Date.now() / H) * H;
  const hours = Array.from({ length: 24 }, (_, i) => end - (23 - i) * H);
  const by = {};
  for (const r of st.stats.timeline || []) (by[r.hour] = by[r.hour] || []).push(r);
  return { hours, by };
}

function model(st) {
  const cur = st.providers.find((p) => p.id === st.activeProviderId);
  const pinned = st.settings.mode === 'pinned';
  const per = Object.fromEntries((st.stats.per || []).filter((x) => x.provider_id).map((x) => [x.provider_id, x]));
  const t = st.stats.totals || {};
  const tok = (st.stats.per || []).reduce((n, x) => n + (x.input_tokens || 0) + (x.output_tokens || 0), 0);
  const cache = (st.stats.per || []).reduce((n, x) => n + (x.cache_read || 0), 0);
  const rate = t.total ? (t.ok / t.total) * 100 : null;
  const { hours, by } = hoursAndBy(st);
  return { cur, pinned, per, t, tok, cache, rate, hours, by };
}

function lanesHtml(st, m) {
  const series = {};
  for (const p of st.providers) series[p.id] = m.hours.map((h) => (m.by[h] || []).find((r) => r.provider_id === p.id) || { n: 0, failed: 0 });
  return st.providers.map((p, i) => [p.id, providerCard(p, i, {
    isCur: p.id === st.activeProviderId, pinned: m.pinned && st.settings.pinnedProviderId === p.id,
    stats: m.per[p.id], count: st.providers.length, color: colorOf(p.id), series: series[p.id],
  })]);
}

// ---------- pieces ----------
function notices(st, pinned) {
  if (pinned) return `<div class="notice warn">${icon('lock')}已锁定线路，出错也不会切换<button class="btn sm" data-act="auto">恢复自动</button></div>`;
  if (st.lastResort) return `<div class="notice err">${icon('alert')}所有线路都已下线，正在逐个尽力尝试</div>`;
  return '';
}

function hero(st, m) {
  return `<section class="ov-hero ${m.cur ? '' : 'dead'}" id="ov-hero" data-rv>
    <div class="eyebrow"><span class="live" id="ov-live">${m.cur ? 'NOW ROUTING' : 'NO ROUTE'}</span><span class="rule"></span><span>${esc(st.baseUrl.replace(/^https?:\/\//, ''))}</span></div>
    <h1 class="ov-name"><span class="glyph">›</span><span id="ov-name" data-scramble="${esc(m.cur ? m.cur.name : '没有可用线路')}">${esc(m.cur ? m.cur.name : '没有可用线路')}</span></h1>
    <div class="ov-side">
      <div class="seg ${m.pinned ? 'locked' : ''}" id="ov-seg" role="group" aria-label="路由模式">
        <button class="${m.pinned ? '' : 'on'}" data-act="auto">${icon('zap')}自动</button>
        <button class="${m.pinned ? 'on' : ''}" data-act="pin-cur">${icon('lock')}锁定</button>
      </div>
      <div class="ov-sub" id="ov-sub">${m.pinned ? '已锁定，不会自动切换' : '出错自动切换，恢复后自动切回'}</div>
    </div>
  </section>`;
}

const CIRC = 2 * Math.PI * 92;
function core(st, m) {
  const ticks = Array.from({ length: 60 }, (_, i) => {
    const a = (i * 6 * Math.PI) / 180, r1 = 104, r2 = i % 5 ? 107 : 111;
    return `<line x1="${(115 + r1 * Math.sin(a)).toFixed(1)}" y1="${(115 - r1 * Math.cos(a)).toFixed(1)}" x2="${(115 + r2 * Math.sin(a)).toFixed(1)}" y2="${(115 - r2 * Math.cos(a)).toFixed(1)}"/>`;
  }).join('');
  return `<div class="sig-core ${coreCls(st, m)}" id="ov-core" data-rv>
    <svg viewBox="0 0 230 230" aria-hidden="true">
      <circle class="r1" cx="115" cy="115" r="113"/><g class="ticks">${ticks}</g>
      <circle class="trk" cx="115" cy="115" r="92"/>
      <circle class="arc" id="ov-arc" cx="115" cy="115" r="92" stroke-dasharray="${CIRC.toFixed(1)}" stroke-dashoffset="${CIRC.toFixed(1)}"/>
      <circle class="r2" cx="115" cy="115" r="80"/><circle class="disc" cx="115" cy="115" r="70"/>
    </svg>
    <span class="shock"></span>
    <div class="mid">
      <span class="k">ROUTER · MODE</span>
      <span class="m" id="ov-mode">${coreMode(st, m)}</span>
      <span class="sep"></span>
      <span class="p">${m.rate == null ? '–' : `<span data-count="${m.rate}" data-fmt="pct" data-key="core-rate">0</span><small>%</small>`}</span>
      <span class="k">24H 成功率</span>
    </div>
  </div>`;
}
const coreCls = (st, m) => (!m.cur ? 'dead' : m.pinned ? 'locked' : '');
const coreMode = (st, m) => (!m.cur ? 'DOWN' : m.pinned ? 'LOCK' : 'AUTO');
const arcOffset = (m) => (CIRC * (1 - (m.rate || 0) / 100)).toFixed(1);

function strip(m) {
  const t = m.t;
  const cell = (key, ic, c, label, n, fmt, sub, frac) => `<div class="cell" style="--c:${c}" data-rv>
    <div class="k">${icon(ic)}${label}</div>
    <div class="v"><span data-count="${n}" data-fmt="${fmt}" data-key="st-${key}">0</span>${key === 'rate' ? '<small>%</small>' : ''}</div>
    <div class="d" id="st-${key}-d">${sub}</div>
    <div class="bar"><i id="st-${key}-b" style="transform:scaleX(${Math.min(1, Math.max(0, frac)).toFixed(3)})"></i></div></div>`;
  return `<section class="strip" id="ov-strip">
    ${cell('total', 'activity', 'var(--sig)', '24H 请求', t.total || 0, 'int', `成功 ${t.ok || 0} · 失败 ${(t.total || 0) - (t.ok || 0)}`, 1)}
    ${cell('rate', 'checkCircle', 'var(--ok)', '成功率', m.rate ?? 0, 'pct', m.rate == null ? '还没有请求' : '过去 24 小时', (m.rate || 0) / 100)}
    ${cell('fo', 'shuffle', 'var(--warn)', '自动切换', t.failovers || 0, 'int', `压缩发送 ${t.compacted || 0} 次`, t.total ? (t.failovers || 0) / t.total : 0)}
    ${cell('tok', 'package', 'var(--info)', 'TOKENS', m.tok, 'k', `缓存命中 ${fmtK(m.cache)}`, m.tok ? m.cache / Math.max(m.tok, m.cache) : 0)}
  </section>`;
}

function dialBlock(st, m) {
  const total = m.t.total || 0;
  const used = new Map();
  for (const r of st.stats.timeline || []) used.set(r.provider_id || '_none', (used.get(r.provider_id || '_none') || 0) + r.n);
  if (!used.size) return empty('还没有请求', 'activity');
  const sum = [...used.values()].reduce((a, b) => a + b, 0) || 1;
  const order = [...st.providers.map((p) => p.id), '_none'].filter((id) => used.has(id));
  const legend = order.map((id) => {
    const n = used.get(id);
    return `<li style="color:${colorOf(id)}"><i style="background:currentColor"></i><span style="color:var(--text)">${esc(nameOf(id))}</span>
      <span class="n" style="color:var(--text)">${n.toLocaleString('en-US')}<small>${Math.round((n / sum) * 100)}%</small></span>
      <span class="bar"><b style="transform:scaleX(${(n / sum).toFixed(3)})"></b></span></li>`;
  }).join('');
  return `<div class="dial-wrap">${dial(m.hours, m.by, { colorOf, nameOf, total })}<ul class="legend">${legend}</ul></div>`;
}

export const feedItem = (e, fresh) => `<li class="${fresh ? 'fresh' : ''}">
  <span class="lv ${e.level}">${icon(LEVEL_ICON[e.level] || 'info')}</span>
  <div>${esc(e.message)}${e.detail && e.detail.message ? `<details><summary>详情</summary><pre class="small">${esc(e.detail.message)}</pre></details>` : ''}</div>
  <time>${fmtTime(e.ts)}</time></li>`;

// ---------- render ----------
export function render(el, { quiet = false } = {}) {
  const st = store.status;
  const m = model(st);
  const key = st.providers.map((p) => p.id).join(',');
  if (quiet && key === layoutKey && el.querySelector('#ov-map')) return patch(el, st, m);
  layoutKey = key;
  const lanes = lanesHtml(st, m);
  laneHtml = new Map(lanes);
  laneSig = new Map(st.providers.map((p) => [p.id, laneState(p, p.id === st.activeProviderId).sig]));
  dialSig = JSON.stringify([m.hours[23], st.stats.timeline]);
  el.innerHTML = `
    <div id="ov-notice">${notices(st, m.pinned)}</div>
    ${hero(st, m)}
    <section class="sig-map" id="ov-map" aria-label="路由拓扑">
      <svg class="wires" aria-hidden="true"></svg>
      <div class="sig-src" data-rv><div class="t"><span>&gt;_</span>CLAUDE CODE</div><div class="u">${esc(st.baseUrl)}</div>
        <div class="port"><span>INGRESS</span><b>:${esc(String(st.settings.port))}</b></div></div>
      ${core(st, m)}
      <div class="lanes" id="ov-lanes">${lanes.map(([, h]) => h).join('')}</div>
    </section>
    ${strip(m)}
    <div class="cols">
      <section class="card hud" data-rv><div class="card-title"><h3>24 小时流量</h3></div><div id="ov-dial">${dialBlock(st, m)}</div></section>
      <section class="card hud" data-rv><div class="card-title"><h3>最近动态</h3><a href="#events">查看全部 →</a></div><ul class="feed stagger" id="ov-feed">${skelFeed()}</ul></section>
    </div>`;
  reveal(el);
  countUp(el);
  scramble(el.querySelector('#ov-name'), undefined, { dur: 1100 });
  requestAnimationFrame(() => el.querySelector('#ov-arc')?.setAttribute('stroke-dashoffset', arcOffset(m)));
  signal.mount(el.querySelector('#ov-map'), { animate: !quiet });
  bindDial(el, m.t.total || 0, maxHour(m));
  feed(el, false);
}

const maxHour = (m) => Math.max(1, ...m.hours.map((h) => (m.by[h] || []).reduce((n, r) => n + r.n, 0)));
const skelFeed = () => Array.from({ length: 5 }, () => `<li><time><span class="skel" style="width:50px;display:block"></span></time><span></span><span class="skel" style="width:${50 + Math.random() * 40}%"></span></li>`).join('');

function patch(el, st, m) {
  const notice = el.querySelector('#ov-notice');
  const nh = notices(st, m.pinned);
  if (notice.innerHTML.trim() !== nh) notice.innerHTML = nh;

  // hero
  const heroEl = el.querySelector('#ov-hero');
  heroEl.classList.toggle('dead', !m.cur);
  el.querySelector('#ov-live').textContent = m.cur ? 'NOW ROUTING' : 'NO ROUTE';
  const name = m.cur ? m.cur.name : '没有可用线路';
  const nameEl = el.querySelector('#ov-name');
  if (nameEl.dataset.scramble !== name) scramble(nameEl, name, { dur: 800, wait: false });
  const seg = el.querySelector('#ov-seg');
  seg.classList.toggle('locked', m.pinned);
  seg.children[0].classList.toggle('on', !m.pinned);
  seg.children[1].classList.toggle('on', m.pinned);
  el.querySelector('#ov-sub').textContent = m.pinned ? '已锁定，不会自动切换' : '出错自动切换，恢复后自动切回';

  // core
  const coreEl = el.querySelector('#ov-core');
  coreEl.className = `sig-core ${coreCls(st, m)}`;
  el.querySelector('#ov-mode').textContent = coreMode(st, m);
  el.querySelector('#ov-arc').setAttribute('stroke-dashoffset', arcOffset(m));
  const pr = coreEl.querySelector('[data-key="core-rate"]');
  if (pr && m.rate != null) pr.dataset.count = m.rate;

  // strip: rebuild markup off-DOM, then copy only values so tweens run
  const tmp = document.createElement('div');
  tmp.innerHTML = strip(m);
  tmp.querySelectorAll('[data-count]').forEach((n) => {
    const live = el.querySelector(`[data-key="${n.dataset.key}"]`);
    if (live) live.dataset.count = n.dataset.count;
  });
  tmp.querySelectorAll('.d[id], .bar i[id]').forEach((n) => {
    const live = el.querySelector('#' + n.id);
    if (!live) return;
    if (n.matches('.d')) live.textContent = n.textContent;
    else live.style.transform = n.style.transform;
  });
  countUp(el);

  // lanes: replace only those whose markup changed
  const lanesEl = el.querySelector('#ov-lanes');
  for (const [id, h] of lanesHtml(st, m)) {
    if (laneHtml.get(id) === h) continue;
    laneHtml.set(id, h);
    const old = lanesEl.querySelector(`.lane[data-id="${CSS.escape(id)}"]`);
    if (!old) continue;
    const p = st.providers.find((x) => x.id === id);
    const sig = laneState(p, id === st.activeProviderId).sig;
    const t = document.createElement('div');
    t.innerHTML = h.trim();
    const nu = t.firstElementChild;
    nu.removeAttribute('data-rv');
    old.replaceWith(nu);
    signal.observeLane(nu);
    if (laneSig.get(id) !== sig) {
      nu.classList.add('changed');
      laneSig.set(id, sig);
    }
  }
  signal.layout();

  // dial
  const ds = JSON.stringify([m.hours[23], st.stats.timeline]);
  if (ds !== dialSig) {
    dialSig = ds;
    const dEl = el.querySelector('#ov-dial');
    dEl.classList.add('quiet');
    dEl.innerHTML = dialBlock(st, m);
    countUp(el.querySelector('#ov-dial'));
    bindDial(el, m.t.total || 0, maxHour(m));
  }
  feed(el, true);
}

async function feed(el, live) {
  try {
    const evs = (await api('events?limit=30')).filter((e) => e.type !== 'probe').slice(0, 8);
    const box = el.querySelector('#ov-feed');
    if (!box) return;
    const top = evs[0]?.id || 0;
    if (live && top === lastEventId) return;
    const prev = lastEventId;
    if (live) box.classList.remove('stagger');
    lastEventId = top;
    box.innerHTML = evs.length ? evs.map((e) => feedItem(e, live && e.id > prev)).join('') : `<li style="display:block">${empty('一切安静')}</li>`;
    if (!live) box.querySelectorAll('li').forEach((li, i) => li.style.setProperty('--i', i));
  } catch {}
}

export function onClick(e, rerender) {
  const b = e.target.closest('[data-act]');
  if (b && !b.disabled) onAction(b, rerender);
}

// Live request → light along its route.
export const onRequest = (r) => signal.pulse(r);
