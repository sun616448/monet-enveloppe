// ISSUE 9 — idle "breathing": confirm (a) it's SURFACE-alive not image-changing,
// (b) it's a local sheen not a global pulse, (c) it's cheap per frame. Drives the
// REAL src/repaint.js beginIdle()/breathe() on a real keyframe at display size.
// Outputs proof + numbers:
//   - still.png       : one idle frame (must look like the painting, unchanged)
//   - heatmap.png     : |frame(t1) - frame(t0)| x12 — where sheen moved (sparse,
//                       scattered = surface life; NOT a uniform wash = not global)
//   - prints: dab count, dabs/frame, ms/frame (CPU upper bound), and the global
//     mean-luma spread over 2 s (near-zero ⇒ no global pulse/flicker).
// Run: node validate/issue9-breathe.mjs   Out: validate/out/breathe/*
import { createCanvas, loadImage, ImageData as NapiImageData } from '@napi-rs/canvas';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

globalThis.document = { createElement: () => createCanvas(1, 1) };
globalThis.ImageData = NapiImageData;
const { createRepaint } = await import('../src/repaint.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out', 'breathe');
await mkdir(OUT, { recursive: true });

// display size for the tubingen scene (1100x733 → longest edge 880)
const W = 880, H = 587;
const disp = createCanvas(W, H);
const dctx = disp.getContext('2d');
const base = createCanvas(W, H);
base.getContext('2d').drawImage(await loadImage(join(HERE, '..', 'public', 'gallery', 'tubingen', 'dusk.jpg')), 0, 0, W, H);

const rp = createRepaint(disp, {});
rp.resize(W, H);
// put the stable frame on the display, then snapshot it as the idle base
dctx.drawImage(base, 0, 0);
rp.beginIdle();

const grab = () => dctx.getImageData(0, 0, W, H).data;
const meanLuma = (d) => { let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; return s / (d.length / 4); };

const dt = 1000 / 60;

// (1) COST: a clean tight loop timing ONLY breathe() — no getImageData pollution.
let touched = 0;
const COST_FRAMES = 600;
const tStart = performance.now();
for (let f = 0; f < COST_FRAMES; f++) touched = rp.breathe(f * dt);
const msPerFrame = (performance.now() - tStart) / COST_FRAMES;
const ops = touched * 2;

// (2) PROOF: replay, sampling frames for the heatmap + global-luma flatness.
let t0grab = null, t1grab = null;
const lumas = [];
for (let f = 0; f < 120; f++) {
  rp.breathe(f * dt);
  if (f === 6) t0grab = Uint8ClampedArray.from(grab());
  if (f === 60) t1grab = Uint8ClampedArray.from(grab());
  if (f % 6 === 0) lumas.push(meanLuma(grab()));
}

// still
await writeFile(join(OUT, 'still.png'), disp.toBuffer('image/png'));

// heatmap of the sheen motion between two moments
const heat = createCanvas(W, H);
const hid = heat.getContext('2d').createImageData(W, H), hd = hid.data;
let maxd = 0;
for (let i = 0; i < hd.length; i += 4) {
  const dd = (Math.abs(t1grab[i] - t0grab[i]) + Math.abs(t1grab[i + 1] - t0grab[i + 1]) + Math.abs(t1grab[i + 2] - t0grab[i + 2])) / 3;
  if (dd > maxd) maxd = dd;
  const v = Math.min(255, dd * 12);
  hd[i] = v; hd[i + 1] = v * 0.6; hd[i + 2] = v * 0.2; hd[i + 3] = 255; // amber on black
}
heat.getContext('2d').putImageData(hid, 0, 0);
await writeFile(join(OUT, 'heatmap.png'), heat.toBuffer('image/png'));

const N = Math.round((W / 58) * (H / 58));
const lumaSpread = Math.max(...lumas) - Math.min(...lumas);
console.log(`dabs total ≈ ${N} | dabs/frame = ${touched} (${(touched / N * 100 | 0)}% refreshed each frame, full cycle ${(N / touched).toFixed(1)} frames ≈ ${(N / touched / 60).toFixed(2)} s)`);
console.log(`per-frame work: ${ops} small drawImages (${touched} restores + ${touched} sheen stamps), each within a ~50px box`);
console.log(`CPU cost: ${msPerFrame.toFixed(3)} ms/frame in node skia (SOFTWARE rasteriser — a loose upper bound). A browser 2D canvas is GPU-accelerated; ${ops} small blits/frame is sub-millisecond there and rAF-limited at 60fps.`);
console.log(`max per-pixel sheen delta (t0→t1): ${maxd.toFixed(1)}/255 (subtle, local)`);
console.log(`GLOBAL mean-luma spread over 2 s: ${lumaSpread.toFixed(3)}/255  (≈0 ⇒ NO global pulse/flicker)`);
console.log('wrote validate/out/breathe/still.png + heatmap.png');
