// ISSUE 8 — the reallocated loop: 3 GENERATED frames (midday, dusk, real NIGHT)
// + 1 DERIVED dawn (free, from dusk). Drives the REAL src/scene.js dawnFromCanvas
// and src/repaint.js on the real Tübingen gallery frames. Emits:
//   row 1: the four anchors in loop order — dawn(derived) midday dusk night
//   row 2: the mid-scrub of each transition, so the whole cycle can be judged
// Run: node validate/issue8-loop.mjs   Out: validate/out/loop/loop.png
import { createCanvas, loadImage, ImageData as NapiImageData } from '@napi-rs/canvas';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

globalThis.document = { createElement: (t) => { if (t === 'canvas') return createCanvas(1, 1); throw new Error('shim'); } };
globalThis.ImageData = NapiImageData;
const { createRepaint } = await import('../src/repaint.js');
const { dawnFromCanvas } = await import('../src/scene.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const G = join(HERE, '..', 'public', 'gallery', 'tubingen');
const OUT = join(HERE, 'out', 'loop');
await mkdir(OUT, { recursive: true });

const W = 540, H = 360;
const cv = (img) => { const c = createCanvas(W, H); c.getContext('2d').drawImage(img, 0, 0, W, H); return c; };

const midday = cv(await loadImage(join(G, 'midday.jpg')));
const dusk = cv(await loadImage(join(G, 'dusk.jpg')));
const night = cv(await loadImage(join(G, 'night.png')));
const dawn = cv(dawnFromCanvas(dusk)); // REAL derivation, strong variant

// anchors in loop order
const anchors = [['Dawn (derived)', dawn], ['Midday', midday], ['Dusk', dusk], ['Night (real)', night]];
// transitions in loop order (A -> B), shown at the eased mid-scrub
const trans = [
  ['dawn→midday', dawn, midday], ['midday→dusk', midday, dusk],
  ['dusk→night', dusk, night], ['night→dawn', night, dawn],
];

const display = createCanvas(W, H);
const rp = createRepaint(display, {});
rp.resize(W, H);
const ss = (p) => p * p * (3 - 2 * p);

const cw = 360, ch = 240, gap = 8, lab = 22, rowGap = 14;
const cols = 4;
const strip = createCanvas(cols * cw + (cols - 1) * gap, 2 * (ch + lab) + rowGap);
const s = strip.getContext('2d');
s.fillStyle = '#0d0f12';
s.fillRect(0, 0, strip.width, strip.height);
s.font = '15px sans-serif';

anchors.forEach(([name, c], i) => {
  const x = i * (cw + gap);
  s.fillStyle = '#9fc0ff';
  s.fillText(name, x + 4, 16);
  s.drawImage(c, x, lab, cw, ch);
});
const y2 = ch + lab + rowGap;
trans.forEach(([name, A, B], i) => {
  rp.setFrames(A, B);
  rp.render(ss(0.5));
  const x = i * (cw + gap);
  s.fillStyle = '#ffb066';
  s.fillText(`${name}  (mid)`, x + 4, y2 + 16);
  s.drawImage(display, x, y2 + lab, cw, ch);
});

await writeFile(join(OUT, 'loop.png'), strip.toBuffer('image/png'));
console.log('wrote validate/out/loop/loop.png');
