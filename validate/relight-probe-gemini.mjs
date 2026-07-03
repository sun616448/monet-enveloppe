// ===========================================================================
//  VALIDATION PROBE (Gemini) — throwaway. NOT the production backend.
//  Same experiment as relight-probe.mjs, but on Google's Nano Banana instead
//  of FLUX Kontext, since Gemini is cheaper/faster and we're trying it first.
//
//  Answers Phase-2 step 2 ONLY: does gemini-2.5-flash-image
//    (a) give real Monet brushwork from the Tübingen photo (not a filter), and
//    (b) hold brushwork+composition across a relight edit, so two keyframes
//        are transition-compatible for the brushstroke repaint?
//
//  Topology (identical to the FLUX probe):
//    photo --base gen--> BASE painting
//    BASE  --relight----> keyframe "day"   (edit of BASE, not of the photo)
//    BASE  --relight----> keyframe "dusk"  (edit of BASE, not of the photo)
//  Both keyframes are INDEPENDENT single edits of the SAME base anchor.
//
//  Run it yourself (you hold the key — this script never stores it):
//    export GEMINI_API_KEY=...
//    node validate/relight-probe-gemini.mjs
//  Outputs: validate/out/{base,key-day,key-dusk}.png + contact-sheet.html
//
//  Gemini API shape: SYNCHRONOUS :generateContent (no polling). Image returned
//  inline as base64 at candidates[0].content.parts[].inlineData.data.
//  Cost of one run: 3 images ≈ $0.12. Latency ≈ a few seconds total.
// ===========================================================================
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PHOTO = join(HERE, '..', 'public', 'sample.jpg'); // Tübingen Neckarfront
const OUT = join(HERE, 'out');

// Auto-load the repo-root .env (Node 22 built-in, no dependency).
try { process.loadEnvFile(join(HERE, '..', '.env')); } catch { /* no .env — rely on shell env */ }

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error('Missing GEMINI_API_KEY. Run:  export GEMINI_API_KEY=...  then re-run.');
  process.exit(1);
}

// Swap to 'gemini-3.1-flash-image' or 'gemini-3-pro-image' to A/B the newer
// Nano Banana models — request/response shape is the same.
const MODEL = 'gemini-2.5-flash-image';
const ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// ---- Prompts. These ARE the experiment — composition/brushwork hold lives here.
const BASE_PROMPT =
  'Repaint this photograph as an impressionist oil painting in the style of ' +
  'Claude Monet. Loose visible broken brushstrokes, thick impasto, soft ' +
  'dissolved edges, no photographic detail. Keep the exact composition, ' +
  'layout, perspective and viewpoint — same buildings in the same places, ' +
  'same river and skyline. Painterly canvas texture across the whole image.';

const RELIGHT = (light) =>
  'Keep this painting exactly as it is: identical brushstrokes, identical ' +
  'composition, identical canvas texture, nothing moved or redrawn. Change ' +
  'ONLY the lighting and color of the light to ' + light + '. Relight the ' +
  'existing painting; do not repaint the scene.';

const KEYFRAMES = [
  { name: 'key-day',  light: 'bright clear midday sunlight, warm daylight, luminous blue sky' },
  { name: 'key-dusk', light: 'golden-hour dusk, warm orange sunset glow, long low light, deepened shadows' },
];

// One synchronous edit: text prompt + input image -> output image bytes.
async function gemini(prompt, inputB64, inputMime, label) {
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({
      contents: [
        { parts: [
          { text: prompt },
          { inline_data: { mime_type: inputMime, data: inputB64 } },
        ] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${label}: ${res.status} ${await res.text()}`);
  const data = await res.json();

  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const imgPart = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
  if (!imgPart) {
    // Surface refusals / text-only responses (e.g. safety) instead of crashing blind.
    const text = parts.map((p) => p.text).filter(Boolean).join(' ');
    const reason = data?.candidates?.[0]?.finishReason;
    throw new Error(`${label}: no image returned (finishReason=${reason}) ${text || JSON.stringify(data).slice(0, 300)}`);
  }
  const inline = imgPart.inlineData || imgPart.inline_data;
  const bytes = Buffer.from(inline.data, 'base64');
  console.log(`  ${label}: done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { bytes, mime: inline.mimeType || inline.mime_type || 'image/png' };
}

async function main() {
  const photoBytes = await readFile(PHOTO);
  const photoB64 = photoBytes.toString('base64');

  console.log(`model: ${MODEL}`);
  console.log('1/3  base painting  (photo → Monet, composition-preserving)…');
  const base = await gemini(BASE_PROMPT, photoB64, 'image/jpeg', 'base');
  await writeFile(join(OUT, 'base.png'), base.bytes);
  const baseB64 = base.bytes.toString('base64'); // every keyframe edits THIS anchor

  const written = ['base.png'];
  for (const kf of KEYFRAMES) {
    console.log(`     relight → ${kf.name}  (edit of BASE, not of the photo)…`);
    const out = await gemini(RELIGHT(kf.light), baseB64, base.mime, kf.name);
    await writeFile(join(OUT, `${kf.name}.png`), out.bytes);
    written.push(`${kf.name}.png`);
  }

  // Zero-dep side-by-side contact sheet.
  const cells = [
    ['base.png', 'BASE — photo → Monet'],
    ['key-day.png', 'KEYFRAME · day (relight of base)'],
    ['key-dusk.png', 'KEYFRAME · dusk (relight of base)'],
  ]
    .map(([f, t]) => `<figure><img src="${f}"><figcaption>${t}</figcaption></figure>`)
    .join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>relight probe · gemini</title>
<style>body{margin:0;background:#0d0f12;color:#d7dde3;font:13px ui-monospace,Menlo,monospace}
.wrap{display:flex;flex-wrap:wrap;gap:14px;padding:18px}
figure{margin:0;flex:1;min-width:320px}img{width:100%;border-radius:6px;display:block}
figcaption{padding:6px 2px;color:#8b97a3}
h1{padding:18px 18px 0;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8b97a3}
p{padding:0 18px;color:#768290;max-width:70ch}</style>
<h1>${MODEL} — relight validation</h1>
<p>Eyeball test: (a) does BASE read as real Monet brushwork, not a filter? and
(b) do day &amp; dusk share BASE's brushstrokes + composition, differing only in
light? If yes, the day↔dusk pair is repaint-transition-compatible.</p>
<div class="wrap">${cells}</div>`;
  await writeFile(join(OUT, 'contact-sheet.html'), html);

  console.log('\nWrote: ' + written.concat('contact-sheet.html').map((f) => `validate/out/${f}`).join('  '));
  console.log('Open  validate/out/contact-sheet.html  to compare side by side.');
}

main().catch((e) => {
  console.error('\nProbe failed:', e.message);
  process.exit(1);
});
