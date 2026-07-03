import './style.css';
import { sortAnchors, locate, formatClock } from './enveloppe.js';
import { createRepaint } from './repaint.js';
import { loadScene, offlineSceneFromImage } from './scene.js';
import { fetchGallery } from './gallery.js';
import {
  API_ENDPOINT,
  KEYFRAMES,
  DISPLAY_MAX_EDGE,
  UPLOAD_MAX_EDGE,
  DAY_SWEEP_SECONDS,
  DEFAULT_DRIFT,
  REPAINT,
} from './config.js';

const els = {
  stage: document.getElementById('stage'),
  canvas: document.getElementById('canvas'),
  slider: document.getElementById('timeSlider'),
  marks: document.getElementById('keyframeMarks'),
  clock: document.getElementById('clock'),
  periodLabel: document.getElementById('periodLabel'),
  playBtn: document.getElementById('playBtn'),
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('fileInput'),
  gallery: document.getElementById('galleryStrip'),
  loader: document.getElementById('loader'),
  loaderText: document.getElementById('loaderText'),
  loaderBar: document.getElementById('loaderBar'),
  source: document.getElementById('source'),
  fps: document.getElementById('fps'),
  toast: document.getElementById('toast'),
};

const state = {
  scenes: [],          // gallery descriptors (un-loaded)
  scene: null,         // current loaded Scene
  sorted: [],          // sortAnchors(scene.keyframes)
  repaint: null,
  hour: 12,
  playing: false,
  rafId: null,
  lastTs: 0,
  fpsEma: 0,
  renderedHour: null,  // last hour a full frame was drawn at (idle detection)
  idleActive: false,   // currently running the ambient breathing loop
  dirty: true,         // force a full re-render next frame (scene/knob change)
  scrubbing: false,    // user is holding the timeline
  resumeAfterScrub: true, // resume auto-advance on release (false if deliberately paused)
};

// ---------- timing curve ----------

// Map linear segment progress t∈[0,1] → te with CONSTANT velocity across the
// interior and a gentle (smoothstep) velocity ramp only inside the seam window
// `s` at each end, never dropping below floor `vf` (so it's "never idle"). This
// is the closed-form integral of that trapezoidal-ish velocity profile, so te is
// C1-continuous and te(0)=0, te(1)=1. Linear within, soft only at the seams.
const SEAM = 0.12, SEAM_FLOOR = 0.45;
function seamEase(t, s = SEAM, vf = SEAM_FLOOR) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const SI = (x) => x * x * x - 0.5 * x * x * x * x; // ∫₀ˣ smoothstep
  const Z = 1 - s * (1 - vf);                        // ∫₀¹ velocity
  let area;
  if (t <= s) area = vf * t + (1 - vf) * s * SI(t / s);
  else if (t <= 1 - s) area = 0.5 * s * (1 + vf) + (t - s);
  else { const r = (1 - t) / s; area = Z - (vf * (1 - t) + (1 - vf) * s * SI(r)); }
  return area / Z;
}

// ---------- image helpers ----------

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

function downscaleToJpegDataURL(img, maxEdge) {
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * scale));
  c.height = Math.max(1, Math.round(sh * scale));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.9);
}

// ---------- scene wiring ----------

function setScene(scene) {
  state.scene = scene;
  state.sorted = sortAnchors(scene.keyframes);
  const { w, h } = scene.dims;

  state.repaint.resize(w, h); // also sizes els.canvas

  els.stage.style.aspectRatio = `${w} / ${h}`;
  els.source.textContent = scene.placeholder ? 'placeholder' : 'gpt-image-2';

  buildKeyframeMarks();
  highlightGallery(scene.id);
  state.dirty = true; // new scene: force a fresh render + idle re-snapshot
  renderHour(state.hour);
}

