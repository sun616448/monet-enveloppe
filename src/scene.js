// Scene model + loader. A Scene is the single shape the app renders:
//   { id, title, placeholder:bool, dims:{w,h}, keyframes:[{hour,label,canvas,imageData,stats}] }
// keyframes are sorted by hour and drawn at identical display dimensions, so the
// repaint module's same-size A/B requirement always holds.
//
// THREE sources, all normalized to that same Scene:
//   1. real keyframe URLs  — what a live /api/enveloppe upload returns, and what
//      your hand-picked gallery scenes will be (asset swap, no code change).
//   2. placeholder recolor — synthesize 3 lighting variants client-side from one
//      source image, so the gallery is never empty before real scenes exist.
//   3. offline upload      — same recolor path applied to a user's uploaded photo
//      when the live API is unavailable (local dev / cap hit), so the upload UX
//      is never broken.
import { imageStats } from './color.js';
import { DAWN } from './config.js';

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

// Display dimensions for a source image: longest edge <= maxEdge, aspect kept.
function fitDims(img, maxEdge) {
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  return { w: Math.max(1, Math.round(sw * scale)), h: Math.max(1, Math.round(sh * scale)) };
}

function drawTo(img, dims) {
  const c = document.createElement('canvas');
  c.width = dims.w;
  c.height = dims.h;
  c.getContext('2d').drawImage(img, 0, 0, dims.w, dims.h);
  return c;
}

// ---- placeholder recolors (clearly NOT real relights; for demo only) --------
// A 'color' blend imposes a hue while keeping the source's light/dark, so the
// three frames read as unmistakably different times of day.
const fill = (ctx, W, H, mode, style, alpha) => {
  ctx.save();
  ctx.globalCompositeOperation = mode;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = style;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
};
export const RECOLORS = {
  dawn: (ctx, W, H) => {
    fill(ctx, W, H, 'color', '#7d6fa6', 0.32); // cool lavender-grey
    fill(ctx, W, H, 'screen', '#ffd9b0', 0.1);
    fill(ctx, W, H, 'source-over', 'rgba(40,44,78,0.12)', 1);
  },
  midday: (ctx, W, H) => {
    fill(ctx, W, H, 'screen', '#bfe0ff', 0.1); // bright cool daylight
    fill(ctx, W, H, 'source-over', 'rgba(255,250,235,0.05)', 1);
  },
  dusk: (ctx, W, H) => {
    fill(ctx, W, H, 'color', '#ff7e2e', 0.5); // warm golden hour
    fill(ctx, W, H, 'screen', '#ff7a1a', 0.14);
    fill(ctx, W, H, 'source-over', 'rgba(50,15,20,0.16)', 1);
  },
  night: (ctx, W, H) => {
    fill(ctx, W, H, 'color', '#2c3f86', 0.62); // deep moonlit blue
    fill(ctx, W, H, 'source-over', 'rgba(8,12,34,0.42)', 1); // darken toward night
    fill(ctx, W, H, 'screen', '#3a4f9a', 0.08); // faint cool ambient
  },
};

