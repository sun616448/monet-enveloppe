// ISSUE 7 — can DAWN be DERIVED from DUSK (free) and still read as MORNING, not
// "recolored dusk"? Unlike the failed night-from-dusk, dawn & dusk are both
// low-sun warm-light states, so leftover sun-glow is CORRECT, not a tell. But
// dawn is NOT just cooler dusk: it's cooler/PINKER/cleaner, higher-key, fresher.
// A real transform: brightness LIFT (high-key morning) + COOL/de-orange (kill
// dusk's heavy orange) + paler/desaturated warm cast + a cool ROSE bloom in the
// highlights. Then judge against the OLD GENERATED dawn.
// Out: validate/out/dawn/compare.png (generated | derived) + derived.png
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REL = join(HERE, 'out', 'relight');
const OUT = join(HERE, 'out', 'dawn');
await mkdir(OUT, { recursive: true });

const W = 600, H = 400;
function toCanvas(img) { const c = createCanvas(W, H); c.getContext('2d').drawImage(img, 0, 0, W, H); return c; }
const dusk = toCanvas(await loadImage(join(REL, 'new-dusk.png')));
const genDawn = toCanvas(await loadImage(join(REL, 'new-dawn.png'))); // OLD generated dawn

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function dawnFromDusk(src, p = {}) {
  const { gamma = 0.80, lift = 1.05, coolR = 0.93, coolG = 1.00, coolB = 1.15,
          desat = 0.30, hiDesat = 0.0, hiCoolB = 0.0, roseHi = 0.60, roseR = 0.06,
          roseB = 0.05, mistFloor = 0.04 } = p;
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const id = ctx.getImageData(0, 0, W, H), d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const L = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    const hi = smooth(roseHi, 1.0, L); // highlight weight (the orange sky lives here)
    const lifted = Math.min(1, Math.pow(L, gamma) * lift);
    const k = lifted / Math.max(L, 1e-3);
    let cr = r * k, cg = g * k, cb = b * k;
    // cool / de-orange: pull red down, push blue up; extra blue in the sky highlights
    cr *= coolR; cg *= coolG; cb *= (coolB + hiCoolB * hi);
    // desaturate the warm cast toward grey — stronger in the highlights (kill orange sky)
    const ds = desat + hiDesat * hi;
    cr = cr * (1 - ds) + lifted * ds;
    cg = cg * (1 - ds) + lifted * ds;
    cb = cb * (1 - ds) + lifted * ds;
    // subtle cool ROSE bloom in highlights — rose, not orange
    cr += roseR * hi; cb += roseB * hi;
    // faint cool morning mist in the deepest shadows
    cr += mistFloor * (1 - lifted) * 0.6;
    cg += mistFloor * (1 - lifted) * 0.7;
    cb += mistFloor * (1 - lifted) * 1.0;
    d[i] = clamp(cr * 255); d[i + 1] = clamp(cg * 255); d[i + 2] = clamp(cb * 255);
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

// strength sweep: mild -> aggressive de-orange/cool/lift
const VARIANTS = [
  ['v1 MILD', { gamma: 0.80, lift: 1.05, coolR: 0.92, coolB: 1.16, desat: 0.32, hiDesat: 0.20, hiCoolB: 0.10 }],
  ['v2 MED', { gamma: 0.74, lift: 1.09, coolR: 0.86, coolB: 1.24, desat: 0.40, hiDesat: 0.38, hiCoolB: 0.18, roseR: 0.05, roseB: 0.07 }],
  ['v3 STRONG', { gamma: 0.70, lift: 1.12, coolR: 0.80, coolB: 1.30, desat: 0.48, hiDesat: 0.55, hiCoolB: 0.28, roseR: 0.04, roseB: 0.09, mistFloor: 0.06 }],
];
const cells = [['GENERATED dawn', genDawn], ...VARIANTS.map(([n, pp]) => [n, dawnFromDusk(dusk, pp)])];
const gap = 8, lab = 24;
const strip = createCanvas(cells.length * W + (cells.length - 1) * gap, H + lab);
const s = strip.getContext('2d');
s.fillStyle = '#0d0f12'; s.fillRect(0, 0, strip.width, strip.height);
s.font = '15px sans-serif'; s.fillStyle = '#9fc0ff';
cells.forEach(([n], i) => s.fillText(n, i * (W + gap) + 6, 17));
cells.forEach(([, cv], i) => s.drawImage(cv, i * (W + gap), lab));
await writeFile(join(OUT, 'compare.png'), strip.toBuffer('image/png'));
for (const [n, pp] of VARIANTS) await writeFile(join(OUT, `${n.split(' ')[0]}.png`), dawnFromDusk(dusk, pp).toBuffer('image/png'));
console.log('wrote validate/out/dawn/compare.png + v1/v2/v3.png');
