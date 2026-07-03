// Freeze a MID-transition frame at several dab densities so the emerging strokes
// can be eyeballed (perf is flat vs density — the real ceiling is visual). Grabs
// the timeline near the middle so dabs are half-revealed, then screenshots the
// stage. Run: node validate/capture-dabs.mjs 1.3 1.7 2.1   (preview on :4173)
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out', 'dabs');
await mkdir(OUT, { recursive: true });
const BASE = process.env.URL || 'http://localhost:4173/';
const SIZE = process.env.SIZE;
const sweep = process.argv.slice(2).map(Number).filter(Number.isFinite);
const list = sweep.length ? sweep : [1.7];

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });

for (const dens of list) {
  const u = new URL(BASE);
  u.searchParams.set('dens', dens);
  if (SIZE) u.searchParams.set('size', SIZE);
  await page.goto(u.href, { waitUntil: 'load' }).catch(() => page.goto(u.href));
  await page.waitForSelector('#canvas', { timeout: 15000 });
  // auto-advance is always mid-segment; a plain screenshot catches a half-painted
  // frame (no flaky mouse drag). Wait a touch so we're inside a segment interior.
  await page.waitForTimeout(4000);
  const tag = `dens-${String(dens).replace('.', '_')}${SIZE ? `-size-${String(SIZE).replace('.', '_')}` : ''}`;
  await page.locator('#stage').screenshot({ path: join(OUT, `${tag}.png`) });
  console.log('wrote', join('validate/out/dabs', `${tag}.png`));
}
await browser.close();