// One display frame at `hour`: locate the bracketing keyframes, drift A's colour
// toward B by t (within-segment), then repaint B over the drifted A at progress t.
function renderHour(hour) {
  const scene = state.scene;
  if (!scene) return;
  const { a, b, t } = locate(state.sorted, hour);
  const kfA = scene.keyframes[a];
  const kfB = scene.keyframes[b];

  // Soft-seam easing: the stroke-laying runs at CONSTANT velocity through the
  // interior of a segment (so auto-advance paints at an even pace, not the
  // ramp-up/ramp-down a full smoothstep gave), and only eases velocity down near
  // the anchors so crossing a seam doesn't visibly "click". The repaint reveal AND
  // its internal colour drift use this SAME te, staying in lockstep; te(0)=0 and
  // te(1)=1 still hit exact A/B, so the anchor-pop fix and seam continuity hold.
  const te = seamEase(t);

  // Pass RAW keyframes: repaint.js now does the colour/light drift itself, from
  // B's spatially-varying low-frequency field (see setFrames), instead of the old
  // flat global mean shift — same `drift` strength, but it reads as real light.
  state.repaint.setFrames(kfA.canvas, kfB.canvas);
  state.repaint.render(te);

  updateTimeUI(hour, kfA, kfB, t);
}

function updateTimeUI(hour, kfA, kfB, t) {
  els.clock.textContent = formatClock(hour);
  els.periodLabel.textContent = t < 0.04 ? kfA.label : t > 0.96 ? kfB.label : `${kfA.label} → ${kfB.label}`;
  els.slider.value = String(hour);
  els.marks.querySelectorAll('.kf-mark').forEach((m) => {
    const id = m.dataset.label;
    m.classList.toggle('active', id === kfA.label || id === kfB.label);
  });
}

// ---------- keyframe markers (on the timeline) ----------

function buildKeyframeMarks() {
  els.marks.innerHTML = '';
  state.scene.keyframes.forEach((kf) => {
    const m = document.createElement('button');
    m.className = 'kf-mark';
    m.dataset.label = kf.label;
    m.style.left = `${(kf.hour / 24) * 100}%`;
    m.title = `${kf.label} · ${formatClock(kf.hour)}`;
    m.innerHTML = `<span class="kf-dot"></span><span class="kf-name">${kf.label}</span>`;
    m.addEventListener('click', () => {
      setPlaying(false);
      state.hour = kf.hour;
    });
    els.marks.appendChild(m);
  });
}

// ---------- gallery strip ----------

function buildGalleryStrip(descs) {
  els.gallery.innerHTML = '';
  descs.forEach((d) => {
    // Thumbnail = the Midday keyframe (the palest, most pastel light) — falls back
    // to hour 12, then the first frame, then the placeholder source.
    const kfs = d.keyframes;
    const midday = kfs && (kfs.find((k) => k.label === 'Midday') || kfs.find((k) => k.hour === 12) || kfs[0]);
    const thumb = midday ? midday.url : d.placeholder?.from;
    const card = document.createElement('button');
    card.className = 'ref';
    card.dataset.id = d.id;
    card.title = `Show “${d.title}”`;
    card.innerHTML = `
      <span class="ref-thumb" style="background-image:url('${thumb}')"></span>
      <span class="ref-meta">
        <span class="ref-title">${escapeHtml(d.title)}</span>
      </span>`;
    card.addEventListener('click', () => selectScene(d));
    els.gallery.appendChild(card);
  });
}

function highlightGallery(id) {
  els.gallery.querySelectorAll('.ref').forEach((c) => c.classList.toggle('active', c.dataset.id === id));
}

