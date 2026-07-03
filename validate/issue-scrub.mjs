// CAUSE A diagnosis — is the visual change distributed evenly across a constant-
// rate scrub, or back-loaded (barely changes mid-segment, then snaps at the
// anchor)? Drives the REAL src/repaint.js + color.js drift exactly as the app
// does, sampling a segment (midday -> dusk) at uniform scrub positions p, under:
//   LINEAR : t = p              (current behaviour)
//   EASED  : t = smoothstep(p)  (ease-in-out)
// Prints per-step mean pixel delta (where change concentrates) and writes a
// 2-row filmstrip. If LINEAR deltas are wildly uneven -> timing (fixable free).
// If even but a structural jump remains at the anchor -> Cause B (frame gap).
//
// Run: node validate/issue-scrub.mjs
import { createCanvas, loadImage, ImageData as NapiImageData } from '@napi-rs/canvas';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

globalThis.document = { createElement: (t) => { if (t === 'canvas') return createCanvas(1, 1); throw new Error('shim'); } };
globalThis.ImageData = NapiImageData;
const { createRepaint } = await import('../src/repaint.js');
const { imageStats, composeFrame } = await import('../src/color.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const REL = join(HERE, 'out', 'relight');
const OUT = join(HERE, 'out', 'transition');
await mkdir(OUT, { recursive: true });

const W = 540, H = 360, DRIFT = 0.65;
const smoothstep = (p) => p * p * (3 - 2 * p);

function frameData(img) {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  const imageData = ctx.getImageData(0, 0, W, H);
  return { canvas: c, imageData, stats: imageStats(imageData) };
}

const A = frameData(await loadImage(join(REL, 'midday.png')));
const B = frameData(await loadImage(join(REL, 'new-dusk.png')));

const display = createCanvas(W, H);
const repaint = createRepaint(display, { dens: 1, size: 1, fade: 0.06 });
repaint.resize(W, H);
const driftCanvas = createCanvas(W, H);
const dctx = driftCanvas.getContext('2d');
const scratch = new ImageData(W, H);

// Render one display frame the way app.js does, at eased/linear progress `t`.
// repaint.js now owns the colour/light drift internally (from raw keyframes), so
// we pass the RAW frames — no composeFrame pre-step (that would double-tint).
function renderAt(t) {
  repaint.setFrames(A.canvas, B.canvas);
  repaint.render(t);
  return display.getContext('2d').getImageData(0, 0, W, H).data;
}

const meanDelta = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i += 4) s += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
  return s / (a.length / 4);
};

const STEPS = 10;
const ps = Array.from({ length: STEPS + 1 }, (_, i) => i / STEPS);

function run(label, ease) {
  let prev = null;
  const deltas = [];
  for (const p of ps) {
    const cur = renderAt(ease ? smoothstep(p) : p);
    if (prev) deltas.push(meanDelta(prev, cur));
    prev = Uint8ClampedArray.from(cur);
  }
  const max = Math.max(...deltas), min = Math.min(...deltas);
  console.log(`\n${label}  per-step Δ (0→1, ${STEPS} steps):`);
  console.log('  [' + deltas.map((d) => d.toFixed(1)).join(', ') + ']');
  console.log(`  max/min ratio = ${(max / Math.max(min, 0.01)).toFixed(1)}  (1 = perfectly even; high = poppy)`);
  return deltas;
}

run('LINEAR', false);
run('EASED ', true);

// 2-row filmstrip at 6 positions
const cols = [0, 0.2, 0.4, 0.6, 0.8, 1];
const gap = 8, labelH = 22, w = 300, h = 200;
const strip = createCanvas(cols.length * w + (cols.length - 1) * gap, 2 * (h + labelH) + 12);
const sctx = strip.getContext('2d');
sctx.fillStyle = '#0d0f12';
sctx.fillRect(0, 0, strip.width, strip.height);
sctx.font = '14px sans-serif';
[['LINEAR', false, 0], ['EASED', true, h + labelH + 12]].forEach(([name, ease, yoff]) => {
  cols.forEach((p, i) => {
    renderAt(ease ? smoothstep(p) : p);
    const x = i * (w + gap);
    sctx.fillStyle = '#ffb066';
    sctx.fillText(`${name} p=${p.toFixed(1)}`, x + 4, yoff + 15);
    sctx.drawImage(display, x, yoff + labelH, w, h);
  });
});
await writeFile(join(OUT, 'scrub-compare.png'), strip.toBuffer('image/png'));
console.log('\nwrote validate/out/transition/scrub-compare.png');
