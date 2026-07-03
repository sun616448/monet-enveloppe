// Optimization-based (Gatys) neural style transfer in the browser. We optimize
// the pixels of an image to match a Monet painting's texture (Gram matrices at
// several VGG layers) while staying close to the photo's content (one deeper
// layer). This is the step that makes the result look like an actual painting
// rather than a filtered photo. Hyper-parameters are calibrated against the
// Python reference (convert/gatys.py).
import * as tf from '@tensorflow/tfjs';
import {
  loadVgg,
  preprocess,
  vggForward,
  gram,
  STYLE_LAYERS,
  CONTENT_LAYER,
  vggReady,
} from './vgg.js';

const CAPTURE = new Set([...STYLE_LAYERS, CONTENT_LAYER]);

// === TEMP INSTRUMENTATION (remove after diagnosis) ============================
// Toggle from the page/headless console: window.GATYS_DEBUG = true.
// Optional: window.GATYS_MAX_ITERS = 60 to cut a quick run for loss readings.
const DBG = () => {
  if (typeof window === 'undefined') return false;
  if (window.GATYS_DEBUG) return true;
  try {
    return new URLSearchParams(window.location.search).has('gatysdbg');
  } catch {
    return false;
  }
};
// =============================================================================

export async function loadStyleModel(jsonUrl, binUrl, onProgress) {
  await loadVgg(jsonUrl, binUrl, onProgress);
}

export function styleModelReady() {
  return vggReady();
}

// canvas -> [1,h,w,3] float tensor in [0,1].
function canvasToTensor(canvas) {
  return tf.tidy(() => tf.browser.fromPixels(canvas).toFloat().div(255).expandDims());
}

// Run style transfer. Returns an ImageData of the content's size.
//   contentCanvas / styleCanvas – same-sized canvases (multiples handled by app)
//   opts: { iterations, styleWeight, contentWeight, lr, onProgress }
export async function runGatys(contentCanvas, styleCanvas, opts = {}) {
  if (!styleModelReady()) throw new Error('Style model not loaded');
  const {
    iterations = 400,
    styleWeight = 1e6,
    contentWeight = 5,
    lr = 0.02,
    onProgress,
  } = opts;

  const content = canvasToTensor(contentCanvas);
  const style = canvasToTensor(styleCanvas);

  // Precompute targets (resident across the optimization loop).
  const styleTargets = tf.tidy(() => {
    const caps = vggForward(preprocess(style), CAPTURE);
    return STYLE_LAYERS.map((li) => tf.keep(gram(caps[li])));
  });
  const contentTarget = tf.tidy(() =>
    tf.keep(vggForward(preprocess(content), CAPTURE)[CONTENT_LAYER])
  );

  const img = tf.variable(content); // the image we optimize
  const optimizer = tf.train.adam(lr);

  // Returns the unweighted content/style loss terms; total = c*cw + s*sw.
  const lossTerms = () => {
    const caps = vggForward(preprocess(img.clipByValue(0, 1)), CAPTURE);
    let sLoss = tf.scalar(0);
    STYLE_LAYERS.forEach((li, k) => {
      sLoss = sLoss.add(gram(caps[li]).sub(styleTargets[k]).square().mean());
    });
    const cLoss = caps[CONTENT_LAYER].sub(contentTarget).square().mean();
    return { cLoss, sLoss };
  };

  const lossFn = () =>
    tf.tidy(() => {
      const { cLoss, sLoss } = lossTerms();
      return cLoss.mul(contentWeight).add(sLoss.mul(styleWeight));
    });

  // === TEMP INSTRUMENTATION (remove after diagnosis) ========================
  // Per-layer style-loss readout + content/style magnitude split. Read here so
  // we see the *in-context* ratio of the weighted terms, not the nominal weights.
  const debug = DBG();
  let iterCap = 0;
  if (debug && typeof window !== 'undefined') {
    iterCap =
      Number(window.GATYS_MAX_ITERS) ||
      Number(new URLSearchParams(window.location.search).get('gatysiters')) ||
      0;
  }
  const maxIters = iterCap ? Math.min(iterations, iterCap) : iterations;
  const logLoss = async (i) => {
    const terms = tf.tidy(() => {
      const caps = vggForward(preprocess(img.clipByValue(0, 1)), CAPTURE);
      const per = STYLE_LAYERS.map((li, k) =>
        gram(caps[li]).sub(styleTargets[k]).square().mean()
      );
      const s = per.reduce((a, b) => a.add(b), tf.scalar(0));
      const c = caps[CONTENT_LAYER].sub(contentTarget).square().mean();
      return {
        c, s,
        per: tf.stack(per),
        cW: c.mul(contentWeight),
        sW: s.mul(styleWeight),
      };
    });
    const [c, s, per, cW, sW] = await Promise.all([
      terms.c.data(), terms.s.data(), terms.per.data(),
      terms.cW.data(), terms.sW.data(),
    ]);
    tf.dispose(terms);
    const layerNames = ['c1_1', 'c2_1', 'c3_1', 'c4_1', 'c5_1'];
    const perStr = layerNames
      .map((n, k) => `${n}=${per[k].toExponential(2)}`)
      .join(' ');
    console.log(
      `[GATYS dbg] it=${String(i).padStart(3)} ` +
        `total=${(cW[0] + sW[0]).toExponential(3)} ` +
        `cW=${cW[0].toExponential(3)} sW=${sW[0].toExponential(3)} ` +
        `(sW/total=${(sW[0] / (cW[0] + sW[0]) * 100).toFixed(1)}%) | ` +
        `raw c=${c[0].toExponential(2)} s=${s[0].toExponential(2)} | ${perStr}`
    );
  };
  // =========================================================================

  for (let i = 0; i < maxIters; i++) {
    if (debug && (i === 0 || (i + 1) % 25 === 0)) await logLoss(i);
    optimizer.minimize(lossFn, false);
    if (i % 5 === 0) {
      onProgress?.((i + 1) / iterations);
      await tf.nextFrame(); // keep the UI alive and let the loader repaint
    }
  }
  if (debug) {
    await logLoss(maxIters);
    console.log('[GATYS dbg] done; backend=', tf.getBackend());
  }

  // Read back the optimized image.
  const w = contentCanvas.width;
  const h = contentCanvas.height;
  const clipped = tf.tidy(() => img.clipByValue(0, 1).squeeze());
  const pixels = await tf.browser.toPixels(clipped);
  clipped.dispose();

  // Cleanup.
  optimizer.dispose();
  img.dispose();
  content.dispose();
  style.dispose();
  contentTarget.dispose();
  styleTargets.forEach((t) => t.dispose());

  return new ImageData(pixels, w, h);
}
