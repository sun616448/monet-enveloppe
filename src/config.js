// The reference palette, auto-discovered from public/monet-refs at build time
// (see the `monet-refs` plugin in vite.config.js). A single set of paintings
// sharing a colour palette, ordered by filename and, at runtime, spaced evenly
// across the day so the slider drifts smoothly through the palette. Shape:
//   REFERENCES: [{ src, title }, ...]
export { REFERENCES } from 'virtual:monet-refs';

export const DEFAULT_CONTENT = 'sample.jpg';

// --- Model selection ---------------------------------------------------------
// Two-network arbitrary stylization (Ghiasi et al.), tfjs port by R. Nakano.
// The STYLE predictor runs only N times at load (once per reference), so we can
// afford the high-quality Inception model with zero per-frame cost.
// The TRANSFORM net runs every frame; the full (non-separable) model looks
// noticeably better. Swap to the "_separable" URL if you need more speed.
const MODEL_CDN =
  'https://cdn.jsdelivr.net/gh/reiinakano/arbitrary-image-stylization-tfjs@master';
export const STYLE_MODEL_URL = `${MODEL_CDN}/saved_model_style_inception_js/model.json`;
export const TRANSFORM_MODEL_URL = `${MODEL_CDN}/saved_model_transformer_js/model.json`;

// Default stylization strength (0..1). 1 = full Monet, lower blends in the
// photo's own colours/structure to tame muddy mid-interpolation results.
export const DEFAULT_STRENGTH = 1.0;

// Default "palette match" (0..1): how strongly the stylized output's colours
// are pulled toward the real painting's palette (Reinhard colour transfer).
// The style net nails brushwork but its colours drift; this restores fidelity.
export const DEFAULT_PALETTE_MATCH = 0.6;

// Longest edge (px) the content image is downscaled to before stylizing.
// Smaller = faster frames. 384 is standard for this model family.
export const MAX_CONTENT_SIZE = 384;

// Longest edge (px) a STYLE/reference painting is downscaled to before its
// style vector is extracted. Smaller -> brushstrokes are proportionally larger
// in the painting, so the output looks more painterly/impressionist. ~320-384
// is a good range for Monet. (This only affects style extraction, not speed.)
export const STYLE_SIZE = 352;

// Seconds for the auto-play "play" button to sweep a full 24h day.
export const DAY_SWEEP_SECONDS = 20;
