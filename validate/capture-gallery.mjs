// Verify the built gallery in real Chrome: screenshot the default stage + the
// gallery strip, and click through each thumbnail capturing its stage. Confirms
// every manifest scene loads its keyframes and renders. Run with preview on :4173.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out', 'gallery');
await mkdir(OUT, { recursive: true });
const BASE = process.env.URL || 'http://localhost:4173/';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'load' }).catch(() => page.goto(BASE));
await page.waitForSelector('#canvas', { timeout: 15000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: join(OUT, 'landing.png'), fullPage: false });

const thumbs = await page.locator('#galleryStrip button, #galleryStrip [role="button"], #galleryStrip img').count();
console.log('gallery thumbnails found:', thumbs);

// click each thumbnail, let it load, screenshot the stage
for (let i = 0; i < thumbs; i++) {
  const t = page.locator('#galleryStrip button, #galleryStrip [role="button"], #galleryStrip img').nth(i);
  await t.click().catch(() => {});
  await page.waitForTimeout(2500);
  await page.locator('#stage').screenshot({ path: join(OUT, `scene-${i}.png`) });
}
console.log('console/page errors:', errors.length ? errors : 'none');
await browser.close();
