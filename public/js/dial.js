// 24-hour traffic as a clock face: each hour is a wedge whose stacked arcs
// are per-provider request counts; a hand marks "now". Hover reads out the hour.
import { esc, fmtK } from './core.js';

const C = 180;               // viewBox center (360×360)
const R0 = 66, R1 = 140;     // inner / outer radius of the bars
const GAP = 1.6;             // degrees between wedges

const rad = (deg) => ((deg - 90) * Math.PI) / 180;
const pt = (r, deg) => [C + r * Math.cos(rad(deg)), C + r * Math.sin(rad(deg))];
function wedge(r1, r2, a1, a2) {
  const [x1, y1] = pt(r2, a1), [x2, y2] = pt(r2, a2), [x3, y3] = pt(r1, a2), [x4, y4] = pt(r1, a1);
  return `M${x1.toFixed(2)},${y1.toFixed(2)} A${r2},${r2} 0 0 1 ${x2.toFixed(2)},${y2.toFixed(2)} L${x3.toFixed(2)},${y3.toFixed(2)} A${r1},${r1} 0 0 0 ${x4.toFixed(2)},${y4.toFixed(2)}Z`;
}

// hours: 24 slot starts (oldest→newest). by: {hour: [{provider_id,n}]}.
export function dial(hours, by, { colorOf, nameOf, total }) {
  const max = Math.max(1, ...hours.map((h) => (by[h] || []).reduce((n, r) => n + r.n, 0)));
  const now = new Date();
  const handDeg = (now.getHours() + now.getMinutes() / 60) * 15;
  let groups = '';
  hours.forEach((h, k) => {
    const hr = new Date(h).getHours();
    const a1 = hr * 15 + GAP / 2, a2 = (hr + 1) * 15 - GAP / 2;
    const rows = by[h] || [];
    const sum = rows.reduce((n, r) => n + r.n, 0);
    const age = 0.42 + 0.58 * (k / 23); // older hours fade like radar decay
    let r = R0, arcs = '';
    for (const row of rows) {
      const len = Math.max((row.n / max) * (R1 - R0), 2);
      arcs += `<path class="seg-a" style="--k:${k};color:${colorOf(row.provider_id)};--o:${age.toFixed(2)}" fill="currentColor" d="${wedge(r, r + len - 0.6, a1, a2)}"/>`;
      r += len;
    }
    const detail = rows.map((x) => `${nameOf(x.provider_id)} ${x.n}`).join(' · ');
    groups += `<g class="hr" data-h="${hr}" data-n="${sum}" data-x="${esc(detail)}"><path class="hit-a" d="${wedge(R0 - 4, R1 + 6, a1 - GAP / 2, a2 + GAP / 2)}"/>${arcs}</g>`;
  });
  let ticks = '';
  for (let i = 0; i < 96; i++) {
    const maj = i % 24 === 0, mid = i % 4 === 0;
    const [x1, y1] = pt(R1 + 10, i * 3.75), [x2, y2] = pt(R1 + (maj ? 18 : mid ? 14 : 12), i * 3.75);
    ticks += `<line class="tk ${maj ? 'maj' : ''}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }
  const lbls = [0, 6, 12, 18].map((h) => {
    const [x, y] = pt(R1 + 30, h * 15);
    return `<text class="lbl" x="${x.toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="middle">${String(h).padStart(2, '0')}</text>`;
  }).join('');
  const [hx1, hy1] = pt(R0 - 12, handDeg), [hx2, hy2] = pt(R1 + 20, handDeg);
  return `<div class="dial" id="dial">
    <svg viewBox="0 0 360 360" role="img" aria-label="24 小时每小时请求数">
      <circle class="ring" cx="${C}" cy="${C}" r="${R0 - 6}"/><circle class="ring" cx="${C}" cy="${C}" r="${R1 + 10}"/>
      ${ticks}${lbls}${groups}
      <line class="hand" x1="${hx1.toFixed(1)}" y1="${hy1.toFixed(1)}" x2="${hx2.toFixed(1)}" y2="${hy2.toFixed(1)}"/>
      <circle class="hand-dot" cx="${hx2.toFixed(1)}" cy="${hy2.toFixed(1)}" r="3"/>
    </svg>
    <div class="dial-mid"><div class="v" id="dial-v" data-count="${total}" data-key="dial-total">${total}</div><div class="k" id="dial-k">24H 请求</div><div class="x" id="dial-x">峰值 ${fmtK(max)}/时</div></div>
  </div>`;
}

// Hover readout. Bound once per dial element.
export function bindDial(root, total, max) {
  const d = root.querySelector('#dial');
  if (!d) return;
  const v = d.querySelector('#dial-v'), k = d.querySelector('#dial-k'), x = d.querySelector('#dial-x');
  const reset = () => {
    d.classList.remove('hovering');
    v.textContent = total.toLocaleString('en-US');
    k.textContent = '24H 请求';
    x.textContent = `峰值 ${fmtK(max)}/时`;
  };
  d.addEventListener('pointerover', (e) => {
    const g = e.target.closest('g.hr');
    if (!g) return;
    d.classList.add('hovering');
    v.textContent = g.dataset.n;
    k.textContent = `${g.dataset.h.padStart(2, '0')}:00 – ${String((+g.dataset.h + 1) % 24).padStart(2, '0')}:00`;
    x.textContent = g.dataset.x || '无请求';
  });
  d.addEventListener('pointerleave', reset);
}
