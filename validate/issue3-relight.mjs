// ISSUE 3 — do the relight keyframes differ in real LIGHT (shadow direction, sky
// character, where light falls) or only in COLOR TEMPERATURE? And is it the
// keyframes (relight prompt) or color.js drift doing the visible work?
//
// Diagnosis: the CURRENT relight prompt says "Preserve EXACTLY... do not repaint,
// redraw... change ONLY the color of the light" — which FORBIDS real relighting,
// allowing only a hue cast. This probe generates, from ONE shared base:
//   row CURRENT  : dawn/midday/dusk with the strict (hue-only) relight prompt
//   row IMPROVED : dawn/midday/dusk with a relight prompt that asks for low-angle
//                  light, long shadows, glowing sky, brightness falloff — while
//                  still anchoring composition + brushwork.
// Side by side, judge: does IMPROVED give genuinely different paintings?
//
// Run: node validate/issue3-relight.mjs   Out: validate/out/relight/*
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BASE_PROMPT, RELIGHT as RELIGHT_STRICT, LIGHTS as LIGHTS_STRICT, QUALITY } from '../api/_prompts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PHOTO = join(HERE, '..', 'public', 'sample.jpg');
const OUT = join(HERE, 'out', 'relight');
for (const line of readFileSync(join(HERE, '..', '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const OAI = process.env.OPENAI_API_KEY;
if (!OAI) { console.error('Missing OPENAI_API_KEY'); process.exit(1); }

// IMPROVED relight: anchor composition + brushwork, but change the LIGHT itself.
const RELIGHT_LIGHT = (spec) =>
  'This is a Monet-style impressionist painting of a scene. Keep the SAME ' +
  'composition, the same buildings/objects in the same positions, and the same ' +
  'loose impressionist brushwork of separate daubs. Genuinely RE-LIGHT the scene: ' +
  spec +
  ' Change the direction and angle of the light, the length and direction of cast ' +
  'shadows, the brightness falloff across the scene, and the character of the sky — ' +
  'not merely the overall color tint. It must read as the same place at a ' +
  'different time of day, repainted in the same hand.';
const LIGHT_SPECS = {
  dawn: 'soft light just after sunrise — a low sun near the horizon casting long gentle shadows, a pale luminous cool sky brightening at the horizon, mist softening the distance, the foreground still dim and cool.',
  dusk: 'warm golden-hour sunset — a low sun raking from one side casting long dramatic shadows across the scene, a glowing orange-and-violet sky, bright warm rim-light on surfaces facing the sun and deep dim shadow elsewhere.',
};

const RATE = { img: 8 / 1e6, txt: 5 / 1e6, out: 30 / 1e6 };
let total = 0;
async function edit(prompt, bytes, mime, label) {
  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('prompt', prompt);
  form.append('size', '1536x1024');
  form.append('quality', QUALITY);
  form.append('n', '1');
  form.append('image', new Blob([bytes], { type: mime }), mime === 'image/jpeg' ? 'in.jpg' : 'in.png');
  const r = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${OAI}` }, body: form });
  if (!r.ok) throw new Error(`${label}: ${r.status} ${await r.text()}`);
  const data = await r.json();
  const u = data.usage || {}, it = u.input_tokens_details || {};
  total += (it.image_tokens || 0) * RATE.img + (it.text_tokens || 0) * RATE.txt + (u.output_tokens || 0) * RATE.out;
  console.log(`  ${label}: ok`);
  return Buffer.from(data.data[0].b64_json, 'base64');
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const photo = await readFile(PHOTO);
  console.log('base (midday)…');
  const midday = await edit(BASE_PROMPT, photo, 'image/jpeg', 'midday(base)');
  await writeFile(join(OUT, 'midday.png'), midday);

  console.log('CURRENT (strict hue-only) relights…');
  await writeFile(join(OUT, 'cur-dawn.png'), await edit(RELIGHT_STRICT(LIGHTS_STRICT.dawn), midday, 'image/png', 'cur-dawn'));
  await writeFile(join(OUT, 'cur-dusk.png'), await edit(RELIGHT_STRICT(LIGHTS_STRICT.dusk), midday, 'image/png', 'cur-dusk'));

  console.log('IMPROVED (real light) relights…');
  await writeFile(join(OUT, 'new-dawn.png'), await edit(RELIGHT_LIGHT(LIGHT_SPECS.dawn), midday, 'image/png', 'new-dawn'));
  await writeFile(join(OUT, 'new-dusk.png'), await edit(RELIGHT_LIGHT(LIGHT_SPECS.dusk), midday, 'image/png', 'new-dusk'));

  const sheet = (label, files) => `<tr><th>${label}</th>` + files.map((f) => `<td><img src="${f}"></td>`).join('') + '</tr>';
  const html = `<!doctype html><meta charset=utf-8><title>relight</title>
<style>body{margin:0;background:#0d0f12;color:#ccc;font:12px monospace}td,th{padding:6px}img{width:300px;display:block;border-radius:4px}th{color:#ffb066}</style>
<table><tr><th></th><th>dawn</th><th>midday (base)</th><th>dusk</th></tr>
${sheet('CURRENT (hue-only)', ['cur-dawn.png', 'midday.png', 'cur-dusk.png'])}
${sheet('IMPROVED (real light)', ['new-dawn.png', 'midday.png', 'new-dusk.png'])}
</table>`;
  await writeFile(join(OUT, 'relight.html'), html);
  console.log(`\ntotal $${total.toFixed(3)}  →  validate/out/relight/relight.html`);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
