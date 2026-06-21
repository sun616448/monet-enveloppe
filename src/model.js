import * as tf from '@tensorflow/tfjs';
import { STYLE_MODEL_URL, TRANSFORM_MODEL_URL } from './config.js';

// Two-network arbitrary image stylization (Ghiasi et al.), ported to tfjs by
// Reiichiro Nakano. We load the raw graph models directly (rather than the
// @magenta/image wrapper) because we need access to the 100-D style bottleneck
// vector to interpolate between styles per frame.
//
//   styleNet:     image            -> bottleneck [1,1,1,100]
//   transformNet: [image, bottleneck] -> stylized image [1,h,w,3]
const STYLE_URL = STYLE_MODEL_URL;
const TRANSFORM_URL = TRANSFORM_MODEL_URL;

let styleNet = null;
let transformNet = null;

export async function initBackend() {
  try {
    await tf.setBackend('webgl');
  } catch (e) {
    console.warn('WebGL backend unavailable, falling back to CPU.', e);
    await tf.setBackend('cpu');
  }
  await tf.ready();
  return tf.getBackend();
}

// Loads both networks. `onProgress(stage, fraction)` reports download progress.
export async function loadModels(onProgress) {
  styleNet = await tf.loadGraphModel(STYLE_URL, {
    onProgress: (f) => onProgress?.('style', f),
  });
  transformNet = await tf.loadGraphModel(TRANSFORM_URL, {
    onProgress: (f) => onProgress?.('transform', f),
  });
}

// Runs the style prediction network once on a style image. The returned
// bottleneck tensor is meant to be cached (do NOT dispose it between frames).
export function predictStyleBottleneck(styleImage) {
  return tf.tidy(() =>
    styleNet.predict(
      tf.browser.fromPixels(styleImage).toFloat().div(tf.scalar(255)).expandDims()
    )
  );
}

// Converts a source (canvas/image) into a resident content tensor in [0,1].
// Caller owns the tensor and should dispose it when replacing the content.
export function makeContentTensor(source) {
  return tf.tidy(() =>
    tf.browser.fromPixels(source).toFloat().div(tf.scalar(255)).expandDims()
  );
}

// Linear interpolation between two cached bottlenecks. Returns a NEW tensor
// that the caller must dispose after use.
export function lerpBottleneck(b0, b1, t) {
  return tf.tidy(() => b0.mul(tf.scalar(1 - t)).add(b1.mul(tf.scalar(t))));
}

// Blends a style bottleneck with the content image's own bottleneck. This is
// the standard "stylization strength" knob: strength=1 -> pure style,
// strength=0 -> the photo's own style (barely stylized). Returns a NEW tensor.
export function applyStrength(styleBottleneck, contentBottleneck, strength) {
  if (strength >= 1 || !contentBottleneck) return styleBottleneck.clone();
  return tf.tidy(() =>
    styleBottleneck
      .mul(tf.scalar(strength))
      .add(contentBottleneck.mul(tf.scalar(1 - strength)))
  );
}

// Per-channel mean & standard deviation of an image, in [0,1]. Captures a
// painting's overall palette (its colour "key"). Computed once per painting.
export function imageColorStats(source) {
  return tf.tidy(() => {
    const img =
      source instanceof tf.Tensor
        ? source
        : tf.browser.fromPixels(source).toFloat().div(tf.scalar(255));
    const { mean, variance } = tf.moments(img, [0, 1]); // reduce H,W -> [3]
    return {
      mean: Array.from(mean.dataSync()),
      std: Array.from(variance.sqrt().dataSync()),
    };
  });
}

// Reinhard colour transfer: re-centre/re-scale the stylized output so its
// per-channel mean/std match a target palette, then blend by `amount` (0..1).
// The style network captures Monet's brushwork well but its colours drift;
// this pulls them back to the real painting's palette. `out` is [h,w,3] in
// [0,1]. Returns a NEW tensor the caller must dispose.
export function matchPalette(out, targetMean, targetStd, amount) {
  if (amount <= 0) return out.clone();
  return tf.tidy(() => {
    const { mean, variance } = tf.moments(out, [0, 1]);
    const std = variance.sqrt().add(tf.scalar(1e-5));
    const tMean = tf.tensor1d(targetMean);
    const tStd = tf.tensor1d(targetStd);
    const matched = out.sub(mean).div(std).mul(tStd).add(tMean);
    const blended = out.mul(tf.scalar(1 - amount)).add(matched.mul(tf.scalar(amount)));
    return blended.clipByValue(0, 1);
  });
}

// Forward pass through the transform network. Returns a [h,w,3] tensor in [0,1]
// that the caller must dispose (typically right after tf.browser.toPixels).
export function stylize(contentTensor, bottleneck) {
  return tf.tidy(() => {
    const out = transformNet.predict([contentTensor, bottleneck]);
    return out.squeeze();
  });
}

export function numTensors() {
  return tf.memory().numTensors;
}
