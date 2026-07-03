// Stitch loose comparison cells into single labeled comparison images, so the
// process/ archive keeps the COMPARISON (one image) and not the individual cells.
// PNG output (lossless — unlike the JPEG re-encode that mangled colour earlier).
// Run: node scripts/montage.mjs
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PAPER = '#efe7d8', INK = '#2b2620', SOFT = '#6b6253';
const CW = 300, PAD = 10, LBL = 20, HDR = 22; // cell width, padding, label + header bars

// grid: 2D array of { file, label } | null. colHeads/rowHeads optional string[].
async function montage(outRel, grid, { colHeads = [], rowHeads = [], title = '' } = {}) {
  // load everything, find max cell height at CW
  let cellH = 0;
  const rows = [];
  for (const row of grid) {
    const cells = [];
    for (const c of row) {
      if (c && existsSync(join(ROOT, c.file))) {
        const img = await loadImage(join(ROOT, c.file));
        const h = Math.round(CW * (img.height / img.width));
        cellH = Math.max(cellH, h);
        cells.push({ img, h, label: c.label || '' });
      } else cells.push(null);
    }
    rows.push(cells);
  }
  const cols = Math.max(...grid.map((r) => r.length));
  const rowLabW = rowHeads.length ? 84 : 0;
  const titleH = title ? 30 : 0;
  const colHdrH = colHeads.length ? HDR : 0;
  const W = rowLabW + cols * (CW + PAD) + PAD;
  const cellBox = cellH + LBL;
  const H = titleH + colHdrH + rows.length * (cellBox + PAD) + PAD;

  const cv = createCanvas(W, H);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';

  if (title) {
    ctx.fillStyle = INK; ctx.font = '600 16px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(title, PAD, titleH / 2 + 4);
  }
  if (colHeads.length) {
    ctx.fillStyle = SOFT; ctx.font = '600 12px sans-serif'; ctx.textAlign = 'center';
    colHeads.forEach((h, i) => ctx.fillText(h, rowLabW + PAD + i * (CW + PAD) + CW / 2, titleH + colHdrH / 2));
  }
  for (let r = 0; r < rows.length; r++) {
    const y0 = titleH + colHdrH + r * (cellBox + PAD) + PAD;
    if (rowHeads[r]) {
      ctx.fillStyle = INK; ctx.font = '600 12px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(rowHeads[r], PAD, y0 + cellH / 2);
    }
    for (let c = 0; c < rows[r].length; c++) {
      const cell = rows[r][c];
      const x0 = rowLabW + PAD + c * (CW + PAD);
      if (!cell) {
        ctx.fillStyle = SOFT; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('—', x0 + CW / 2, y0 + cellH / 2);
        continue;
      }
      const w = CW, h = cell.h, x = x0, y = y0 + (cellH - h) / 2;
      ctx.drawImage(cell.img, x, y, w, h);
      if (cell.label) {
        ctx.fillStyle = SOFT; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(cell.label, x0 + CW / 2, y0 + cellH + LBL / 2 + 1);
      }
    }
  }
  await writeFile(join(ROOT, outRel), cv.toBuffer('image/png'));
  console.log('wrote', outRel);
}

const M = '2-keyframe-model-selection';
const g = (dir, f, label) => ({ file: `process/${dir}/${f}`, label });

// 1. model bake-off: rows = model, cols = base/day/dusk
await montage(`process/${M}/model-bakeoff.png`, [
  [g(`${M}/flux-vs-openai-vs-gemini`, 'flux-base.png'), g(`${M}/flux-vs-openai-vs-gemini`, 'flux-day.png'), g(`${M}/flux-vs-openai-vs-gemini`, 'flux-dusk.png')],
  [g(`${M}/flux-vs-openai-vs-gemini`, 'openai-base.png'), g(`${M}/flux-vs-openai-vs-gemini`, 'openai-day.png'), g(`${M}/flux-vs-openai-vs-gemini`, 'openai-dusk.png')],
  [g(`${M}/flux-vs-openai-vs-gemini`, 'openai-med-base.png'), g(`${M}/flux-vs-openai-vs-gemini`, 'openai-med-day.png'), g(`${M}/flux-vs-openai-vs-gemini`, 'openai-med-dusk.png')],
  [g(`${M}/flux-vs-openai-vs-gemini`, 'gemini-base.png'), null, null],
], { title: 'Keyframe model bake-off (photo → Monet, then relit)', colHeads: ['base (midday)', 'day', 'dusk'], rowHeads: ['FLUX', 'OpenAI', 'OpenAI med', 'Gemini'] });

// 2. gemini sweep: rows = strength, cols = resolution
await montage(`process/${M}/gemini-sweep.png`, [
  [g(`${M}/gemini-sweep`, 'cell-mild-low.png'), g(`${M}/gemini-sweep`, 'cell-mild-med.png'), g(`${M}/gemini-sweep`, 'cell-mild-full.png')],
  [g(`${M}/gemini-sweep`, 'cell-strong-low.png'), g(`${M}/gemini-sweep`, 'cell-strong-med.png'), g(`${M}/gemini-sweep`, 'cell-strong-full.png')],
  [g(`${M}/gemini-sweep`, 'cell-extreme-low.png'), g(`${M}/gemini-sweep`, 'cell-extreme-med.png'), g(`${M}/gemini-sweep`, 'cell-extreme-full.png')],
], { title: 'Gemini style-strength × source-resolution sweep', colHeads: ['low-res src', 'med-res src', 'full-res src'], rowHeads: ['mild', 'strong', 'extreme'] });

// 3. conditioning: input vs painted output
await montage(`process/${M}/conditioning-compare.png`, [
  [g(`${M}/conditioning`, 'input-testcard.png', 'input test-card'), g(`${M}/conditioning`, 'output-painted.png', 'painted output')],
], { title: 'Conditioning — how much composition survives' });

// 4. dab density
await montage('process/5-brushstroke-density/density-compare.png', [
  [g('5-brushstroke-density', 'crop-0_9.png', 'dens 0.9'), g('5-brushstroke-density', 'crop-1_5.png', 'dens 1.5'), g('5-brushstroke-density', 'crop-2_1.png', 'dens 2.1 (shipped)')],
], { title: 'Brushstroke density (density is ~free on fps → maxed)' });

// 5. relight before/after (old "tint only" cur vs new real relight)
await montage('process/3-relight/relight-compare.png', [
  [g('3-relight', 'cur-dawn.png', 'dawn — before'), g('3-relight', 'new-dawn.png', 'dawn — after')],
  [g('3-relight', 'cur-dusk.png', 'dusk — before'), g('3-relight', 'new-dusk.png', 'dusk — after')],
], { title: 'Relight prompt fix — tint-only (before) vs true relight (after)' });
