// Brushstroke repaint-transition module — promoted from the repaint.html
// prototype (which proved the mechanic). Reveals frame B over frame A through
// textured, directional brush dabs in a content-INDEPENDENT reveal order (big
// coverage strokes first, fine strokes last) as progress `t` goes 0 → 1. Scrub
// back un-paints. Frames A and B must be same-size canvases — guaranteed here,
// since all keyframes of a scene are drawn at identical display dimensions.
//
// Deliberately NOT derived from image gradients: orienting strokes by content
// read as "melted plastic" in an earlier prototype. The reveal order is a fixed,
// deterministic flow-field + jitter, so forward and backward scrubbing match.

// Brush-dab layers, big coverage first → fine detail last. len/wid in px (scaled
// by the size knob); grid is placement spacing (scaled inversely by density).
// tlo..thi = where in the 0..1 scrub this layer reveals (overlapping windows so
// covered area grows steadily the whole way).
const LAYERS = [
  { len: 120, wid: 46, grid: 70, tlo: 0.0, thi: 0.85 }, // big wash
  { len: 76, wid: 28, grid: 46, tlo: 0.05, thi: 0.92 },
  { len: 44, wid: 17, grid: 30, tlo: 0.1, thi: 0.97 },
  { len: 24, wid: 10, grid: 18, tlo: 0.22, thi: 1.0 }, // fine detail
];

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

// White RGBA sprite whose ALPHA carries bristle streaks + dry-brush gaps + a
// soft tapered elliptical falloff. Length runs along +x, so a rotated stamp
// reads as a directional dab. Used as the reveal mask for B (and, at idle, as the
// sheen-dab footprint). Tuned for MORE apparent brushwork: pronounced bristle
// lines (two frequencies), more/deeper dry-brush gaps, and a firmer edge so each
// dab reads as a discrete loaded-brush stroke rather than a soft smear.
function makeBrush(seed) {
  const w = 168, h = 72;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h), d = id.data;
  const rand = rng(seed);
  const cx = w / 2, cy = h / 2, a = w * 0.47, b = h * 0.44;
  // per-row bristle gain: more variation + more/deeper dry-brush gaps (the white
  // channels between bristles that make dry-brush read as dry-brush).
  const rowGain = new Float32Array(h);
  for (let y = 0; y < h; y++) rowGain[y] = 0.28 + 0.72 * rand();
  const ngap = 6 + ((rand() * 5) | 0);
  for (let k = 0; k < ngap; k++) rowGain[(rand() * h) | 0] *= 0.08;
  const phase = rand() * 6.28, phase2 = rand() * 6.28;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x - cx) / a, ny = (y - cy) / b;
      const r = Math.sqrt(nx * nx + ny * ny);
      let al = r < 1 ? Math.pow(1 - r, 0.7) : 0; // firmer edge (was 0.85)
      // two-frequency bristle streaking: a broad drag + a fine bristle grain.
      const streak =
        0.58 +
        0.30 * Math.sin(x * 0.16 + phase + y * 0.6) +
        0.18 * Math.sin(x * 0.42 + phase2 + y * 1.1);
      const grain = 0.78 + 0.22 * rand();
      al *= rowGain[y] * (streak < 0 ? 0 : streak) * grain;
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = Math.max(0, Math.min(255, al * 255)) | 0;
    }
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

// Gentle content-INDEPENDENT flow field for dab orientation.
const flowAngle = (x, y) => 0.55 * Math.sin(x * 0.0065) + 0.4 * Math.cos(y * 0.009) - 0.25;

// Cheap large-radius blur via downscale→upscale (one bilinear pass each way).
// Used to split a frame into low-frequency (light/colour) vs high-frequency
// (brushstroke) bands. Browser- and node-canvas-fast; runs once per segment.
function blurData(srcCanvas, W, H, factor = 12) {
  const sw = Math.max(1, Math.round(W / factor));
  const sh = Math.max(1, Math.round(H / factor));
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext('2d');
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(srcCanvas, 0, 0, sw, sh);
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.drawImage(small, 0, 0, W, H);
  return octx.getImageData(0, 0, W, H).data;
}

