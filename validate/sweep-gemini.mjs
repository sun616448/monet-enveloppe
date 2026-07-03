// ===========================================================================
//  PROMPT × CONDITIONING SWEEP (Gemini) — throwaway. NOT the backend.
//  Goal: push gemini-2.5-flash-image from "painterly filter" toward genuine
//  dissolved Monet brushwork, and find the SWEET SPOT that still keeps enough
//  composition that a relight of it stays transition-compatible.
//
//  Axis A — PROMPT AGGRESSION (3): mild / strong / extreme.
//  Axis B — CONDITIONING DETAIL (3): full / med / low input resolution.
//    Gemini has NO img2img strength knob, so we proxy it by downscaling the
//    conditioning image (less fine photographic detail to lock onto). Honest
//    proxy, not an API control.
//
//  9 cells ≈ $0.35.  Run:  node validate/sweep-gemini.mjs
//  Output: validate/out/sweep/cell-<prompt>-<detail>.png + sweep.html
// ===========================================================================
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PHOTO = join(HERE, '..', 'public', 'sample.jpg'); // Tübingen Neckarfront
const OUT = join(HERE, 'out', 'sweep');

try { process.loadEnvFile(join(HERE, '..', '.env')); } catch {}
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('Missing GEMINI_API_KEY in .env'); process.exit(1); }

const MODEL = 'gemini-2.5-flash-image';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// --- Axis A: prompt aggression (verbatim intent from the brief) -------------
const PROMPTS = {
  mild: 'An impressionist painting of this scene.',
  strong:
    'Repaint this scene as an oil painting: visible thick oil brushstrokes, ' +
    'broken color, dissolved edges, painterly not photographic, in the warm ' +
    'palette of Claude Monet\'s Haystacks series.',
  extreme:
    'Repaint this photograph ENTIRELY as a loose impressionist oil painting. ' +
    'Thick visible paint dabs, heavy impasto, soft dissolved forms, edges ' +
    'broken into strokes. Do NOT preserve fine photographic detail — buildings ' +
    'and windows should dissolve into brushwork. It must look hand-painted on ' +
    'canvas, not like a filtered photo. Monet Haystacks palette. Keep the ' +
    'overall composition and layout of the scene.',
};

// --- Axis B: conditioning detail via input downscale (longest edge px) ------
const DETAIL = { full: 1024, med: 512, low: 256 };

const sips = (src, px, dst) =>
  execFileSync('sips', ['-Z', String(px), src, '--out', dst], { stdio: 'ignore' });

async function gemini(prompt, b64, mime, label) {
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }],
    }),
  });
  if (!res.ok) throw new Error(`${label}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const p = parts.find((x) => x.inlineData?.data || x.inline_data?.data);
  if (!p) {
    const text = parts.map((x) => x.text).filter(Boolean).join(' ');
    throw new Error(`${label}: no image (finishReason=${data?.candidates?.[0]?.finishReason}) ${text.slice(0, 200)}`);
  }
  const inline = p.inlineData || p.inline_data;
  console.log(`  ${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return Buffer.from(inline.data, 'base64');
}

async function main() {
  await mkdir(OUT, { recursive: true });
  console.log(`model: ${MODEL}  (9 cells, ~$0.35)\n`);

  // Pre-build the 3 downscaled conditioning images with macOS sips.
  const srcB64 = {};
  for (const [d, px] of Object.entries(DETAIL)) {
    const dst = join(OUT, `_src-${d}.jpg`);
    sips(PHOTO, px, dst);
    srcB64[d] = (await readFile(dst)).toString('base64');
  }

  const grid = {};
  for (const pk of Object.keys(PROMPTS)) {
    for (const dk of Object.keys(DETAIL)) {
      const label = `${pk}/${dk}`;
      const bytes = await gemini(PROMPTS[pk], srcB64[dk], 'image/jpeg', label);
      const file = `cell-${pk}-${dk}.png`;
      await writeFile(join(OUT, file), bytes);
      grid[`${pk}|${dk}`] = file;
    }
  }

  // Contact sheet: rows = prompt aggression, cols = conditioning detail.
  const cols = Object.keys(DETAIL);
  const rows = Object.keys(PROMPTS);
  const head = `<tr><th></th>${cols.map((c) => `<th>detail: ${c} (${DETAIL[c]}px)</th>`).join('')}</tr>`;
  const body = rows
    .map(
      (r) =>
        `<tr><th class="rh">${r}</th>${cols
          .map((c) => `<td><img src="${grid[`${r}|${c}`]}"><div class="cap">${r} · ${c}</div></td>`)
          .join('')}</tr>`
    )
    .join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>gemini sweep</title>
<style>body{margin:0;background:#0d0f12;color:#d7dde3;font:12px ui-monospace,Menlo,monospace}
h1{padding:16px 16px 0;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8b97a3}
p{padding:0 16px;color:#768290;max-width:80ch}
table{border-collapse:collapse;padding:16px;margin:12px}
th{color:#8b97a3;font-weight:600;padding:8px;text-align:center}
th.rh{writing-mode:vertical-lr;transform:rotate(180deg);color:#ffb066}
td{padding:6px;vertical-align:top}img{width:340px;display:block;border-radius:5px}
.cap{padding:4px 2px;color:#768290}.ref img{width:340px}</style>
<h1>${MODEL} — prompt × conditioning-detail sweep</h1>
<p>Rows = prompt aggression (mild→extreme). Cols = input downscale (proxy for a
conditioning-strength knob Gemini does not expose). Judge each cell: (1) real
dissolved brushwork or still a filter? (2) composition intact enough to relight?</p>
<table>${head}${body}</table>`;
  await writeFile(join(OUT, 'sweep.html'), html);
  console.log(`\nWrote 9 cells + validate/out/sweep/sweep.html`);
}

main().catch((e) => { console.error('\nSweep failed:', e.message); process.exit(1); });
