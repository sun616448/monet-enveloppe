// ===========================================================================
//  3-WAY MONET COMPARISON — throwaway. NOT the backend.
//  Same Tübingen photo, same Monet-specific prompt, same edit-of-base relight,
//  across FLUX.1 Kontext [pro] vs OpenAI gpt-image-2. Gemini's best cell
//  (sweep strong-low) is dropped in as a static brushwork baseline (no respend).
//
//  Topology for FLUX and OpenAI (identical):
//    photo --base--> BASE Monet painting
//    BASE  --edit--> day   (relight EDIT of base, composition held)
//    BASE  --edit--> dusk  (relight EDIT of base)
//
//  Judge per image: (1) real Monet brushwork (broken color, no hard edges,
//  dissolved) vs generic oil/filter?  (2) do day+dusk hold the base's
//  composition (repaint-compatible)?
//
//  Run: node validate/compare3.mjs   (keys read from .env)
//  Cost: FLUX 3×$0.04≈$0.12 ; OpenAI computed from usage (~$0.4–0.6 at high).
//  Output: validate/out/compare/{flux,openai}-{base,day,dusk}.png + compare.html
// ===========================================================================
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ONLY=openai (or =flux) reruns just that model; the other is filled from the
// PNGs already on disk so the contact sheet stays whole and we don't respend.
const ONLY = process.env.ONLY;

const HERE = dirname(fileURLToPath(import.meta.url));
const PHOTO = join(HERE, '..', 'public', 'sample.jpg');
const OUT = join(HERE, 'out', 'compare');
const GEMINI_BASELINE = join(HERE, 'out', 'sweep', 'cell-strong-low.png');

// Load .env and let the FILE WIN over any stale value exported in the shell
// (process.loadEnvFile won't override an already-set var — that shadowing is
// exactly what made a freshly-pasted OPENAI_API_KEY look broken).
function loadEnvForce(p) {
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
}
loadEnvForce(join(HERE, '..', '.env'));
const BFL = process.env.BFL_API_KEY;
const OAI = process.env.OPENAI_API_KEY;

// ---- Monet-SPECIFIC steering (error-1 fix). Shared by both models. ---------
const BASE_PROMPT =
  'Repaint this scene as a painting in the manner of Claude Monet — French ' +
  'Impressionism, the handling of his Haystacks and Rouen Cathedral series. ' +
  'Loose broken-color daubs: short separate strokes of pure unmixed color laid ' +
  'side by side. NO hard outlines and NO crisp edges anywhere — buildings, ' +
  'windows, trees and water all dissolve softly into adjacent strokes. A pale, ' +
  'high-key, luminous palette with colored light and colored shadows. Paint the ' +
  'fleeting light and atmosphere, not architectural detail. It must look ' +
  'hand-painted with a loaded brush on canvas like an actual Monet — not a sharp ' +
  'digital oil painting, not a photo. Keep the overall composition and layout.';

// ---- Relight: maximal preservation, change ONLY the light (error-2 mitigation)
const RELIGHT = (light) =>
  'This is a Monet-style impressionist painting. Preserve it EXACTLY: every ' +
  'brushstroke, every daub, the canvas texture, and the entire composition and ' +
  'layout stay identical and in the same positions. Do not repaint, redraw, ' +
  'smooth, sharpen, add or move anything. Change ONLY the color and quality of ' +
  'the light to ' + light + '. Relight this exact canvas; keep it the same painting.';

const LIGHTS = {
  day:  'bright clear late-morning daylight — luminous, cool blue sky, crisp warm sunlight',
  dusk: 'warm golden-hour dusk — orange and pink sunset glow, long low light, deep violet shadows',
};

// ---------- FLUX.1 Kontext [pro] (BFL, async poll) --------------------------
async function flux(prompt, inputB64, label) {
  const sub = await fetch('https://api.bfl.ai/v1/flux-kontext-pro', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'application/json', 'x-key': BFL },
    body: JSON.stringify({ prompt, input_image: inputB64, output_format: 'png', safety_tolerance: 2 }),
  });
  if (!sub.ok) throw new Error(`${label}: submit ${sub.status} ${await sub.text()}`);
  const { polling_url } = await sub.json();
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const p = await (await fetch(polling_url, { headers: { accept: 'application/json', 'x-key': BFL } })).json();
    if (p.status === 'Ready') {
      const img = await fetch(p.result.sample);
      return Buffer.from(await img.arrayBuffer());
    }
    if (!['Pending', 'Processing', 'Queued'].includes(p.status))
      throw new Error(`${label}: ${p.status} ${JSON.stringify(p)}`);
  }
  throw new Error(`${label}: timeout`);
}

