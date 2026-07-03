// VALIDATION PROBE — throwaway. Generates ONE real gpt-image-2 NIGHT keyframe as
// an edit-of-base (relight of the midday BASE, same as dawn/dusk), to confirm the
// model returns a genuine night (dark sky, no sun, moonlight/ambient, faint lit
// windows) — content a filter cannot fake, which is why night-from-dusk failed.
//
// Run (you hold the key; this never prints it):
//   node validate/night-real-probe.mjs
// Cost: ONE gpt-image-2 medium edit (~$0.053). Out: validate/out/night/real.png
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RELIGHT, QUALITY } from '../api/_prompts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out', 'night');
await mkdir(OUT, { recursive: true });
// Make .env AUTHORITATIVE: load it, then explicitly override any value already
// exported in the shell — a stale OPENAI_API_KEY lingering in the shell profile
// would otherwise shadow the file and silently use the wrong (old) key.
try { process.loadEnvFile(join(HERE, '..', '.env')); } catch {}
try {
  const { readFileSync } = await import('node:fs');
  for (const line of readFileSync(join(HERE, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error('Missing OPENAI_API_KEY (set in .env).'); process.exit(1); }
// Send the org explicitly — without it the key falls back to its default org,
// which 401s ("invalid_organization") if that default is inaccessible.
const ORG = process.env.OPENAI_ORG || process.env.OPENAI_ORGANIZATION;

// BASE = the midday generation already validated on disk (the relight anchor).
const BASE = join(HERE, 'out', 'relight', 'midday.png');

// Night light spec fed through the SAME RELIGHT wrapper as dawn/dusk. Asks for a
// genuine dark night with invented light sources (windows / moon) — the thing a
// tonal filter can't produce.
const NIGHT_LIGHT =
  'deep night long after sunset — NO sun anywhere and no warm sunset glow. A dark ' +
  'deep blue-black sky with a soft pale moon and faint moonlight. The scene is ' +
  'low-key and dark, lit only by cool ambient moonlight plus a scattering of small ' +
  'warm glowing lit windows in the buildings and their reflections on the water. ' +
  'Most of the scene sinks into deep cool blue-black shadow; the brightest accents ' +
  'are the moon, the lit windows, and moonlight glints on the river.';

const RATE = { img: 8 / 1e6, txt: 5 / 1e6, out: 30 / 1e6 };

async function edit(prompt, imgBytes) {
  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('prompt', prompt);
  form.append('size', '1536x1024');
  form.append('quality', QUALITY);
  form.append('n', '1');
  form.append('image', new Blob([imgBytes], { type: 'image/png' }), 'in.png');
  const r = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, ...(ORG ? { 'OpenAI-Organization': ORG } : {}) },
    body: form,
  });
  if (!r.ok) throw new Error(`edit ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const u = data.usage || {}, it = u.input_tokens_details || {};
  const cost = (it.image_tokens || 0) * RATE.img + (it.text_tokens || 0) * RATE.txt + (u.output_tokens || 0) * RATE.out;
  return { bytes: Buffer.from(data.data[0].b64_json, 'base64'), cost };
}

const t0 = Date.now();
console.log('Generating ONE real NIGHT keyframe (relight of base)…');
const { bytes, cost } = await edit(RELIGHT(NIGHT_LIGHT), await readFile(BASE));
await writeFile(join(OUT, 'real.png'), bytes);
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ~$${cost.toFixed(3)}`);
console.log('wrote validate/out/night/real.png');
