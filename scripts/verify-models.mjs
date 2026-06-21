import * as tf from '@tensorflow/tfjs';
import { STYLE_MODEL_URL as STYLE, TRANSFORM_MODEL_URL as TRANSFORM } from '../src/config.js';

const summarize = (m, name) => {
  console.log(`\n[${name}] loaded OK`);
  console.log('  inputs :', m.inputs.map((t) => `${t.name} ${JSON.stringify(t.shape)}`));
  console.log('  outputs:', m.outputs.map((t) => `${t.name} ${JSON.stringify(t.shape)}`));
};

try {
  const style = await tf.loadGraphModel(STYLE);
  summarize(style, 'style');
  const transform = await tf.loadGraphModel(TRANSFORM);
  summarize(transform, 'transform');
  console.log('\nLoaded with tfjs', tf.version.tfjs);

  // --- end-to-end execution test (mirrors the app's per-frame path) ---
  const H = 256;
  const W = 384;
  // Two fake "style images" -> two cached bottlenecks.
  const styleA = tf.randomUniform([1, 200, 200, 3]);
  const styleB = tf.randomUniform([1, 200, 200, 3]);
  const bnA = style.predict(styleA);
  const bnB = style.predict(styleB);
  console.log('\nbottleneck shape:', bnA.shape); // expect [1,1,1,100]

  // Interpolate (the heart of the envelope concept).
  const t = 0.35;
  const lerp = bnA.mul(tf.scalar(1 - t)).add(bnB.mul(tf.scalar(t)));

  // Forward pass: [content, interpolated bottleneck] -> stylized.
  const content = tf.randomUniform([1, H, W, 3]);
  const out = transform.predict([content, lerp]);
  const sq = out.squeeze();
  const min = sq.min().dataSync()[0];
  const max = sq.max().dataSync()[0];
  console.log('stylized shape:', sq.shape, ' value range:', min.toFixed(3), '..', max.toFixed(3));

  const okShape = sq.shape[0] === H && sq.shape[1] === W && sq.shape[2] === 3;
  const okRange = min >= -0.01 && max <= 1.01;
  if (!okShape || !okRange) throw new Error('Unexpected output shape/range');

  console.log('\nSUCCESS: predict -> interpolate -> transform pipeline works.');
} catch (e) {
  console.error('\nFAILED:', e.message);
  process.exit(1);
}
