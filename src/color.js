// Plain-JS colour maths for the per-frame compositing. The heavy stylization
// is done once by the Gatys optimization (see gatys.js); everything here is
// cheap per-pixel work that runs every frame as the time-of-day slider moves.
//
// All channel stats are kept in the 0..255 domain to avoid rescaling.

// Per-channel mean & standard deviation of an ImageData. Returns
// { mean:[r,g,b], std:[r,g,b] } in 0..255. Captures a painting's colour "key".
export function imageStats(imageData) {
  const { data } = imageData;
  const n = data.length / 4;
  const sum = [0, 0, 0];
  const sumSq = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = data[i + c];
      sum[c] += v;
      sumSq[c] += v * v;
    }
  }
  const mean = sum.map((s) => s / n);
  const std = sumSq.map((sq, c) => Math.sqrt(Math.max(0, sq / n - mean[c] * mean[c])));
  return { mean, std };
}

// Compute colour stats straight from an image/canvas by drawing it small.
export function statsFromImage(image, size = 128) {
  const sw = image.naturalWidth || image.width;
  const sh = image.naturalHeight || image.height;
  const scale = Math.min(1, size / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(image, 0, 0, w, h);
  return imageStats(c.getContext('2d').getImageData(0, 0, w, h));
}

// Component-wise lerp of two { mean:[3], std:[3] } stats.
export function lerpStats(sa, sb, t) {
  const mix = (x, y) => x.map((v, i) => v * (1 - t) + y[i] * t);
  return { mean: mix(sa.mean, sb.mean), std: mix(sa.std, sb.std) };
}

// Build one display frame, writing into `out` (an ImageData sized like base).
//   base      – the stylized painting (ImageData)
//   baseStats – imageStats(base), precomputed once when base changes
//   orig      – the original photo (ImageData), for the strength cross-fade
//   target    – { mean, std } palette to tint colours toward (this hour)
//   paletteAmount – 0..1 strength of the per-hour colour tint
//   strength      – 0..1 cross-fade between original photo (0) and painting (1)
//
// We tint with a MEAN-ONLY shift (per-channel colour cast) rather than a full
// Reinhard transfer: matching the painting's standard deviation to a reference
// crushes its contrast toward whatever the reference happens to be (some Monet
// palettes are very low-contrast), washing the painting out. A mean shift moves
// the colour/temperature by hour while preserving the painting's own contrast
// and brushwork.
export function composeFrame(out, base, baseStats, orig, target, paletteAmount, strength) {
  const b = base.data;
  const o = orig.data;
  const d = out.data;
  const { mean: bMean } = baseStats;
  const shift = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    shift[c] = (target.mean[c] - bMean[c]) * paletteAmount;
  }
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = (b[i + c] + shift[c]) * strength + o[i + c] * (1 - strength);
      d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    d[i + 3] = 255;
  }
  return out;
}