export function createRepaint(displayCanvas, knobs = {}) {
  // floorStart: where in the scrub a full-B underlay begins filling the gaps
  // BETWEEN dabs (the dabs never tile 100%, so without this the uncovered
  // remainder snapped to B only at the very end — a measured 5× delta spike at
  // the segment anchor). The underlay ramps 0→1 from floorStart→1 so coverage
  // reaches B continuously, killing the end-of-segment pop.
  // drift = how far the low-frequency LIGHT field blends A→B across the segment
  // (0..1). The high-frequency brushwork is NOT cross-blended — mid-segment detail
  // stays single-source (frame A's strokes, recoloured) so two stroke fields never
  // superimpose into the muddy "double-exposure" that naive alpha-mixing produced.
  // The dab reveal + the floorStart underlay carry the convergence to the real B.
  // budget = max dabs newly committed to the persistent mask per frame (caps the
  // continuous repaint's GPU work; in steady auto-advance only a handful of dabs
  // cross the reveal front per frame, so this only bounds catch-up after a scrub).
  const k = { dens: 1.0, size: 1.0, fade: 0.06, ang: 0.5, oj: 0.12, floorStart: 0.45, drift: 0.65, budget: 64, ...knobs };
  const dctx = displayCanvas.getContext('2d');
  let W = 0, H = 0;
  let maskC, mctx, blC, blctx, baseC, basectx, accC, accctx;
  let brushes = null;
  let strokes = [], order = []; // order = stroke indices sorted by reveal threshold
  let Aframe = null, Bframe = null;
  let aData = null, lowA = null, lowB = null, baseID = null;
  const frameCache = new Map(); // keyframe canvas -> { data, low } (blur once, reuse)
  // persistent reveal-mask accumulation (fully-revealed dabs stamped ONCE):
  let accValid = false, accIdx = 0, accFront = -1, prevT = -1, accA = null, accB = null;
  // idle "breathing": a STABLE snapshot + a sparse set of sheen dabs that fade in
  // and out on their own phases/rates, so the paint surface feels alive without
  // the image ever transforming. Updated a small round-robin subset per frame.
  let idleBaseC = null, idleCtx = null, breatheDabs = null, breatheCursor = 0;

  function buildStrokes() {
    strokes = [];
    const rand = rng(20240627); // deterministic → forward == backward
    for (const L of LAYERS) {
      const len = L.len * k.size, wid = L.wid * k.size;
      const grid = Math.max(6, L.grid / k.dens);
      for (let y = grid * 0.5; y < H + grid; y += grid) {
        for (let x = grid * 0.5; x < W + grid; x += grid) {
          const jx = x + (rand() - 0.5) * grid;
          const jy = y + (rand() - 0.5) * grid;
          const ang = flowAngle(jx, jy) + (rand() - 0.5) * 2.2 * k.ang;
          const base = L.tlo + (L.thi - L.tlo) * rand();
          const thr = Math.min(1, Math.max(0, base + (rand() - 0.5) * 2 * k.oj));
          strokes.push({
            x: jx, y: jy, ang, thr,
            len: len * (0.8 + rand() * 0.4),
            wid: wid * (0.8 + rand() * 0.4),
            b: brushes[(rand() * brushes.length) | 0],
          });
        }
      }
    }
    // reveal order: ascending threshold, so the accumulation can walk the dabs as
    // the front advances and commit each exactly once.
    order = strokes.map((_, i) => i).sort((p, q) => strokes[p].thr - strokes[q].thr);
    accValid = false;
  }

  // Stamp dab `s` into ctx (caller sets globalAlpha).
  function stampDab(ctx, s) {
    const c = Math.cos(s.ang), sn = Math.sin(s.ang);
    ctx.setTransform(c, sn, -sn, c, s.x, s.y);
    ctx.drawImage(s.b, -s.len / 2, -s.wid / 2, s.len, s.wid);
  }

  function resize(w, h) {
    W = w;
    H = h;
    displayCanvas.width = w;
    displayCanvas.height = h;
    maskC = document.createElement('canvas');
    maskC.width = w;
    maskC.height = h;
    mctx = maskC.getContext('2d');
    blC = document.createElement('canvas');
    blC.width = w;
    blC.height = h;
    blctx = blC.getContext('2d');
    baseC = document.createElement('canvas');
    baseC.width = w;
    baseC.height = h;
    basectx = baseC.getContext('2d');
    baseID = basectx.createImageData(w, h);
    accC = document.createElement('canvas'); // persistent accumulation of full dabs
    accC.width = w;
    accC.height = h;
    accctx = accC.getContext('2d');
    frameCache.clear();
    if (!brushes) brushes = [makeBrush(7), makeBrush(42), makeBrush(123), makeBrush(900)];
    buildStrokes();
  }

  // Per-keyframe pixel data + low-frequency field, computed once and reused (the
  // same keyframe is the B of one segment and the A of the next — without this it
  // was re-blurred at every seam, a ~50ms hitch right at the anchor).
  function frameData(canvas) {
    let e = frameCache.get(canvas);
    if (!e) {
      e = { data: canvas.getContext('2d').getImageData(0, 0, W, H).data, low: blurData(canvas, W, H) };
      frameCache.set(canvas, e);
    }
    return e;
  }

  // Frames A (current keyframe) and B (next keyframe). Both are RAW keyframes;
  // the colour/light blend that used to live in app.js (a global mean shift) is
  // now done here per-pixel from B's low-frequency field, which is spatially
  // varying and so reads as real light moving across the scene, not a flat tint.
  function setFrames(aCanvas, bCanvas) {
    if (aCanvas === Aframe && bCanvas === Bframe) return; // same segment: keep cache
    Aframe = aCanvas;
    Bframe = bCanvas;
    aData = frameData(aCanvas).data;
    lowA = frameData(aCanvas).low;
    lowB = frameData(bCanvas).low;
  }

  // Render the repaint at scrub value `t`: stamp every dab whose threshold has
  // passed (with a short per-dab fade) into a mask, keep B only where the mask
  // is, and lay that over A.
  function render(t) {
    if (!Aframe || !Bframe) return;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    // endpoints: draw the keyframe directly (exact A / exact B at the anchors, so
    // adjacent segments meet with zero discontinuity and no stray uncovered specks)
    if (t <= 0.001) {
      dctx.clearRect(0, 0, W, H);
      dctx.drawImage(Aframe, 0, 0);
      accValid = false; prevT = t;
      return;
    }
    if (t >= 0.999) {
      dctx.clearRect(0, 0, W, H);
      dctx.drawImage(Bframe, 0, 0);
      accValid = false; prevT = t;
      return;
    }

    // BASE = A's brushwork recoloured toward B's light. Take A's pixels and add
    // the low-frequency colour difference (lowB-lowA), scaled by the eased scrub
    // and the drift knob. Result keeps A's single, crisp stroke field (no doubled
    // strokes) while the light/colour drifts smoothly toward B everywhere.
    const cw = t * k.drift;
    const bd = baseID.data;
    for (let i = 0; i < bd.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = aData[i + c] + (lowB[i + c] - lowA[i + c]) * cw;
        bd[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      bd[i + 3] = 255;
    }
    basectx.putImageData(baseID, 0, 0);

    // ---- reveal mask via accumulation (the dab budget) --------------------
    // Dabs with thr <= front are FULLY revealed (alpha 1) and never change, so
    // commit them ONCE into the persistent accC; only the thin live "band" near
    // the front (partial-alpha dabs) is re-stamped each frame. This caps per-frame
    // dab work to ~the band size instead of re-stamping every revealed dab.
    const fade = k.fade;
    const front = t - fade;
    if (!accValid || Aframe !== accA || Bframe !== accB || t < prevT) {
      // rebuild (segment change / scrub backward): commit all fulls up to `front`
      accctx.setTransform(1, 0, 0, 1, 0, 0);
      accctx.clearRect(0, 0, W, H);
      accctx.globalAlpha = 1;
      accIdx = 0;
      while (accIdx < order.length && strokes[order[accIdx]].thr <= front) stampDab(accctx, strokes[order[accIdx++]]);
      accFront = front; accValid = true; accA = Aframe; accB = Bframe;
    } else if (front > accFront) {
      // forward: commit newly-full dabs, capped to the per-frame budget
      accctx.globalAlpha = 1;
      let n = 0;
      while (accIdx < order.length && strokes[order[accIdx]].thr <= front && n++ < k.budget) stampDab(accctx, strokes[order[accIdx++]]);
      if (accIdx >= order.length || strokes[order[accIdx]].thr > front) accFront = front; // caught up
    }
    accctx.setTransform(1, 0, 0, 1, 0, 0);
    // working mask = committed fulls + the live band (and any fulls still queued
    // behind the budget, which the band loop covers at alpha 1 until committed).
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.globalCompositeOperation = 'source-over';
    mctx.globalAlpha = 1;
    mctx.clearRect(0, 0, W, H);
    mctx.drawImage(accC, 0, 0);
    for (let oi = accIdx; oi < order.length; oi++) {
      const s = strokes[order[oi]];
      if (s.thr > t) break; // sorted by thr: nothing past t is revealed yet
      const a = (t - s.thr) / fade;
      mctx.globalAlpha = a >= 1 ? 1 : a;
      stampDab(mctx, s);
    }
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.globalAlpha = 1;
    prevT = t;

    // B kept only where the mask painted
    blctx.globalCompositeOperation = 'source-over';
    blctx.globalAlpha = 1;
    blctx.clearRect(0, 0, W, H);
    blctx.drawImage(Bframe, 0, 0);
    blctx.globalCompositeOperation = 'destination-in';
    blctx.drawImage(maskC, 0, 0);
    blctx.globalCompositeOperation = 'source-over';

    // recoloured base underneath; a B-underlay that fills the inter-dab gaps over
    // the latter part of the scrub (smoothstep from floorStart→1, so by t=1 it is
    // fully the real B with no snap — and since the base is already B-coloured by
    // then, this final convergence blends near-identical colours, not the muddy
    // midday→dusk average it used to); the masked-B strokes carry the painterly reveal.
    dctx.clearRect(0, 0, W, H);
    dctx.drawImage(baseC, 0, 0);
    if (t > k.floorStart) {
      const u = (t - k.floorStart) / (1 - k.floorStart);
      dctx.globalAlpha = u * u * (3 - 2 * u);
      dctx.drawImage(Bframe, 0, 0);
      dctx.globalAlpha = 1;
    }
    dctx.drawImage(blC, 0, 0);
  }

  function setKnobs(next) {
    Object.assign(k, next);
    if (W && H) buildStrokes();
  }

  // ---- idle "breathing" -----------------------------------------------------
  // Build the sparse sheen-dab field once per size. Dabs are spaced ~> their own
  // footprint so neighbours barely overlap (keeps the per-dab restore→stamp clean
  // when only a subset refreshes each frame). Order is shuffled so the round-robin
  // subset is spatially scattered — no visible update "wave".
  function buildBreatheDabs() {
    const rand = rng(13371337);
    const dabs = [];
    const spacing = 58;
    for (let y = spacing * 0.5; y < H; y += spacing) {
      for (let x = spacing * 0.5; x < W; x += spacing) {
        const len = 40 + rand() * 18, wid = 16 + rand() * 10;
        dabs.push({
          x: x + (rand() - 0.5) * spacing * 0.7,
          y: y + (rand() - 0.5) * spacing * 0.7,
          ang: flowAngle(x, y) + (rand() - 0.5) * 1.2,
          len, wid,
          rad: 0.5 * Math.hypot(len, wid) + 2, // restore bbox radius
          b: brushes[(rand() * brushes.length) | 0],
          phase: rand() * 6.283,
          omega: (2 * Math.PI) / (2.6 + rand() * 3.6), // 2.6–6.2 s period
          amp: 0.07 + rand() * 0.06,                   // subtle: max ~0.07–0.13
        });
      }
    }
    for (let i = dabs.length - 1; i > 0; i--) { // Fisher–Yates shuffle
      const j = (rand() * (i + 1)) | 0;
      [dabs[i], dabs[j]] = [dabs[j], dabs[i]];
    }
    breatheDabs = dabs;
    breatheCursor = 0;
  }

  // Snapshot the CURRENT display as the stable base to breathe on. Call once when
  // the app goes idle (after the last full render); cheap (one drawImage).
  function beginIdle() {
    if (!idleBaseC) {
      idleBaseC = document.createElement('canvas');
      idleCtx = idleBaseC.getContext('2d');
    }
    if (idleBaseC.width !== W || idleBaseC.height !== H) {
      idleBaseC.width = W;
      idleBaseC.height = H;
    }
    idleCtx.clearRect(0, 0, W, H);
    idleCtx.drawImage(displayCanvas, 0, 0);
    if (!breatheDabs || breatheDabs.length === 0) buildBreatheDabs();
  }

  // Advance the breathing by refreshing a small round-robin subset of dabs. Each
  // dab's sheen alpha comes from absolute time, so a dab that waited several
  // frames still lands at the right value (no drift). Per dab: restore the stable
  // base under its footprint (erasing last frame's sheen), then screen a soft
  // white dab at the current alpha. NO full-canvas redraw. `nowMs` = timestamp.
  // Returns the number of dabs touched (for cost reporting).
  function breathe(nowMs) {
    if (!idleBaseC || !breatheDabs) return 0;
    const t = nowMs / 1000;
    const N = breatheDabs.length;
    const count = Math.max(8, Math.round(N / 12)); // each dab refreshes ~5×/s @60fps
    const sel = []; // selected dabs this frame + their current sheen alpha
    for (let n = 0; n < count; n++) {
      const s = breatheDabs[breatheCursor];
      breatheCursor = (breatheCursor + 1) % N;
      s._a = s.amp * (0.5 - 0.5 * Math.cos(t * s.omega + s.phase)); // 0..amp
      sel.push(s);
    }
    // PASS 1 (source-over): restore the stable base under every selected dab,
    // erasing last frame's sheen. Batched so the composite op is set once.
    for (let i = 0; i < sel.length; i++) {
      const s = sel[i];
      const rx = Math.max(0, (s.x - s.rad) | 0), ry = Math.max(0, (s.y - s.rad) | 0);
      const rw = Math.min(W - rx, Math.ceil(s.rad * 2)), rh = Math.min(H - ry, Math.ceil(s.rad * 2));
      if (rw > 0 && rh > 0) dctx.drawImage(idleBaseC, rx, ry, rw, rh, rx, ry, rw, rh);
    }
    // PASS 2 (screen): stamp the soft sheen for dabs above the trough. One
    // composite-op set for the whole batch; setTransform avoids save/restore.
    dctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < sel.length; i++) {
      const s = sel[i];
      if (s._a < 0.004) continue; // at the trough: leave it clean (exact base)
      dctx.globalAlpha = s._a;
      const c = Math.cos(s.ang), sn = Math.sin(s.ang);
      dctx.setTransform(c, sn, -sn, c, s.x, s.y);
      dctx.drawImage(s.b, -s.len / 2, -s.wid / 2, s.len, s.wid);
    }
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.globalAlpha = 1;
    dctx.globalCompositeOperation = 'source-over';
    return count;
  }

  return { resize, setFrames, render, setKnobs, beginIdle, breathe };
}
