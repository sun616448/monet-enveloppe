import './style.css';
import * as tf from '@tensorflow/tfjs';
import {
  REFERENCES,
  DEFAULT_CONTENT,
  MAX_CONTENT_SIZE,
  STYLE_SIZE,
  DAY_SWEEP_SECONDS,
  DEFAULT_STRENGTH,
  DEFAULT_PALETTE_MATCH,
} from './config.js';
import {
  initBackend,
  loadModels,
  predictStyleBottleneck,
  makeContentTensor,
  lerpBottleneck,
  applyStrength,
  imageColorStats,
  matchPalette,
  stylize,
} from './model.js';
import { sortAnchors, locate, formatClock } from './enveloppe.js';

const els = {
  stage: document.getElementById('stage'),
  canvas: document.getElementById('canvas'),
  slider: document.getElementById('timeSlider'),
  clock: document.getElementById('clock'),
  periodLabel: document.getElementById('periodLabel'),
  playBtn: document.getElementById('playBtn'),
  strength: document.getElementById('strengthSlider'),
  strengthVal: document.getElementById('strengthVal'),
  palette: document.getElementById('paletteSlider'),
  paletteVal: document.getElementById('paletteVal'),
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('fileInput'),
  refStrip: document.getElementById('refStrip'),
  loader: document.getElementById('loader'),
  loaderText: document.getElementById('loaderText'),
  loaderBar: document.getElementById('loaderBar'),
  backend: document.getElementById('backend'),
  fps: document.getElementById('fps'),
};

const state = {
  refs: [],                // active palette, hydrated: { id, src, title, hour, bottleneck, colorStats }
  sorted: [],              // sortAnchors(refs)
  nextId: 1,
  contentTensor: null,
  contentBottleneck: null, // the photo's own style vector (for strength blend)
  contentDims: { w: 0, h: 0 },
  strength: DEFAULT_STRENGTH,
  paletteMatch: DEFAULT_PALETTE_MATCH,
  hour: 12,
  playing: false,
  rafId: null,
  lastTs: 0,
  fpsEma: 0,
};

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

// Downscale a source so its longest edge is `maxSize`, return a canvas.
function downscaleToCanvas(img, maxSize = MAX_CONTENT_SIZE) {
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  const longEdge = Math.max(sw, sh);
  const scale = Math.min(1, maxSize / longEdge);
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c;
}

// ---------- reference (style) management ----------

// Evenly distribute the current references across the 24h day, in array order,
// with a wrap segment from the last back to the first. No manual tagging needed.
function assignHoursEvenly() {
  const n = state.refs.length;
  state.refs.forEach((ref, i) => {
    ref.hour = n > 0 ? (i * 24) / n : 0;
  });
  state.sorted = sortAnchors(state.refs);
}

// Extract and cache a style vector for one painting and add it to the set.
// `thumbSrc` is used for the thumbnail; if omitted we snapshot the downscaled
// canvas. The bottleneck is computed from a downscaled copy for a painterly look.
function addStyle(image, title, thumbSrc) {
  const scaled = downscaleToCanvas(image, STYLE_SIZE);
  const bottleneck = predictStyleBottleneck(scaled); // cached, kept resident
  const colorStats = imageColorStats(scaled);        // palette for colour match
  const src = thumbSrc || scaled.toDataURL('image/jpeg', 0.85);
  state.refs.push({ id: state.nextId++, title, src, bottleneck, colorStats });
  assignHoursEvenly();
  rebuildStrip();
}

// Hydrate the palette: load each painting and cache its style vector + colours.
async function loadReferences(refs) {
  for (const ref of refs) {
    const img = await loadImage(ref.src);
    addStyle(img, ref.title, ref.src);
  }
}

// ---------- content management ----------

async function setContentFromImage(img) {
  const scaled = downscaleToCanvas(img, MAX_CONTENT_SIZE);
  if (state.contentTensor) state.contentTensor.dispose();
  if (state.contentBottleneck) state.contentBottleneck.dispose();
  state.contentTensor = makeContentTensor(scaled);
  // The photo's own style vector, used to dial stylization strength down.
  state.contentBottleneck = predictStyleBottleneck(scaled);
  state.contentDims = { w: scaled.width, h: scaled.height };
  els.canvas.width = scaled.width;
  els.canvas.height = scaled.height;
  els.stage.style.aspectRatio = `${scaled.width} / ${scaled.height}`;
  await renderHour(state.hour);
}

