// ===========================================================================
//  VALIDATION PROBE — throwaway. NOT the production backend.
//  Answers Phase-2 step 2 ONLY: does FLUX.1 Kontext [pro]
//    (a) give the brushwork we want from the Tübingen photo, and
//    (b) hold brushwork+composition across a relight edit, so two keyframes
//        are transition-compatible for the brushstroke repaint?
//
//  Pipeline under test (the real one, minimally):
//    photo --base gen--> BASE painting
//    BASE  --relight----> keyframe "day"   (edit of BASE, not of the photo)
//    BASE  --relight----> keyframe "dusk"  (edit of BASE, not of the photo)
//  Both keyframes are INDEPENDENT single edits of the SAME base, so each is at
//  most one edit away from the shared anchor (no cumulative drift).
//
//  Run it yourself (you hold the key — this script never stores it):
//    export BFL_API_KEY=...        # your Black Forest Labs key
//    node validate/relight-probe.mjs
//  Outputs: validate/out/{base,key-day,key-dusk}.png + contact-sheet.html
//  Open validate/out/contact-sheet.html to eyeball the three side by side.
//
//  Cost of one run: 3 Kontext [pro] images ≈ $0.12. Latency ≈ 10–20s total.
// ===========================================================================
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PHOTO = join(HERE, '..', 'public', 'sample.jpg'); // Tübingen Neckarfront
const OUT = join(HERE, 'out');

// Auto-load the repo-root .env (Node 22 built-in, no dependency).
try { process.loadEnvFile(join(HERE, '..', '.env')); } catch { /* no .env — rely on shell env */ }

const KEY = process.env.BFL_API_KEY;
if (!KEY) {
  console.error('Missing BFL_API_KEY. Run:  export BFL_API_KEY=...  then re-run.');
  process.exit(1);
}

const ENDPOINT = 'https://api.bfl.ai/v1/flux-kontext-pro';

// ---- Prompts. These ARE the experiment — composition/brushwork hold lives here.
// Base: convert the photo to a Monet oil; lock composition, impose real paint.
const BASE_PROMPT =
  'Repaint this photograph as an impressionist oil painting in the style of ' +
  'Claude Monet. Loose visible broken brushstrokes, thick impasto, soft ' +
  'dissolved edges, no photographic detail. Keep the exact composition, ' +
  'layout, perspective and viewpoint — same buildings in the same places, ' +
  'same river and skyline. Painterly canvas texture across the whole image.';

// Relight: keep EVERYTHING, change ONLY light. This is the consistency test.
const RELIGHT = (light) =>
  'Keep this painting exactly as it is: identical brushstrokes, identical ' +
  'composition, identical canvas texture, nothing moved or redrawn. Change ' +
  'ONLY the lighting and color of the light to ' + light + '. Relight the ' +
  'existing painting; do not repaint the scene.';

const KEYFRAMES = [
  { name: 'key-day',  light: 'bright clear midday sunlight, warm daylight, luminous blue sky' },
  { name: 'key-dusk', light: 'golden-hour dusk, warm orange sunset glow, long low light, deepened shadows' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Submit one Kontext [pro] edit; poll to completion; return PNG bytes.
async function kontext(prompt, inputBase64, label) {
  const t0 = Date.now();
  const submit = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'application/json', 'x-key': KEY },
    body: JSON.stringify({
      prompt,
      input_image: inputBase64,
      output_format: 'png',
      prompt_upsampling: false,
      safety_tolerance: 2,
    }),
  });
  if (!submit.ok) throw new Error(`${label}: submit ${submit.status} ${await submit.text()}`);
  const { polling_url } = await submit.json();
  if (!polling_url) throw new Error(`${label}: no polling_url in response`);

  for (let i = 0; i < 120; i++) {
    await sleep(1500);
    const poll = await fetch(polling_url, { headers: { accept: 'application/json', 'x-key': KEY } });
    const data = await poll.json();
    const status = data.status;
    if (status === 'Ready') {
      const url = data.result?.sample;
      if (!url) throw new Error(`${label}: Ready but no sample url`);
      const img = await fetch(url);
      const bytes = Buffer.from(await img.arrayBuffer());
      console.log(`  ${label}: done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return bytes;
    }
    if (status && status !== 'Pending' && status !== 'Processing' && status !== 'Queued') {
      // Content-moderated / Error / Request Moderated / etc. — surface it.
      throw new Error(`${label}: terminal status "${status}" ${JSON.stringify(data)}`);
    }
    process.stdout.write(`  ${label}: ${status}…\r`);
  }
  throw new Error(`${label}: timed out after ~3min`);
}

async function main() {
  const photoBytes = await readFile(PHOTO);
  const photoB64 = photoBytes.toString('base64');

  console.log('1/3  base painting  (photo → Monet, composition-preserving)…');
  const base = await kontext(BASE_PROMPT, photoB64, 'base');
  await writeFile(join(OUT, 'base.png'), base);
  const baseB64 = base.toString('base64'); // every keyframe edits THIS, the anchor

  const written = ['base.png'];
  for (const kf of KEYFRAMES) {
    console.log(`     relight → ${kf.name}  (edit of BASE, not of the photo)…`);
    const bytes = await kontext(RELIGHT(kf.light), baseB64, kf.name);
    await writeFile(join(OUT, `${kf.name}.png`), bytes);
    written.push(`${kf.name}.png`);
  }

  // Zero-dep side-by-side: an HTML contact sheet.
  const cells = [
    ['base.png', 'BASE — photo → Monet'],
    ['key-day.png', 'KEYFRAME · day (relight of base)'],
    ['key-dusk.png', 'KEYFRAME · dusk (relight of base)'],
  ]
    .map(
      ([f, t]) =>
        `<figure><img src="${f}"><figcaption>${t}</figcaption></figure>`
    )
    .join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>relight probe</title>
<style>body{margin:0;background:#0d0f12;color:#d7dde3;font:13px ui-monospace,Menlo,monospace}
.wrap{display:flex;flex-wrap:wrap;gap:14px;padding:18px}
figure{margin:0;flex:1;min-width:320px}img{width:100%;border-radius:6px;display:block}
figcaption{padding:6px 2px;color:#8b97a3}
h1{padding:18px 18px 0;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8b97a3}
p{padding:0 18px;color:#768290;max-width:70ch}</style>
<h1>FLUX.1 Kontext [pro] — relight validation</h1>
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
