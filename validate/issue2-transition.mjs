// ISSUE 2 — the brushstroke REPAINT transition is the reveal of frame B over
// frame A stroke-by-stroke on scrub; it does not exist in a static frame. This
// drives the ACTUAL src/repaint.js module (headless, via @napi-rs/canvas) on two
// REAL adjacent gpt-image-2 keyframes and emits a filmstrip of the scrub at
// t = 0, .15, .35, .55, .75, 1 — so the transition mechanic can be judged on
// real frames. Uses the real-light midday → dusk pair from issue3.
//
// Run: node validate/issue2-transition.mjs   Out: validate/out/transition/*
import { createCanvas, loadImage, ImageData as NapiImageData } from '@napi-rs/canvas';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// minimal DOM shim so the browser module runs unchanged in node
globalThis.document = { createElement: (t) => { if (t === 'canvas') return createCanvas(1, 1); throw new Error('shim: only canvas'); } };
globalThis.ImageData = NapiImageData;
const { createRepaint } = await import('../src/repaint.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const REL = join(HERE, 'out', 'relight');
const OUT = join(HERE, 'out', 'transition');
const { mkdir } = await import('node:fs/promises');
await mkdir(OUT, { recursive: true });

const W = 540, H = 360;
function toCanvas(img) {
  const c = createCanvas(W, H);
  c.getContext('2d').drawImage(img, 0, 0, W, H);
  return c;
}

const A = toCanvas(await loadImage(join(REL, 'midday.png')));   // frame A
const B = toCanvas(await loadImage(join(REL, 'new-dusk.png'))); // frame B (real-light)

const display = createCanvas(W, H);
const repaint = createRepaint(display, { dens: 1.0, size: 1.0, fade: 0.06 });
repaint.resize(W, H);
repaint.setFrames(A, B);

const TS = [0, 0.15, 0.35, 0.55, 0.75, 1];
const gap = 10, labelH = 26;
const strip = createCanvas(TS.length * W + (TS.length - 1) * gap, H + labelH);
const sctx = strip.getContext('2d');
sctx.fillStyle = '#0d0f12';
sctx.fillRect(0, 0, strip.width, strip.height);
sctx.fillStyle = '#ffb066';
sctx.font = '18px sans-serif';

TS.forEach((t, i) => {
  repaint.render(t);
  const x = i * (W + gap);
  sctx.drawImage(display, x, labelH);
  sctx.fillText(`t = ${t.toFixed(2)}`, x + 6, 19);
  // also save the mid-scrub still full-size for a close look
  if (t === 0.55) writeFile(join(OUT, 'mid-scrub.png'), display.toBuffer('image/png'));
});

await writeFile(join(OUT, 'filmstrip.png'), strip.toBuffer('image/png'));
console.log('wrote validate/out/transition/filmstrip.png (real repaint.js, real keyframes) + mid-scrub.png');