async function setContentFromFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    await setContentFromImage(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- rendering ----------

// Component-wise lerp of two { mean:[3], std:[3] } palette stats.
function lerpStats(sa, sb, t) {
  const mix = (x, y) => x.map((v, i) => v * (1 - t) + y[i] * t);
  return { mean: mix(sa.mean, sb.mean), std: mix(sa.std, sb.std) };
}

async function renderHour(hour) {
  if (!state.contentTensor || state.refs.length === 0) return;
  const { a, b, t } = locate(state.sorted, hour);
  const refA = state.refs[a];
  const refB = state.refs[b];

  const styleBn = lerpBottleneck(refA.bottleneck, refB.bottleneck, t);
  const bn = applyStrength(styleBn, state.contentBottleneck, state.strength);
  styleBn.dispose();

  const out = stylize(state.contentTensor, bn);
  bn.dispose();

  // Pull the stylized colours toward the interpolated target palette.
  const target = lerpStats(refA.colorStats, refB.colorStats, t);
  const finalOut = matchPalette(out, target.mean, target.std, state.paletteMatch);
  out.dispose();

  await tf.browser.toPixels(finalOut, els.canvas);
  finalOut.dispose();
  updateTimeUI(hour);
}

function nearestRefTitle(hour) {
  const { a, b, t } = locate(state.sorted, hour);
  return (t < 0.5 ? state.refs[a] : state.refs[b]).title;
}

function updateTimeUI(hour) {
  els.clock.textContent = formatClock(hour);
  els.periodLabel.textContent = nearestRefTitle(hour);
  els.slider.value = String(hour);
  highlightRefs(hour);
}

function highlightRefs(hour) {
  const { a, b } = locate(state.sorted, hour);
  const activeA = state.refs[a]?.id;
  const activeB = state.refs[b]?.id;
  els.refStrip.querySelectorAll('.ref').forEach((card) => {
    const id = Number(card.dataset.id);
    card.classList.toggle('active', id === activeA || id === activeB);
  });
}

// ---------- reference strip ----------

function rebuildStrip() {
  els.refStrip.innerHTML = '';
  state.refs.forEach((ref) => {
    const card = document.createElement('div');
    card.className = 'ref';
    card.dataset.id = String(ref.id);
    card.title = `${ref.title} — jump to ${formatClock(ref.hour)}`;
    card.innerHTML = `
      <span class="ref-thumb" style="background-image:url('${ref.src}')"></span>
      <span class="ref-meta">
        <span class="ref-hour">${formatClock(ref.hour)}</span>
        <span class="ref-title">${escapeHtml(ref.title)}</span>
      </span>`;
    card.addEventListener('click', () => {
      setPlaying(false);
      state.hour = ref.hour;
    });
    els.refStrip.appendChild(card);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ---------- loop / play ----------

async function tick(ts) {
  if (state.lastTs) {
    const dt = (ts - state.lastTs) / 1000;
    if (state.playing) {
      state.hour = (state.hour + dt * (24 / DAY_SWEEP_SECONDS)) % 24;
    }
    const fps = 1 / Math.max(dt, 1e-3);
    state.fpsEma = state.fpsEma ? state.fpsEma * 0.9 + fps * 0.1 : fps;
    els.fps.textContent = `${state.fpsEma.toFixed(0)} fps`;
  }
  state.lastTs = ts;
  await renderHour(state.hour);
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

// ---------- loader UI ----------

function setLoader(text, fraction) {
  els.loaderText.textContent = text;
  if (fraction != null) els.loaderBar.style.width = `${Math.round(fraction * 100)}%`;
}

function hideLoader() {
  els.loader.classList.add('hidden');
}

// ---------- wiring ----------

function bindDropzone(el, onFiles, multiple) {
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
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    onFiles(multiple ? files : [files[0]]);
  });
}

function wireControls() {
  els.slider.addEventListener('input', () => {
    setPlaying(false);
    state.hour = Number(els.slider.value);
  });

  els.playBtn.addEventListener('click', () => setPlaying(!state.playing));

  els.strength.addEventListener('input', () => {
    state.strength = Number(els.strength.value);
    els.strengthVal.textContent = `${Math.round(state.strength * 100)}%`;
  });

  els.palette.addEventListener('input', () => {
    state.paletteMatch = Number(els.palette.value);
    els.paletteVal.textContent = `${Math.round(state.paletteMatch * 100)}%`;
  });

  // Content photo
  els.fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) setContentFromFile(file);
  });
  bindDropzone(els.dropzone, (files) => setContentFromFile(files[0]), false);

  // Paste an image as the content photo.
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) =>
      i.type.startsWith('image/')
    );
    if (item) setContentFromFile(item.getAsFile());
  });
}

// ---------- boot ----------

async function boot() {
  wireControls();

  try {
    setLoader('Starting GPU backend…', 0.02);
    const backend = await initBackend();
    els.backend.textContent = backend.toUpperCase();

    setLoader('Downloading style model…', 0.05);
    await loadModels((stage, f) => {
      const base = stage === 'style' ? 0.05 : 0.5;
      const span = stage === 'style' ? 0.45 : 0.4;
      setLoader(
        stage === 'style' ? 'Downloading style network…' : 'Downloading transform network…',
        base + f * span
      );
    });

    setLoader('Reading the light of the palette…', 0.9);
    if (REFERENCES.length === 0) {
      throw new Error('No paintings found in public/monet-refs.');
    }
    await loadReferences(REFERENCES);

    setLoader('Loading your photo…', 0.96);
    const content = await loadImage(DEFAULT_CONTENT);
    await setContentFromImage(content);

    setLoader('Warming up…', 0.99);
    await renderHour(state.hour);

    hideLoader();
    startLoop();
  } catch (err) {
    console.error(err);
    setLoader(`Something went wrong: ${err.message}`, 1);
    els.loaderBar.style.background = '#b4452f';
  }
}

boot();
