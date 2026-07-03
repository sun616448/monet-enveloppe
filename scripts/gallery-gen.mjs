// Batch keyframe generator for the curated gallery. Same pipeline as the live
// /api/enveloppe endpoint (photo -> Monet BASE midday -> edit-of-base dusk/night
// relights), but run locally against .env's OPENAI_API_KEY and written straight
// to public/gallery/<id>/ as static assets. DAWN is NOT generated — it's derived
// free client-side from the dusk frame (src/scene.js dawnFromCanvas).
//
// Prompts + keyframe plan are imported from api/_prompts.js (single source of
// truth — do not fork them here). Run: node scripts/gallery-gen.mjs [id ...]
//   with no args -> all scenes below; with ids -> just those.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BASE_PROMPT, RELIGHT, LIGHTS, KEYFRAMES, QUALITY } from '../api/_prompts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// Load .env, letting the FILE win over any stale shell-exported var (the
// shadowing that made a fresh key look broken — see compare3.mjs / memory).
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[`_FORCE_${m[1]}`]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const OAI = process.env.OPENAI_API_KEY;
if (!OAI) throw new Error('OPENAI_API_KEY missing from .env');

const RATE = { img: 8 / 1e6, txt: 5 / 1e6, out: 30 / 1e6 }; // gpt-image-2 $/token

// The scenes to build. `from` is a source PHOTO under public/; `id` is the
// gallery folder + manifest id; title/credit surface in the UI.
const SCENES = [
  { id: 'riviera', from: 'gallery/monet_gallery1.jpg', title: 'Villefranche Harbour', credit: 'gpt-image-2 · relit keyframes' },
  { id: 'meadow',  from: 'gallery/monet_gallery2.jpg', title: 'River Meadow',        credit: 'gpt-image-2 · relit keyframes' },
  { id: 'tetons',  from: 'gallery/monet_gallery3.jpg', title: 'Grand Teton Reflection', credit: 'gpt-image-2 · relit keyframes' },
];

const only = process.argv.slice(2);
const scenes = only.length ? SCENES.filter((s) => only.includes(s.id)) : SCENES;

let totalCost = 0;
const addCost = (c) => { totalCost += c; };

// One gpt-image-2 edit (multipart). Mirrors api/enveloppe.js edit(): retries once
// on 5xx/429, measures cost from usage tokens. Returns PNG bytes.
async function edit(prompt, imgBytes, imgMime) {
  let lastErr = 'unknown';
  for (let attempt = 0; attempt < 2; attempt++) {
    const form = new FormData();
    form.append('model', 'gpt-image-2');
    form.append('prompt', prompt);
    form.append('size', '1536x1024');
    form.append('quality', QUALITY);
    form.append('n', '1');
    form.append('image', new Blob([imgBytes], { type: imgMime }), imgMime === 'image/jpeg' ? 'in.jpg' : 'in.png');
    const org = process.env.OPENAI_ORG || process.env.OPENAI_ORGANIZATION;
    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OAI}`, ...(org ? { 'OpenAI-Organization': org } : {}) },
      body: form,
    });
    if (r.ok) {
      const data = await r.json();
      const u = data.usage || {};
      const it = u.input_tokens_details || {};
      addCost((it.image_tokens || 0) * RATE.img + (it.text_tokens || 0) * RATE.txt + (u.output_tokens || 0) * RATE.out);
      return Buffer.from(data.data[0].b64_json, 'base64');
    }
    lastErr = `${r.status} ${await r.text()}`;
    if (r.status < 500 && r.status !== 429) break;
  }
  throw new Error(`edit failed: ${lastErr}`);
}

const manifestEntries = [];
for (const scene of scenes) {
  const t0 = Date.now();
  console.log(`\n[${scene.id}] ${scene.title} — from ${scene.from}`);
  const photo = await readFile(join(ROOT, 'public', scene.from));
  const outDir = join(ROOT, 'public', 'gallery', scene.id);
  await mkdir(outDir, { recursive: true });

  // BASE (midday) — the single photo->Monet generation.
  const base = KEYFRAMES.find((k) => k.kind === 'base');
  console.log(`  · base (${base.label})…`);
  const baseBytes = await edit(BASE_PROMPT, photo, 'image/jpeg');
  const bytesByLabel = { [base.label]: baseBytes };
  await writeFile(join(outDir, `${base.label.toLowerCase()}.png`), baseBytes);

  // RELIGHTS — edit of the base, not the photo (keeps composition/brushwork).
  for (const kf of KEYFRAMES) {
    if (kf.kind === 'base') continue;
    console.log(`  · relight (${kf.label})…`);
    const bytes = await edit(RELIGHT(LIGHTS[kf.light]), baseBytes, 'image/png');
    bytesByLabel[kf.label] = bytes;
    await writeFile(join(outDir, `${kf.label.toLowerCase()}.png`), bytes);
  }

  const keyframes = KEYFRAMES.map((kf) => ({
    hour: kf.hour, label: kf.label, url: `gallery/${scene.id}/${kf.label.toLowerCase()}.png`,
  })).sort((a, b) => a.hour - b.hour);
  manifestEntries.push({ id: scene.id, title: scene.title, credit: scene.credit, keyframes });
  console.log(`  ✓ ${scene.id} in ${((Date.now() - t0) / 1000).toFixed(1)}s — running cost $${totalCost.toFixed(3)}`);
}

console.log(`\nDONE. ${scenes.length} scene(s), total cost $${totalCost.toFixed(3)}.`);
console.log('Manifest entries (real-scene shape) — splice into public/gallery/manifest.json:');
console.log(JSON.stringify(manifestEntries, null, 2));
