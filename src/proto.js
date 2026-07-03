// THROWAWAY PROTOTYPE — do not wire into the production app.
// Question being answered: does a LIVE, perpetually-running Gatys optimization
// whose style target slowly drifts between two Monet haystacks read as elegant
// continuous re-painting, or as boiling/flickering shimmer (temporal
// incoherence)? The key lever under test is WARM-STARTING: the optimized image
// is a single persistent variable that is never re-initialized, so each frame
// is one more gradient step from the last frame rather than a fresh solve.
//
// Reuses vgg.js (read-only). gatys.js is untouched.
import * as tf from '@tensorflow/tfjs';
import {
  loadVgg,
  preprocess,
  vggForward,
  gram,
  STYLE_LAYERS,
  CONTENT_LAYER,
} from './vgg.js';

const VGG_JSON = 'models/vgg/vgg19_conv.json';
const VGG_BIN = 'models/vgg/vgg19_conv.bin';
const CONTENT_SRC = 'sample.jpg';
const REF_DAWN = 'monet-refs/HAYSTACK/claude-monet-french-wheatstacks-snow-effect-morning.jpg';
const REF_DUSK = 'monet-refs/HAYSTACK/monet-grainstack-sunset.jpg';

const RES = 224; // working longest-edge, multiple of 16 (VGG pools by 16x)
const STYLE_WEIGHT = 1e6;
const CAPTURE = new Set([...STYLE_LAYERS, CONTENT_LAYER]);

// live-tunable knobs (driven by the sidebar)
const knobs = { cycle: 24, lr: 0.02, cw: 5, spe: 1, running: true };

const $ = (id) => document.getElementById(id);
const setStatus = (s) => ($('status').textContent = s);

// --- image helpers ----------------------------------------------------------
function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('failed to load ' + src));
    img.src = src;
  });
}

// Draw an <img> into an offscreen canvas sized so its longest edge == RES,
// rounded to a multiple of 16, then return { canvas, w, h }.
function fitCanvas(img) {
  const scale = RES / Math.max(img.width, img.height);
  const w = Math.max(16, Math.round((img.width * scale) / 16) * 16);
  const h = Math.max(16, Math.round((img.height * scale) / 16) * 16);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return { canvas: c, w, h };
}

const toTensor = (canvas) =>
  tf.tidy(() => tf.browser.fromPixels(canvas).toFloat().div(255).expandDims());

// Gram targets are channel×channel, independent of spatial size, so the style
// image can be any resolution. We just resize it like the content for speed.
function styleGrams(styleCanvas) {
  return tf.tidy(() => {
    const caps = vggForward(preprocess(toTensor(styleCanvas)), CAPTURE);
    return STYLE_LAYERS.map((li) => tf.keep(gram(caps[li])));
  });
}

// smooth dawn->dusk->dawn ease in [0,1] (cosine, slow at the extremes)
const phaseAt = (tSec) =>
  (1 - Math.cos((2 * Math.PI * tSec) / knobs.cycle)) / 2;

