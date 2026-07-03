// ===========================================================================
//  gpt-image-2 QUALITY PROBE — throwaway. NOT the backend.
//  ONE question: do the Monet daubs survive at quality:"medium" (~half price),
//  or does medium smooth them toward a polished illustration (the FLUX failure)?
//  Same Tübingen photo, same Monet prompt, same edit-of-base relight as the
//  high run. Generates base/day/dusk at MEDIUM and builds a high-vs-medium sheet
//  against the existing openai-*.png (high) frames. Reports measured $/image.
//
//  Run:  node validate/quality-probe.mjs
//  Out:  validate/out/compare/openai-med-{base,day,dusk}.png + quality.html
// ===========================================================================
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PHOTO = join(HERE, '..', 'public', 'sample.jpg');
const OUT = join(HERE, 'out', 'compare');

// Force .env to win over any stale shell var (the OPENAI_API_KEY shadowing trap).
for (const line of readFileSync(join(HERE, '..', '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const OAI = process.env.OPENAI_API_KEY;
if (!OAI) { console.error('Missing OPENAI_API_KEY in .env'); process.exit(1); }

const QUALITY = 'medium';

// Identical prompts to the high run, so quality is the only variable.
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

const RATE = { img: 8 / 1e6, txt: 5 / 1e6, out: 30 / 1e6 };
let total = 0;
async function gen(prompt, bytes, mime, label) {
  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('prompt', prompt);
  form.append('size', '1536x1024');
  form.append('quality', QUALITY);
  form.append('n', '1');
  form.append('image', new Blob([bytes], { type: mime }), mime === 'image/jpeg' ? 'in.jpg' : 'in.png');
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST', headers: { Authorization: `Bearer ${OAI}` }, body: form,
  });
  if (!res.ok) throw new Error(`${label}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const u = data.usage || {}, it = u.input_tokens_details || {};
  const cost = (it.image_tokens || 0) * RATE.img + (it.text_tokens || 0) * RATE.txt + (u.output_tokens || 0) * RATE.out;
  total += cost;
  console.log(`  ${label} (${QUALITY}): $${cost.toFixed(4)}  (out ${u.output_tokens || 0} tok)`);
  return Buffer.from(data.data[0].b64_json, 'base64');
}

async function main() {
  const photo = await readFile(PHOTO);
  console.log(`gpt-image-2 @ ${QUALITY}\n`);
  console.log('base (photo → Monet)…');
  const base = await gen(BASE_PROMPT, photo, 'image/jpeg', 'base');
  await writeFile(join(OUT, 'openai-med-base.png'), base);
  for (const [k, light] of Object.entries(LIGHTS)) {
    console.log(`relight → ${k} (edit of base)…`);
    const bytes = await gen(RELIGHT(light), base, 'image/png', k);
    await writeFile(join(OUT, `openai-med-${k}.png`), bytes);
  }

  // high-vs-medium contact sheet (rows = quality, cols = base/day/dusk)
  const row = (label, prefix) =>
    `<tr><th class="rh">${label}</th>` +
    ['base', 'day', 'dusk'].map((k) => {
      const f = `${prefix}-${k}.png`;
      return existsSync(join(OUT, f)) ? `<td><img src="${f}"><div class="cap">${k}</div></td>` : `<td class="e">—</td>`;
    }).join('') + '</tr>';
  const html = `<!doctype html><meta charset="utf-8"><title>gpt-image-2 quality</title>
<style>body{margin:0;background:#0d0f12;color:#d7dde3;font:12px ui-monospace,Menlo,monospace}
h1{padding:16px 16px 0;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8b97a3}
p{padding:0 16px;color:#768290;max-width:84ch}
table{border-collapse:collapse;margin:12px}th.rh{color:#ffb066;padding:10px;text-align:right}
td{padding:6px}img{width:330px;display:block;border-radius:5px}.cap{color:#768290;padding:3px}
td.e{color:#4a525b}</style>
<h1>gpt-image-2 — high vs medium</h1>
<p>Do the broken-color Monet daubs survive at medium? Compare the sky stipple,
foliage dabs and water reflections row to row. If medium reads as smoothed/
illustrative, commit to high.</p>
<table>${row('HIGH · $0.177/img', 'openai')}${row(`MEDIUM · $${(total / 3).toFixed(3)}/img`, 'openai-med')}</table>`;
  await writeFile(join(OUT, 'quality.html'), html);

  console.log(`\nMEDIUM measured: $${(total / 3).toFixed(4)}/image  ($${total.toFixed(3)} for 3)`);
  console.log('HIGH was:        $0.177/image');
  console.log('Open validate/out/compare/quality.html');
}
main().catch((e) => { console.error('\nFailed:', e.message); process.exit(1); });
