// VGG19 convolutional feature extractor (up to conv5_1) in TensorFlow.js,
// built from raw weights exported by convert/export_vgg.py. We implement the
// forward pass with tf.conv2d so it's fully differentiable — Gatys style
// transfer optimizes the image through these features.
import * as tf from '@tensorflow/tfjs';

// VGG19 topology up to conv5_1: convs per block, maxpool after blocks 1-4.
const BLOCKS = [2, 2, 4, 4, 1];

// Global conv indices (0-based, across all blocks) whose POST-conv (pre-relu)
// activations Gatys uses. conv1_1=0, conv2_1=2, conv3_1=4, conv4_1=8,
// conv4_2=9 (content), conv5_1=12.
export const STYLE_LAYERS = [0, 2, 4, 8, 12];
export const CONTENT_LAYER = 9;

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

let weights = null; // tf.Tensor4D[] filters [kh,kw,inC,outC]
let biases = null;  // tf.Tensor1D[]

export async function loadVgg(jsonUrl, binUrl, onProgress) {
  const manifest = await (await fetch(jsonUrl)).json();
  const buf = await fetchWithProgress(binUrl, onProgress);
  const data = new Float32Array(buf);

  weights = [];
  biases = [];
  let off = 0;
  for (const layer of manifest.layers) {
    const [kh, kw, inC, outC] = layer.shape;
    const wCount = kh * kw * inC * outC;
    weights.push(tf.tensor4d(data.subarray(off, off + wCount), [kh, kw, inC, outC]));
    off += wCount;
    biases.push(tf.tensor1d(data.subarray(off, off + outC)));
    off += outC;
  }
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return await res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received / total);
  }
  const out = new Uint8Array(received);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out.buffer;
}

// Normalize an image tensor in [0,1], NHWC RGB, to VGG's ImageNet space.
export function preprocess(img) {
  return tf.tidy(() =>
    img.sub(tf.tensor1d(IMAGENET_MEAN)).div(tf.tensor1d(IMAGENET_STD))
  );
}

// Forward pass capturing the POST-conv (pre-relu) activations whose global
// conv index is in `capture` (a Set). Returns { [convIndex]: tensor }. Must be
// called inside a tf graph/tidy owned by the caller.
export function vggForward(imgNormalized, capture) {
  const caps = {};
  let x = imgNormalized;
  let ci = 0;
  for (let b = 0; b < BLOCKS.length; b++) {
    for (let k = 0; k < BLOCKS[b]; k++) {
      x = tf.conv2d(x, weights[ci], 1, 'same');
      x = tf.add(x, biases[ci]);
      if (capture.has(ci)) caps[ci] = x;
      x = tf.relu(x);
      ci++;
    }
    if (b < BLOCKS.length - 1) x = tf.maxPool(x, 2, 2, 'valid');
  }
  return caps;
}

// Gram matrix of a feature map [1,h,w,c], normalized by c*h*w (matches the
// Python reference in convert/gatys.py).
export function gram(feat) {
  const [, h, w, c] = feat.shape;
  const m = feat.reshape([h * w, c]);
  return tf.matMul(m, m, true, false).div(c * h * w);
}

export function vggReady() {
  return weights != null;
}