// ---------- OpenAI gpt-image-2 (edits; high fidelity is automatic) ----------
// gpt-image-2 token pricing ($/Mtok): image-input 8, text-input 5, output 30.
const OAI_RATE = { img: 8 / 1e6, txt: 5 / 1e6, out: 30 / 1e6 };
let oaiCost = 0;
async function openai(prompt, bytes, mime, label) {
  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('prompt', prompt);
  form.append('size', '1536x1024'); // landscape, ~matches the photo
  form.append('quality', 'high');
  form.append('n', '1');
  form.append('image', new Blob([bytes], { type: mime }), mime === 'image/jpeg' ? 'in.jpg' : 'in.png');
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST', headers: { Authorization: `Bearer ${OAI}` }, body: form,
  });
  if (!res.ok) throw new Error(`${label}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const u = data.usage || {};
  const it = u.input_tokens_details || {};
  const cost = (it.image_tokens || 0) * OAI_RATE.img + (it.text_tokens || 0) * OAI_RATE.txt + (u.output_tokens || 0) * OAI_RATE.out;
  oaiCost += cost;
  console.log(`  ${label}: $${cost.toFixed(3)} (in img ${it.image_tokens||0} / txt ${it.text_tokens||0}, out ${u.output_tokens||0})`);
  return Buffer.from(data.data[0].b64_json, 'base64');
}

async function runModel(name, baseGen, edit) {
  const out = {};
  try {
    console.log(`\n[${name}] base (photo → Monet)…`);
    const base = await baseGen();
    await writeFile(join(OUT, `${name}-base.png`), base);
    out.base = `${name}-base.png`;
    for (const [k, light] of Object.entries(LIGHTS)) {
      console.log(`[${name}] relight → ${k} (edit of base)…`);
      const bytes = await edit(base, light, k);
      await writeFile(join(OUT, `${name}-${k}.png`), bytes);
      out[k] = `${name}-${k}.png`;
    }
  } catch (e) {
    console.error(`[${name}] FAILED: ${e.message}`);
    out.error = e.message;
  }
  return out;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const photo = await readFile(PHOTO);
  const photoB64 = photo.toString('base64');

  const results = {};
  // Reuse a model's existing PNGs (when it's skipped this run) so the sheet stays whole.
  const fromDisk = (name) => {
    const o = {};
    for (const k of ['base', 'day', 'dusk']) if (existsSync(join(OUT, `${name}-${k}.png`))) o[k] = `${name}-${k}.png`;
    return Object.keys(o).length ? o : null;
  };

  if (BFL && ONLY !== 'openai') {
    results.flux = await runModel(
      'flux',
      () => flux(BASE_PROMPT, photoB64, 'flux-base'),
      (base, light, k) => flux(RELIGHT(light), base.toString('base64'), `flux-${k}`),
    );
  } else { results.flux = fromDisk('flux'); console.log(BFL ? 'FLUX: reused from disk.' : 'No BFL_API_KEY — skipping FLUX.'); }

  if (OAI && ONLY !== 'flux') {
    results.openai = await runModel(
      'openai',
      () => openai(BASE_PROMPT, photo, 'image/jpeg', 'openai-base'),
      (base, light, k) => openai(RELIGHT(light), base, 'image/png', `openai-${k}`),
    );
  } else { results.openai = fromDisk('openai'); console.log(OAI ? 'OpenAI: reused from disk.' : 'No OPENAI_API_KEY — skipping OpenAI.'); }

  // Gemini baseline (best sweep cell), copied in for a self-contained sheet.
  let gemini = null;
  try { await copyFile(GEMINI_BASELINE, join(OUT, 'gemini-base.png')); gemini = 'gemini-base.png'; } catch {}

  // ---- contact sheet: rows = model, cols = base / day / dusk ---------------
  const cols = ['base', 'day', 'dusk'];
  const rows = [
    ['FLUX.1 Kontext [pro] · ~$0.04/img', results.flux],
    ['OpenAI gpt-image-2 (high) · see console $', results.openai],
    ['Gemini 2.5 Flash (strong-low) · ~$0.039/img', gemini ? { base: gemini } : null],
  ];
  const cell = (r) => (file) =>
    file ? `<td><img src="${file}"></td>` : `<td class="empty">${r && r.error ? 'error' : '—'}</td>`;
  const body = rows.map(([label, r]) => {
    const c = cell(r);
    const tds = cols.map((k) => c(r && r[k])).join('');
    return `<tr><th class="rh">${label}</th>${tds}</tr>`;
  }).join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>3-way Monet compare</title>
<style>body{margin:0;background:#0d0f12;color:#d7dde3;font:12px ui-monospace,Menlo,monospace}
h1{padding:16px 16px 0;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8b97a3}
p{padding:0 16px;color:#768290;max-width:84ch}
table{border-collapse:collapse;margin:12px}
th.ch{color:#8b97a3;padding:8px;text-transform:uppercase;letter-spacing:.06em}
th.rh{color:#ffb066;padding:10px;text-align:right;max-width:150px;vertical-align:middle}
td{padding:6px}img{width:330px;display:block;border-radius:5px}
td.empty{width:330px;text-align:center;color:#4a525b}</style>
<h1>FLUX vs OpenAI vs Gemini — Monet-specific prompt, edit-of-base relight</h1>
<p>Per image, judge: (1) real MONET brushwork — broken color, no hard edges,
dissolved forms — vs generic oil/filter? (2) do day &amp; dusk hold the base's
composition so a brushstroke-repaint between them stays consistent?</p>
<table><tr><th></th><th class="ch">base</th><th class="ch">day relight</th><th class="ch">dusk relight</th></tr>
${body}</table>`;
  await writeFile(join(OUT, 'compare.html'), html);

  console.log('\n--- per-image price ---');
  console.log('FLUX.1 Kontext [pro] : ~$0.04 / image');
  if (OAI) console.log(`OpenAI gpt-image-2   : ~$${(oaiCost / 3).toFixed(3)} / image (total $${oaiCost.toFixed(2)} for 3)`);
  console.log('Gemini 2.5 Flash Img : ~$0.039 / image');
  console.log('\nOpen validate/out/compare/compare.html');
}

main().catch((e) => { console.error('\nFatal:', e.message); process.exit(1); });