async function selectScene(desc) {
  try {
    setPlaying(false);
    const scene = await loadScene(desc, DISPLAY_MAX_EDGE);
    setScene(scene);
  } catch (e) {
    console.error(e);
    toast(`Couldn't load “${desc.title}”.`);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- upload (live) with offline fallback ----------

async function handleUpload(file) {
  if (!file || !file.type.startsWith('image/')) return;
  setPlaying(false);
  const url = URL.createObjectURL(file);
  let img;
  try {
    img = await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }

  showPainting();
  try {
    const dataUrl = downscaleToJpegDataURL(img, UPLOAD_MAX_EDGE);
    const res = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: dataUrl.split(',')[1], mime: 'image/jpeg' }),
    });
    if (!res.ok) {
      const reason = res.status === 503 ? 'cap' : res.status === 429 ? 'busy' : 'http';
      throw new Error(reason);
    }
    const data = await res.json();
    const scene = await loadScene(
      { id: data.uploadId || 'upload', title: 'Your scene', keyframes: data.keyframes },
      DISPLAY_MAX_EDGE
    );
    stopPainting();
    hideLoader();
    setScene(scene);
    toast('Painted your scene — scrub the day.');
  } catch (e) {
    // Never leave the visitor stranded: synthesize an offline preview so the
    // whole upload → timeline → repaint UX still works without the live API.
    const scene = await offlineSceneFromImage(img, DISPLAY_MAX_EDGE, KEYFRAMES);
    stopPainting();
    hideLoader();
    setScene(scene);
    toast(
      e.message === 'cap'
        ? 'The studio is at capacity today — showing an offline preview of your photo.'
        : e.message === 'busy'
          ? 'The studio is busy right now — showing an offline preview. Try again shortly.'
          : 'Live painting runs on the deployed site — showing an offline preview here.',
      6000
    );
  }
}

// ---------- loop / play ----------

function tick(ts) {
  if (state.lastTs) {
    const dt = (ts - state.lastTs) / 1000;
    if (state.playing) state.hour = (state.hour + dt * (24 / DAY_SWEEP_SECONDS)) % 24;
    const fps = 1 / Math.max(dt, 1e-3);
    state.fpsEma = state.fpsEma ? state.fpsEma * 0.9 + fps * 0.1 : fps;
    els.fps.textContent = `${state.fpsEma.toFixed(0)} fps`;
  }
  state.lastTs = ts;

  // Moving (scrub/play/knob change): do the full transition render. Idle: stop
  // re-rendering the same frame and instead run the cheap ambient breathing on a
  // one-time snapshot — surface stays alive, the painting stays put, GPU stays cool.
  const moving = state.playing || state.dirty || state.hour !== state.renderedHour;
  if (moving) {
    renderHour(state.hour);
    state.renderedHour = state.hour;
    state.dirty = false;
    state.idleActive = false;
  } else {
    if (!state.idleActive) { state.repaint.beginIdle(); state.idleActive = true; }
    state.repaint.breathe(ts);
  }
  state.rafId = requestAnimationFrame(tick);
}

function startLoop() {
  if (state.rafId == null) {
    state.lastTs = 0;
    state.rafId = requestAnimationFrame(tick);
  }
}

function setPlaying(playing) {
  state.playing = playing;
  els.playBtn.classList.toggle('playing', playing);
  els.playBtn.setAttribute('aria-pressed', String(playing));
  els.playBtn.querySelector('.label').textContent = playing ? 'Pause' : 'Play day';
}

// ---------- loader / toast ----------

function setLoader(text, fraction) {
  els.loaderText.textContent = text;
  if (fraction != null) els.loaderBar.style.width = `${Math.round(fraction * 100)}%`;
}

function hideLoader() {
  els.loader.classList.add('hidden');
}

let paintingTimer = null;
function showPainting() {
  els.loader.classList.remove('hidden');
  els.loaderBar.style.background = '';
  const steps = ['Painting your scene…', 'Lighting the dawn…', 'Lighting midday…', 'Lighting the dusk…', 'Letting it dry…'];
  let i = 0;
  let pct = 8;
  setLoader(steps[0], pct / 100);
  paintingTimer = setInterval(() => {
    i = Math.min(i + 1, steps.length - 1);
    pct = Math.min(92, pct + (92 - pct) * 0.4);
    setLoader(steps[i], pct / 100);
  }, 1700);
}
function stopPainting() {
  if (paintingTimer) clearInterval(paintingTimer);
  paintingTimer = null;
}

let toastTimer = null;
function toast(msg, ms = 4200) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

// ---------- wiring ----------

function bindDropzone(el, onFile) {
  ['dragenter', 'dragover'].forEach((ev) =>
    el.addEventListener(ev, (e) => {
      e.preventDefault();
      el.classList.add('drag');
    })
  );
  ['dragleave', 'dragend', 'drop'].forEach((ev) =>
    el.addEventListener(ev, (e) => {
      e.preventDefault();
      el.classList.remove('drag');
    })
  );
  el.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });
}

