// ISSUE 1 — is gpt-image-2 actually CONDITIONED on the uploaded pixels, or is it
// regenerating a scene it already knows? The Tübingen sample is famous (confound),
// so this builds a SYNTHETIC image with unique, verifiable features no model has
// seen, runs the exact base-generation step, and saves input + output side by
// side. If the painting preserves THIS layout (cyan disc upper-left; red/green/
// purple verticals L→R; yellow diagonal; checker patch) → conditioned. If it
// drifts to a generic pretty painting → conditioning is broken.
//
// Run: node validate/condition-probe.mjs   Out: validate/out/condition/*
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BASE_PROMPT, QUALITY } from '../api/_prompts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out', 'condition');
for (const line of readFileSync(join(HERE, '..', '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const OAI = process.env.OPENAI_API_KEY;
if (!OAI) { console.error('Missing OPENAI_API_KEY'); process.exit(1); }

// ---- minimal truecolor PNG encoder (no deps) ----
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
function encodePNG(w, h, rgb) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) { const ro = y * (1 + w * 3); raw[ro] = 0; for (let x = 0; x < w * 3; x++) raw[ro + 1 + x] = rgb[y * w * 3 + x]; }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- build the distinctive test card ----
function testcard() {
  const w = 1024, h = 768, rgb = new Uint8Array(w * h * 3);
  const set = (x, y, c) => { if (x < 0 || y < 0 || x >= w || y >= h) return; const i = (y * w + x) * 3; rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2]; };
  const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, c); };
  const disc = (cx, cy, r, c) => { for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(x, y, c); };
  const horizon = Math.round(0.45 * h);
  rect(0, 0, w, horizon, [150, 170, 190]);        // sky (grey-blue)
  rect(0, horizon, w, h, [196, 170, 120]);         // ground (tan)
  disc(Math.round(0.18 * w), Math.round(0.22 * h), Math.round(0.08 * w), [0, 220, 220]); // CYAN disc upper-LEFT
  rect(Math.round(0.10 * w), Math.round(0.20 * h), Math.round(0.20 * w), horizon, [200, 40, 40]);  // RED tall (left)
  rect(Math.round(0.40 * w), Math.round(0.32 * h), Math.round(0.52 * w), horizon, [40, 160, 60]);  // GREEN short (mid)
  rect(Math.round(0.72 * w), Math.round(0.16 * h), Math.round(0.86 * w), horizon, [130, 50, 170]); // PURPLE tallest (right)
  // YELLOW diagonal band
  for (let x = 0; x < w; x++) { const yc = Math.round(0.62 * h - (x / w) * 0.12 * h); for (let y = yc - 18; y < yc + 18; y++) set(x, y, [240, 215, 40]); }
  // checker patch bottom-right
  const cx0 = Math.round(0.80 * w), cy0 = Math.round(0.80 * h), cs = 22;
  for (let y = cy0; y < Math.round(0.93 * h); y++) for (let x = cx0; x < Math.round(0.95 * w); x++) {
    const on = ((Math.floor((x - cx0) / cs) + Math.floor((y - cy0) / cs)) % 2) === 0;
    set(x, y, on ? [20, 20, 20] : [240, 240, 240]);
  }
  return { png: encodePNG(w, h, rgb) };
}

const RATE = { img: 8 / 1e6, txt: 5 / 1e6, out: 30 / 1e6 };
async function edit(prompt, bytes, mime) {
  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('prompt', prompt);
  form.append('size', '1536x1024');
  form.append('quality', QUALITY);
  form.append('n', '1');
  form.append('image', new Blob([bytes], { type: mime }), 'in.png');
  const r = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${OAI}` }, body: form });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const data = await r.json();
  const u = data.usage || {}, it = u.input_tokens_details || {};
  const cost = (it.image_tokens || 0) * RATE.img + (it.text_tokens || 0) * RATE.txt + (u.output_tokens || 0) * RATE.out;
  return { bytes: Buffer.from(data.data[0].b64_json, 'base64'), cost };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const { png } = testcard();
  await writeFile(join(OUT, 'input-testcard.png'), png);
  console.log('built distinctive test card → running base generation (gpt-image-2 medium)…');
  const { bytes, cost } = await edit(BASE_PROMPT, png, 'image/png');
  await writeFile(join(OUT, 'output-painted.png'), bytes);
  console.log(`done — $${cost.toFixed(4)}`);
  console.log('Compare validate/out/condition/input-testcard.png vs output-painted.png');
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
