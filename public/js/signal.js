// Signal map: wires from client → core → each lane, measured from the real DOM,
// plus packets that replay every finished request's route as travelling light.
import { reduced } from './fx.js';

let map = null;          // current .sig-map element
let ro = null;
let packets = null;      // persistent layer, re-parented across re-renders
let flying = 0;
let drawn = false;       // first draw animates wires in
const MAX_FLYING = 14;

const NS = 'http://www.w3.org/2000/svg';

export function mount(el, { animate = true } = {}) {
  map = el;
  if (animate) drawn = false;
  if (!packets) {
    packets = document.createElement('div');
    packets.className = 'packets';
  }
  map.appendChild(packets);
  ro?.disconnect();
  ro = new ResizeObserver(() => layout());
  ro.observe(map);
  map.querySelectorAll('.lane').forEach((l) => ro.observe(l));
  layout();
}

export const observeLane = (l) => ro?.observe(l);

// Center/edge points relative to the map box.
function box(el, mr) {
  const r = el.getBoundingClientRect();
  return { l: r.left - mr.left, r: r.right - mr.left, t: r.top - mr.top, b: r.bottom - mr.top, cx: r.left - mr.left + r.width / 2, cy: r.top - mr.top + r.height / 2 };
}

const curve = (a, b, vertical) => {
  if (vertical) {
    const my = (a.y + b.y) / 2;
    return `M${a.x},${a.y} C${a.x},${my} ${b.x},${my} ${b.x},${b.y}`;
  }
  const mx = a.x + Math.max(30, (b.x - a.x) * 0.55);
  return `M${a.x},${a.y} C${mx},${a.y} ${b.x - Math.max(30, (b.x - a.x) * 0.45)},${b.y} ${b.x},${b.y}`;
};

export function layout() {
  if (!map || !map.isConnected) return;
  const svg = map.querySelector('.wires');
  const src = map.querySelector('.sig-src');
  const core = map.querySelector('.sig-core');
  const lanes = [...map.querySelectorAll('.lane')];
  if (!svg || !src || !core) return;
  const r0 = map.getBoundingClientRect();
  // padding box, which is what the absolutely positioned layers fill
  const mr = { left: r0.left + map.clientLeft, top: r0.top + map.clientTop, width: map.clientWidth, height: map.clientHeight };
  svg.setAttribute('viewBox', `0 0 ${mr.width} ${mr.height}`);
  const s = box(src, mr), c = box(core, mr);
  const rad = (c.r - c.l) * 0.43;
  const paths = [];

  // Trunk: client → core. Horizontal when side by side, else vertical.
  const sideBySide = s.r <= c.l + 4;
  const trunk = sideBySide
    ? curve({ x: s.r, y: s.cy }, { x: c.cx - rad, y: c.cy })
    : curve({ x: s.cx, y: s.b }, { x: c.cx, y: c.cy - rad }, true);
  paths.push({ id: 'trunk', d: trunk, cls: 'trunk' });

  for (const l of lanes) {
    const b = box(l, mr);
    const beside = b.l >= c.r - 4;
    const d = beside
      ? curve({ x: c.cx + rad, y: c.cy }, { x: b.l, y: b.cy })
      : curve({ x: c.cx, y: c.cy + rad }, { x: b.l + 30, y: b.t }, true);
    paths.push({ id: l.dataset.id, d, cls: l.dataset.wire || '' });
  }

  // Reuse existing <g> per path so CSS transitions on state survive.
  const keep = new Set();
  paths.forEach((p, i) => {
    keep.add(p.id);
    let g = svg.querySelector(`g[data-w="${CSS.escape(p.id)}"]`);
    if (!g) {
      g = document.createElementNS(NS, 'g');
      g.dataset.w = p.id;
      for (const k of ['w-glow', 'w-base', 'w-flow']) {
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('class', k);
        g.appendChild(path);
      }
      svg.appendChild(g);
    }
    g.setAttribute('class', `w ${p.cls}`);
    g.querySelectorAll('path').forEach((path) => path.setAttribute('d', p.d));
    if (!drawn && !reduced) {
      const base = g.querySelector('.w-base');
      const len = base.getTotalLength();
      base.style.setProperty('--len', len);
      base.style.setProperty('--d', `${0.25 + i * 0.14}s`);
      base.classList.add('draw');
      base.addEventListener('animationend', () => base.classList.remove('draw'), { once: true });
    }
  });
  svg.querySelectorAll('g[data-w]').forEach((g) => !keep.has(g.dataset.w) && g.remove());
  drawn = true;
}

// Update a lane's wire state without re-layout.
export function setWire(id, cls) {
  const g = map?.querySelector(`.wires g[data-w="${CSS.escape(id)}"]`);
  if (g) g.setAttribute('class', `w ${cls}`);
}

function pathD(id) {
  return map?.querySelector(`.wires g[data-w="${CSS.escape(id)}"] .w-base`)?.getAttribute('d');
}

// Fly a dot (and its trail) along a wire; resolves on arrival.
function fly(d, { bad = false, dur = 620, delay = 0 } = {}) {
  return new Promise((resolve) => {
    if (!d || !packets?.isConnected) return resolve();
    const els = ['pk', 'pk trail'].map((c) => {
      const e = document.createElement('i');
      e.className = c + (bad ? ' bad' : '');
      e.style.offsetPath = `path('${d}')`;
      packets.appendChild(e);
      return e;
    });
    const anims = els.map((e) => e.animate(
      [{ offsetDistance: '0%', opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.85 }, { offsetDistance: '100%', opacity: 0 }],
      { duration: dur, delay, easing: 'cubic-bezier(.55,.05,.35,1)', fill: 'both' }));
    anims[0].finished.catch(() => {}).finally(() => {
      els.forEach((e) => e.remove());
      resolve();
    });
  });
}

function flash(el, cls) {
  if (!el) return;
  el.classList.remove(cls, 'bad');
  void el.offsetWidth;
  el.classList.add(cls);
  clearTimeout(el._fl);
  el._fl = setTimeout(() => el.classList.remove(cls, 'bad'), 900);
}

// Replay a finished request: client → core → (failed hop…) → final hop.
export async function pulse(req) {
  if (reduced || !map?.isConnected || flying >= MAX_FLYING || document.hidden) return;
  const hops = (req.attempts || []).filter((a) => !a.skipped);
  flying++;
  try {
    flash(map.querySelector('.sig-src'), 'tx');
    await fly(pathD('trunk'), { dur: 520 });
    const shock = map?.querySelector('.sig-core .shock');
    for (const a of hops) {
      if (shock) {
        shock.classList.remove('go', 'bad');
        void shock.offsetWidth;
        shock.classList.add('go');
        if (!a.ok) shock.classList.add('bad');
      }
      await fly(pathD(a.providerId), { bad: !a.ok, dur: 640 });
      const lane = map?.querySelector(`.lane[data-id="${CSS.escape(a.providerId)}"]`);
      flash(lane, 'hit');
      if (lane && !a.ok) lane.classList.add('bad');
    }
  } finally {
    flying--;
  }
}
