// ISSUE 4 — mid-segment "busyness": at ~t=0.5 the A→B base blend reads as a
// muddy, low-contrast double-exposure (two different paintings averaged). The
// dabs sit on top of this base, so if the BASE blend reads clean, the whole
// transition does. This isolates the base blend (no dabs) and compares:
//   S0 NAIVE  : per-pixel linear lerp(A,B,t)           (today's behaviour)
//   S1 DETAIL : smooth colour lerp + detail (high-freq) from ONE source only
//               (hard switch at 0.5) — a cheap gradient-domain approximation:
//               blend low freqs, never superimpose two stroke fields.
//   S2 CONTRAST: linear lerp, then restore global per-channel contrast (std)
//               back toward lerp(stdA,stdB) — counters averaging's mush.
//
// Run: node validate/issue4-blend.mjs   Out: validate/out/transition/blend-compare.png
import { createCanvas, loadImage, ImageData as NapiImageData } from '@napi-rs/canvas';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REL = join(HERE, 'out', 'relight');
const OUT = join(HERE, 'out', 'transition');
await mkdir(OUT, { recursive: true });

const W = 540, H = 360;
function frame(img) {
  const c = createCanvas(W, H);
  c.getContext('2d').drawImage(img, 0, 0, W, H);
  return c.getContext('2d').getImageData(0, 0, W, H);
}
const A = frame(await loadImage(join(REL, 'midday.png')));
const B = frame(await loadImage(join(REL, 'new-dusk.png')));

// cheap separable-ish blur via downscale→upscale (browser-fast equivalent)
function blur(imageData, factor = 10) {
  const c = createCanvas(W, H);
  c.getContext('2d').putImageData(imageData, 0, 0);
  const sw = Math.max(1, Math.round(W / factor)), sh = Math.max(1, Math.round(H / factor));
  const small = createCanvas(sw, sh);
  const sctx = small.getContext('2d');
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(c, 0, 0, sw, sh);
  const out = createCanvas(W, H);
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.drawImage(small, 0, 0, W, H);
  return octx.getImageData(0, 0, W, H);
}
const lowA = blur(A), lowB = blur(B);

function stats(d) {
  const n = d.length / 4, sum = [0, 0, 0], sq = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) { sum[c] += d[i + c]; sq[c] += d[i + c] * d[i + c]; }
  const mean = sum.map((s) => s / n);
  return { mean, std: sq.map((s, c) => Math.sqrt(Math.max(0, s / n - mean[c] * mean[c]))) };
}
const sA = stats(A.data), sB = stats(B.data);

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

function naive(t) {
  const out = new NapiImageData(W, H);
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) out.data[i + c] = clamp(A.data[i + c] * (1 - t) + B.data[i + c] * t);
    out.data[i + 3] = 255;
  }
  return out;
}

// smooth colour field lerps A→B; detail (img - blur) comes from ONE source,
// hard-switched at t=0.5 → never two stroke fields at once.
function detailOne(t) {
  const out = new NapiImageData(W, H);
  const useB = t >= 0.5;
  const src = useB ? B.data : A.data, low = useB ? lowB.data : lowA.data;
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const colour = lowA.data[i + c] * (1 - t) + lowB.data[i + c] * t;
      const detail = src[i + c] - low[i + c];
      out.data[i + c] = clamp(colour + detail);
    }
    out.data[i + 3] = 255;
  }
  return out;
}

// linear lerp, then renormalise each channel's contrast back to lerp(std).
function contrast(t) {
  const out = naive(t);
  const sN = stats(out.data);
  const tgtMean = sA.mean.map((m, c) => m * (1 - t) + sB.mean[c] * t);
  const tgtStd = sA.std.map((s, c) => s * (1 - t) + sB.std[c] * t);
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const g = tgtStd[c] / Math.max(1, sN.std[c]);
      out.data[i + c] = clamp((out.data[i + c] - sN.mean[c]) * g + tgtMean[c]);
    }
  }
  return out;
}

const STRATS = [['S0 NAIVE', naive], ['S1 DETAIL', detailOne], ['S2 CONTRAST', contrast]];
const TS = [0.3, 0.5, 0.7];
const gap = 8, labelH = 22, lblW = 96;
const strip = createCanvas(lblW + TS.length * W + (TS.length - 1) * gap, STRATS.length * (H + gap) + labelH);
const sctx = strip.getContext('2d');
sctx.fillStyle = '#0d0f12';
sctx.fillRect(0, 0, strip.width, strip.height);
sctx.font = '15px sans-serif';
sctx.fillStyle = '#ffb066';
TS.forEach((t, i) => sctx.fillText(`t = ${t}`, lblW + i * (W + gap) + 6, 16));
STRATS.forEach(([name, fn], r) => {
  const y = labelH + r * (H + gap);
  sctx.fillStyle = '#ffb066';
  sctx.fillText(name, 4, y + 18);
  TS.forEach((t, i) => {
    const tmp = createCanvas(W, H);
    tmp.getContext('2d').putImageData(fn(t), 0, 0);
    sctx.drawImage(tmp, lblW + i * (W + gap), y);
  });
});
await writeFile(join(OUT, 'blend-compare.png'), strip.toBuffer('image/png'));
console.log('wrote validate/out/transition/blend-compare.png');
