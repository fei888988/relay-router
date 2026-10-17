// Motion primitives shared by every page: count-up numerals, text scramble,
// staggered reveals, pointer light, button ripples. All rAF-driven and cheap.

// localStorage['sr-motion'] = '1' keeps full motion even when the OS asks for less.
const force = (() => { try { return localStorage.getItem('sr-motion') === '1'; } catch { return false; } })();
if (force) document.documentElement.classList.add('force-motion');
export const reduced = !force && matchMedia('(prefers-reduced-motion: reduce)').matches;

let bootResolve;
export const booted = new Promise((r) => (bootResolve = r));
export const markBooted = () => bootResolve();

const easeOut = (t) => 1 - Math.pow(1 - t, 4);

// ---- Count-up numerals -------------------------------------------------
// Elements: <span data-count="1234" data-fmt="int|pct|k|ms" data-key="unique"></span>
const last = new Map();
const FMT = {
  int: (n) => Math.round(n).toLocaleString('en-US'),
  pct: (n) => (Math.round(n * 10) / 10).toFixed(1),
  k: (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(Math.round(n))),
  ms: (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + 'ms'),
};
export function countUp(root) {
  root.querySelectorAll('[data-count]').forEach((el) => {
    const to = Number(el.dataset.count);
    const fmt = FMT[el.dataset.fmt] || FMT.int;
    if (!Number.isFinite(to)) return;
    const key = el.dataset.key;
    const from = key && last.has(key) ? last.get(key) : 0;
    if (key) last.set(key, to);
    if (reduced || from === to) return void (el.textContent = fmt(to));
    const dur = from === 0 ? 1400 : 700;
    el.textContent = fmt(from);
    const go = () => {
      const t0 = performance.now();
      const step = (now) => {
        if (!el.isConnected) return;
        const t = Math.min(1, (now - t0) / dur);
        el.textContent = fmt(from + (to - from) * easeOut(t));
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    from === 0 ? booted.then(go) : go();
  });
}

// ---- Scramble: text resolves left→right through glyph noise ----------------
const GLYPHS = '▚▞▙▟░▒#/<>_=+*01ABCDEFXYZ';
export function scramble(el, text = el.dataset.scramble ?? el.textContent, { dur = 900, wait = true } = {}) {
  if (!el) return;
  el.dataset.scramble = text;
  if (reduced) return void (el.textContent = text);
  const run = () => {
    const id = (el._scr = (el._scr || 0) + 1);
    const chars = [...text];
    const t0 = performance.now();
    const step = (now) => {
      if (el._scr !== id || !el.isConnected) return;
      const p = Math.min(1, (now - t0) / dur);
      const done = Math.floor(p * chars.length);
      el.textContent = chars.map((c, i) => (i < done || c === ' ' ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join('');
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = text;
    };
    requestAnimationFrame(step);
  };
  wait ? booted.then(run) : run();
}

// ---- Stagger index for [data-rv] children ------------------------------
export function reveal(root) {
  root.querySelectorAll('[data-rv]').forEach((el, i) => el.style.setProperty('--i', i));
}

// ---- Ambient pointer light + per-card rim light ------------------------
export function initPointer() {
  if (reduced || matchMedia('(pointer: coarse)').matches) return;
  const light = document.getElementById('fx-light');
  let x = innerWidth / 2, y = innerHeight / 3, tx = x, ty = y, raf = 0, card = null;
  const loop = () => {
    x += (tx - x) * 0.12;
    y += (ty - y) * 0.12;
    light.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.5 ? requestAnimationFrame(loop) : 0;
  };
  addEventListener('pointermove', (e) => {
    tx = e.clientX;
    ty = e.clientY;
    document.body.classList.add('pointer');
    if (!raf) raf = requestAnimationFrame(loop);
    const c = e.target.closest?.('.card, .lane');
    if (c !== card) card = c;
    if (card) {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    }
  }, { passive: true });
  document.addEventListener('pointerleave', () => document.body.classList.remove('pointer'));
}

// ---- Button ripple ---------------------------------------------------------
export function initRipple() {
  if (reduced) return;
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.btn, .seg button');
    if (!b || b.disabled) return;
    const r = b.getBoundingClientRect();
    const s = document.createElement('span');
    s.className = 'rip';
    s.style.left = `${e.clientX - r.left}px`;
    s.style.top = `${e.clientY - r.top}px`;
    b.appendChild(s);
    s.addEventListener('animationend', () => s.remove(), { once: true });
  });
}