function wireControls() {
  // Scrub handoff: grabbing the timeline pauses auto-advance and the position
  // follows the cursor; releasing RESUMES auto-advance from wherever it was left
  // (the clock carries on from there — it never jumps back to where it "would"
  // have been). Because the thumb tracks the moving clock, grabbing it doesn't
  // snap. Pause vs auto-resume is remembered so a deliberate Pause stays paused.
  const beginScrub = () => {
    if (state.scrubbing) return;
    state.scrubbing = true;
    state.resumeAfterScrub = state.playing;
    state.playing = false;
  };
  const endScrub = () => {
    if (!state.scrubbing) return;
    state.scrubbing = false;
    if (state.resumeAfterScrub) setPlaying(true); // carry on from the released hour
  };
  els.slider.addEventListener('pointerdown', beginScrub);
  els.slider.addEventListener('input', () => {
    beginScrub(); // covers keyboard scrubbing too (no pointerdown)
    state.hour = Number(els.slider.value);
  });
  els.slider.addEventListener('change', endScrub); // fires on release / keyboard commit
  window.addEventListener('pointerup', endScrub);   // release even if off the track
  els.playBtn.addEventListener('click', () => {
    setPlaying(!state.playing);
    state.resumeAfterScrub = state.playing; // a deliberate pause must survive a scrub
  });
  els.fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
  });
  bindDropzone(els.dropzone, handleUpload);
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) handleUpload(item.getAsFile());
  });

  // Fully stop the rAF loop when the tab is hidden (rAF already throttles, but a
  // hard stop guarantees the idle breathing burns zero cycles in the background).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state.rafId != null) { cancelAnimationFrame(state.rafId); state.rafId = null; }
    } else {
      state.lastTs = 0;        // avoid a giant dt on resume
      state.dirty = true;      // repaint once, then resume breathing
      startLoop();
    }
  });
}

// ---------- boot ----------

async function boot() {
  wireControls();
  // Dev dab-tuning override (inert unless a param is present): ?dens=&size=&budget=&fade=
  // — lets validate/{fps-probe,capture-dabs}.mjs sweep the repaint knobs without a rebuild.
  const qp = new URLSearchParams(location.search);
  const numq = (k) => (qp.has(k) ? Number(qp.get(k)) : undefined);
  const repaintOverride = {};
  for (const key of ['dens', 'size', 'budget', 'fade']) {
    const v = numq(key);
    if (Number.isFinite(v)) repaintOverride[key] = v;
  }
  state.repaint = createRepaint(els.canvas, { ...REPAINT, ...repaintOverride, drift: DEFAULT_DRIFT });

  try {
    setLoader('Hanging the gallery…', 0.4);
    state.scenes = await fetchGallery();
    if (state.scenes.length) buildGalleryStrip(state.scenes);

    // Default view: first curated scene. Guaranteed non-empty — fall back to a
    // bundled image recolored offline if the manifest is missing/unreachable.
    if (state.scenes.length) {
      setLoader('Mixing the light…', 0.7);
      const scene = await loadScene(state.scenes[0], DISPLAY_MAX_EDGE);
      setScene(scene);
    } else {
      const img = await loadImage('sample.jpg');
      setScene(await offlineSceneFromImage(img, DISPLAY_MAX_EDGE, KEYFRAMES));
    }

    hideLoader();
    setPlaying(true); // auto-advance is the default — the day paints continuously
    startLoop();
  } catch (err) {
    console.error(err);
    // Last-ditch: still try to show *something* rather than a broken screen.
    try {
      const img = await loadImage('sample.jpg');
      setScene(await offlineSceneFromImage(img, DISPLAY_MAX_EDGE, KEYFRAMES));
      hideLoader();
      setPlaying(true);
      startLoop();
    } catch (e2) {
      setLoader(`Something went wrong: ${err.message}`, 1);
      els.loaderBar.style.background = '#b4452f';
    }
  }
}

boot();
