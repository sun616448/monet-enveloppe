// App configuration for the hosted-keyframe engine (see writeup §4).
//
// The live app no longer runs the client-side Gatys optimization. Instead:
//   - a curated gallery of relit-keyframe Scenes is the always-on default view;
//   - "Try your own photo" POSTs to /api/enveloppe, which returns N keyframes
//     (gpt-image-2: one base generation + N-1 edit-of-base relights);
//   - a keyframe timeline drives the brushstroke repaint between adjacent
//     keyframes, with color.js doing the fine colour drift within each segment.
//
// gatys.js / vgg.js remain on disk (writeup history) but are no longer imported.

// Curated fallback gallery manifest (static asset under public/).
export const GALLERY_MANIFEST = 'gallery/manifest.json';

// Live keyframe-generation endpoint (Vercel serverless function).
export const API_ENDPOINT = '/api/enveloppe';

// N=3 GENERATED keyframes: midday / dusk / NIGHT. Midday is the BASE generation;
// dusk and night are EDIT-OF-BASE relights of it (this is what kept them
// consistent in validation — do not regress to from-photo generation). NIGHT is a
// real generation because genuine night needs invented dark content — moonlight,
// lit windows — a tonal filter can't fake (validated: night-from-dusk read as
// "underexposed", real night reads as night). DAWN is the DERIVED frame (below).
// `light` doubles as the offline-recolor key in scene.js.
export const KEYFRAMES = [
  { hour: 12, label: 'Midday', light: 'midday' },
  { hour: 18, label: 'Dusk', light: 'dusk' },
  { hour: 22, label: 'Night', light: 'night' },
];

// The 4th keyframe is DERIVED, not generated (keeps cost at N=3): DAWN is a free
// client-side tonal transform of the DUSK keyframe (see scene.js dawnFromCanvas).
// Dawn & dusk are both low-sun warm-light states, so leftover sun-glow is CORRECT
// here (unlike the failed night-from-dusk). But dawn is NOT just cooler dusk: a
// real transform LIFTS brightness (high-key morning), DE-ORANGES/cools (kills
// dusk's heavy orange, strongest in the sky highlights), desaturates the warm
// cast, and adds a cool ROSE bloom. The loop cycles dawn(6) -> midday(12) ->
// dusk(18) -> night(22) -> (wraps) dawn. Params = the "strong" variant validated
// in validate/issue7-dawn.mjs.
export const DAWN = {
  hour: 6,
  label: 'Dawn',
  gamma: 0.70,   // <1 brightens mids (high-key morning)
  lift: 1.12,    // overall brightness lift
  coolR: 0.80, coolG: 1.00, coolB: 1.30, // de-orange / cool (r down, b up)
  desat: 0.48,   // pale, fresher warm cast
  hiDesat: 0.55, // extra desaturation in the sky highlights (kill orange sky)
  hiCoolB: 0.28, // extra blue in the sky highlights
  roseHi: 0.60,  // luminance above which the rose bloom applies
  roseR: 0.04, roseB: 0.09, // cool rose bloom in highlights (rose, not orange)
  mistFloor: 0.06, // faint cool morning mist lifting the deepest shadows
};

export const QUALITY = 'medium'; // gpt-image-2 quality tier (validated: daubs survive)

// Longest edge (px) keyframes are drawn at for display + per-frame compositing —
// i.e. the WORKING resolution of the continuous repaint. Lowered from 880 so the
// always-on auto-advance holds a smooth framerate (the impressionist surface is
// soft, so the canvas upscaling to the stage is invisible). See perf note in
// validate/perf-browser.mjs.
export const DISPLAY_MAX_EDGE = 660;

// Longest edge (px) a user's photo is downscaled to before upload (the model
// processes at 1536x1024 regardless, so this just trims the request payload).
export const UPLOAD_MAX_EDGE = 1024;

// THE one tunable knob: seconds for the auto-advancing day to paint a full 24h
// loop (dawn→midday→dusk→night→dawn…). 30–60s is the sweet spot; adjust by feel.
export const DAY_SWEEP_SECONDS = 45;

// Within-segment colour drift strength (0..1): how strongly the not-yet-
// repainted regions of keyframe A are tinted toward keyframe B's palette as the
// scrub advances, so the light shifts everywhere while the strokes redraw.
export const DEFAULT_DRIFT = 0.65;

// Brushstroke repaint knobs (see src/repaint.js). MAX-DABS tuning: density pushed
// up hard (dab count ~5× the old 0.9) and size trimmed so the many smaller dabs
// still read as DISTINCT strokes, not a solid smear; the richer brush sprite
// (makeBrush) carries the bristle/dry-brush texture. budget raised so a scrub's
// catch-up commits keep pace with the larger stroke count.
//   Why this is safe on perf: the accumulation/dab-budget design (repaint.js)
//   makes per-frame cost dominated by the FIXED full-canvas recolor+composites,
//   not the dab count — measured FLAT fps from dens 0.9 → 2.1 in real Chrome
//   (validate/fps-probe.mjs). So the ceiling here is VISUAL, not framerate: past
//   ~2.1 the strokes get so fine they read as noise. 2.1 = densest that still
//   reads as brushwork (validate/capture-dabs.mjs crops).
export const REPAINT = { dens: 2.1, size: 0.95, fade: 0.06, ang: 0.5, oj: 0.12, budget: 180 };
