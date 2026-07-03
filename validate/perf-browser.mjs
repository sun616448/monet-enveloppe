// Real-BROWSER perf + capture for the auto-advancing day. Drives the built app in
// system Chrome (GPU canvas, not node-skia) via Playwright. Measures sustained FPS
// during continuous auto-advance, then records a video of auto-advance + a
// grab/scrub/release handoff. Run: node validate/perf-browser.mjs  (server on :4173)
import { chromium } from 'playwright';
import { mkdir, readdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out', 'perf');
await mkdir(OUT, { recursive: true });
const URL = process.env.URL || 'http://localhost:4173/';

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const context = await browser.newContext({
  viewport: { width: 1100, height: 760 },
  recordVideo: { dir: OUT, size: { width: 1100, height: 760 } },
});
const page = await context.newPage();
await page.goto(URL, { waitUntil: 'load' }).catch(() => page.goto(URL));
await page.waitForSelector('#canvas', { timeout: 15000 });
await page.waitForTimeout(2500); // let the gallery scene load + auto-advance start

// canvas backing-store size (the real working resolution)
const dims = await page.evaluate(() => {
  const c = document.getElementById('canvas');
  return { w: c.width, h: c.height, fps: document.getElementById('fps').textContent };
});

// sustained FPS over 6 s of auto-advance (rAF interval distribution = presented frames)
const perf = await page.evaluate(
  (ms) =>
    new Promise((res) => {
      const ts = [];
      const loop = (t) => {
        ts.push(t);
        if (t - ts[0] < ms) requestAnimationFrame(loop);
        else {
          const iv = [];
          for (let i = 1; i < ts.length; i++) iv.push(ts[i] - ts[i - 1]);
          iv.sort((a, b) => a - b);
          const n = iv.length;
          const long = iv.filter((x) => x > 20).length;
          res({
            fps: (ts.length - 1) / ((ts[ts.length - 1] - ts[0]) / 1000),
            frames: ts.length - 1,
            medianMs: iv[n >> 1],
            p95Ms: iv[Math.floor(n * 0.95)],
            maxMs: iv[n - 1],
            longFrames: long,
            longPct: ((long / n) * 100).toFixed(1),
          });
        }
      };
      requestAnimationFrame(loop);
    }),
  6000
);

await page.locator('#stage').screenshot({ path: join(OUT, 'auto-advance.png') });

// grab / scrub / release on the timeline
const box = await page.locator('#timeSlider').boundingBox();
const y = box.y + box.height / 2;
const grabX = box.x + box.width * 0.5; // grab near the moving thumb's general area
await page.mouse.move(grabX, y);
await page.mouse.down();              // GRAB — auto-advance yields
await page.waitForTimeout(150);
await page.locator('#stage').screenshot({ path: join(OUT, 'scrub-grab.png') });
for (let i = 0; i <= 10; i++) {       // drag back and forth
  const x = box.x + box.width * (0.5 + 0.35 * Math.sin((i / 10) * Math.PI));
  await page.mouse.move(x, y);
  await page.waitForTimeout(60);
}
await page.locator('#stage').screenshot({ path: join(OUT, 'scrub-hold.png') });
await page.mouse.up();                // RELEASE — auto-advance resumes from here
await page.waitForTimeout(2500);
await page.locator('#stage').screenshot({ path: join(OUT, 'scrub-released.png') });

const clock = await page.evaluate(() => document.getElementById('clock').textContent);
console.log('working resolution:', dims.w + 'x' + dims.h, '| app fps readout:', dims.fps);
console.log('SUSTAINED auto-advance FPS:', perf.fps.toFixed(1),
  `| median ${perf.medianMs.toFixed(1)}ms p95 ${perf.p95Ms.toFixed(1)}ms max ${perf.maxMs.toFixed(1)}ms`,
  `| long(>20ms) frames ${perf.longFrames} (${perf.longPct}%)`);
console.log('clock after resume:', clock);

await context.close(); // flush video
await browser.close();
// name the video deterministically
for (const f of await readdir(OUT)) if (f.endsWith('.webm')) { await rename(join(OUT, f), join(OUT, 'capture.webm')); break; }
console.log('wrote validate/out/perf/{auto-advance,scrub-*}.png + capture.webm');