async function main() {
  setStatus('starting tfjs…');
  await tf.ready();
  $('backend').textContent = tf.getBackend();
  $('resLbl').textContent = `${RES}px`;

  setStatus('loading VGG weights…');
  await loadVgg(VGG_JSON, VGG_BIN, (p) => setStatus(`VGG ${(p * 100) | 0}%`));

  setStatus('loading images…');
  const [contentImg, dawnImg, duskImg] = await Promise.all([
    loadImage(CONTENT_SRC),
    loadImage(REF_DAWN),
    loadImage(REF_DUSK),
  ]);
  $('refA').src = REF_DAWN;
  $('refB').src = REF_DUSK;

  const { canvas: contentCanvas, w, h } = fitCanvas(contentImg);
  const stage = $('stage');
  stage.width = w;
  stage.height = h;
  // upscale the small working canvas for display without changing pixels
  stage.style.width = Math.min(w * 2, 720) + 'px';
  const ctx = stage.getContext('2d');

  // persistent state — these survive across every frame (this IS the warm start)
  const content = toTensor(contentCanvas);
  const contentTarget = tf.tidy(() =>
    tf.keep(vggForward(preprocess(content), CAPTURE)[CONTENT_LAYER])
  );
  const gramsDawn = styleGrams(fitCanvas(dawnImg).canvas);
  const gramsDusk = styleGrams(fitCanvas(duskImg).canvas);

  let img = tf.variable(content.clone()); // the image we perpetually optimize
  let optimizer = tf.train.adam(knobs.lr);
  let lastLr = knobs.lr;

  // loss at a given phase t: content anchor + style toward the lerp of the two
  // refs' Gram matrices. Gradients flow only through `img`; the blended targets
  // are recomputed cheaply each call (channel×channel matrices are tiny).
  const lossFn = (t) => () =>
    tf.tidy(() => {
      const caps = vggForward(preprocess(img.clipByValue(0, 1)), CAPTURE);
      let sLoss = tf.scalar(0);
      STYLE_LAYERS.forEach((li, k) => {
        const target = gramsDawn[k].mul(1 - t).add(gramsDusk[k].mul(t));
        sLoss = sLoss.add(gram(caps[li]).sub(target).square().mean());
      });
      const cLoss = caps[CONTENT_LAYER].sub(contentTarget).square().mean();
      return cLoss.mul(knobs.cw).add(sLoss.mul(STYLE_WEIGHT));
    });

  async function draw() {
    const clipped = tf.tidy(() => img.clipByValue(0, 1).squeeze());
    const pixels = await tf.browser.toPixels(clipped);
    clipped.dispose();
    ctx.putImageData(new ImageData(pixels, w, h), 0, 0);
  }

  // --- the perpetual loop ---------------------------------------------------
  let iter = 0;
  const t0 = performance.now();
  let fpsT = t0;
  let fpsN = 0;

  async function frame() {
    if (knobs.running) {
      if (knobs.lr !== lastLr) {
        optimizer.dispose();
        optimizer = tf.train.adam(knobs.lr);
        lastLr = knobs.lr;
      }
      const elapsed = (performance.now() - t0) / 1000;
      const t = phaseAt(elapsed);
      for (let s = 0; s < knobs.spe; s++) {
        optimizer.minimize(lossFn(t), false);
        iter++;
      }
      await draw();

      // hud
      fpsN += knobs.spe;
      const now = performance.now();
      if (now - fpsT > 400) {
        $('fps').textContent = (fpsN / ((now - fpsT) / 1000)).toFixed(1);
        fpsT = now;
        fpsN = 0;
        $('iter').textContent = iter;
        const pct = (t * 100) | 0;
        $('phaseBar').style.width = pct + '%';
        $('phaseLbl').textContent =
          t < 0.5 ? `dawn ${100 - pct * 2 < 0 ? 0 : 100 - pct}%` : `dusk ${pct}%`;
      }
    }
    requestAnimationFrame(frame);
  }

  // --- controls -------------------------------------------------------------
  const bind = (id, key, fmt) => {
    const el = $(id);
    const lbl = $(id + 'Lbl');
    el.addEventListener('input', () => {
      knobs[key] = parseFloat(el.value);
      if (lbl) lbl.textContent = fmt ? fmt(knobs[key]) : el.value;
    });
  };
  bind('cycle', 'cycle');
  bind('lr', 'lr', (v) => v.toFixed(3));
  bind('cw', 'cw');
  bind('spe', 'spe');

  $('pause').addEventListener('click', () => {
    knobs.running = !knobs.running;
    $('pause').textContent = knobs.running ? 'Pause' : 'Resume';
  });
  $('reseed').addEventListener('click', () => {
    const fresh = content.clone();
    img.assign(fresh);
    fresh.dispose();
    iter = 0;
  });

  // record the stage canvas to a downloadable webm (so the user can judge on
  // their real GPU and share the clip)
  $('rec').addEventListener('click', () => {
    const stream = stage.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'proto-drift.webm';
      a.click();
      $('rec').textContent = '● Record 15s → webm';
    };
    rec.start();
    $('rec').textContent = '◉ recording…';
    setTimeout(() => rec.stop(), 15000);
  });

  setStatus('running — warm-started, never re-seeded unless you click.');
  await draw();
  requestAnimationFrame(frame);
}

main().catch((e) => {
  console.error(e);
  setStatus('error: ' + e.message);
});