// ---- derived DAWN keyframe --------------------------------------------------
// Synthesize a fresh cool morning from a DUSK canvas via a real tonal transform
// (see config.DAWN), NOT a flat tint. Dawn & dusk share low-sun warm light so
// leftover sun-glow is fine, but dawn LIFTS brightness (high-key), DE-ORANGES /
// cools (strongest in the sky highlights), desaturates the warm cast, and adds a
// cool rose bloom. Returns a new canvas the same size as `src`.
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const smooth01 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export function dawnFromCanvas(src) {
  const w = src.width, h = src.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const id = ctx.getImageData(0, 0, w, h), d = id.data;
  const p = DAWN;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const L = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    const hi = smooth01(p.roseHi, 1.0, L); // highlight weight (the orange sky lives here)
    // brightness lift: high-key morning (brighten mids, raise overall)
    const lifted = Math.min(1, Math.pow(L, p.gamma) * p.lift);
    const k = lifted / Math.max(L, 1e-3);
    let cr = r * k, cg = g * k, cb = b * k;
    // cool / de-orange: pull red down, push blue up; extra blue in the sky highlights
    cr *= p.coolR; cg *= p.coolG; cb *= (p.coolB + p.hiCoolB * hi);
    // desaturate the warm cast toward grey — stronger in the highlights
    const ds = p.desat + p.hiDesat * hi;
    cr = cr * (1 - ds) + lifted * ds;
    cg = cg * (1 - ds) + lifted * ds;
    cb = cb * (1 - ds) + lifted * ds;
    // cool ROSE bloom in highlights — rose, not orange
    cr += p.roseR * hi; cb += p.roseB * hi;
    // faint cool morning mist lifting the deepest shadows
    cr += p.mistFloor * (1 - lifted) * 0.6;
    cg += p.mistFloor * (1 - lifted) * 0.7;
    cb += p.mistFloor * (1 - lifted) * 1.0;
    d[i] = clamp255(cr * 255);
    d[i + 1] = clamp255(cg * 255);
    d[i + 2] = clamp255(cb * 255);
  }
  ctx.putImageData(id, 0, 0);
  return out;
}

// Append the derived dawn keyframe (from the DUSK frame) so every Scene — real,
// placeholder, or offline — has all four anchors with only 3 generated.
function appendDawn(frames) {
  if (!DAWN || frames.some((f) => f.label === DAWN.label)) return frames;
  const dusk = frames.find((f) => f.label === 'Dusk') || frames.reduce((a, b) => (b.hour > a.hour ? b : a));
  frames.push({ hour: DAWN.hour, label: DAWN.label, canvas: dawnFromCanvas(dusk.canvas) });
  return frames;
}

// Attach imageData + colour stats to each keyframe canvas and finalize a Scene.
function finalize(id, title, placeholder, frames) {
  appendDawn(frames);
  for (const f of frames) {
    const ctx = f.canvas.getContext('2d');
    f.imageData = ctx.getImageData(0, 0, f.canvas.width, f.canvas.height);
    f.stats = imageStats(f.imageData);
  }
  frames.sort((a, b) => a.hour - b.hour);
  return {
    id,
    title,
    placeholder,
    dims: { w: frames[0].canvas.width, h: frames[0].canvas.height },
    keyframes: frames,
  };
}

// Synthesize keyframes from one source image via per-frame recolor specs.
function recolorFrames(img, dims, specs) {
  return specs.map((s) => {
    const canvas = drawTo(img, dims);
    const fn = RECOLORS[s.recolor || s.light];
    if (fn) fn(canvas.getContext('2d'), dims.w, dims.h);
    return { hour: s.hour, label: s.label, canvas };
  });
}

// Load a gallery manifest descriptor (real-keyframe OR placeholder) into a Scene.
export async function loadScene(desc, maxEdge) {
  if (desc.keyframes) {
    const imgs = await Promise.all(desc.keyframes.map((k) => loadImage(k.url)));
    const dims = fitDims(imgs[0], maxEdge);
    const frames = desc.keyframes.map((k, i) => ({
      hour: k.hour,
      label: k.label,
      canvas: drawTo(imgs[i], dims),
    }));
    return finalize(desc.id, desc.title, false, frames);
  }
  if (desc.placeholder) {
    const img = await loadImage(desc.placeholder.from);
    const dims = fitDims(img, maxEdge);
    return finalize(desc.id, desc.title, true, recolorFrames(img, dims, desc.placeholder.frames));
  }
  throw new Error(`Scene "${desc.id}" has neither keyframes nor placeholder.`);
}

// Offline preview Scene from an uploaded photo (recolor fallback when the live
// API is unavailable). `keyframeSpecs` are [{hour,label,light}] from config.
export async function offlineSceneFromImage(img, maxEdge, keyframeSpecs) {
  const dims = fitDims(img, maxEdge);
  const specs = keyframeSpecs.map((k) => ({ hour: k.hour, label: k.label, recolor: k.light }));
  return finalize('upload', 'Your scene (offline preview)', true, recolorFrames(img, dims, specs));
}
