// Minimal headless FPS probe for the auto-advancing day. Same rAF-interval logic
// as perf-browser.mjs but no screenshots/video (which flake on visible Chrome),
// so it reliably prints the sustained-FPS number while tuning dab density.
// Run: node validate/fps-probe.mjs   (preview server on :4173)
import { chromium } from 'playwright';

const BASE = process.env.URL || 'http://localhost:4173/';
// sweep values passed as CLI args, e.g. `node fps-probe.mjs 0.9 1.2 1.4` (dens);
// combine with SIZE=/BUDGET= env to hold those constant across the sweep.
const densList = process.argv.slice(2).map(Number).filter(Number.isFinite);
const sweep = densList.length ? densList : [undefined];
const SIZE = process.env.SIZE, BUDGET = process.env.BUDGET;

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });

async function measure(dens) {
  const u = new URL(BASE);
  if (dens !== undefined) u.searchParams.set('dens', dens);
  if (SIZE) u.searchParams.set('size', SIZE);
  if (BUDGET) u.searchParams.set('budget', BUDGET);
  await page.goto(u.href, { waitUntil: 'load' }).catch(() => page.goto(u.href));
  await page.waitForSelector('#canvas', { timeout: 15000 });
  await page.waitForTimeout(2500); // let a scene load + auto-advance start

  const dims = await page.evaluate(() => {
    const c = document.getElementById('canvas');
    return { w: c.width, h: c.height };
  });

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
            medianMs: iv[n >> 1],
            p95Ms: iv[Math.floor(n * 0.95)],
            maxMs: iv[n - 1],
            longPct: ((long / n) * 100).toFixed(1),
          });
        }
      };
      requestAnimationFrame(loop);
    }),
    6000
  );

  console.log(
    `dens ${dens ?? '(config)'} size ${SIZE ?? '·'} budget ${BUDGET ?? '·'} | ` +
      `res ${dims.w}x${dims.h} | FPS ${perf.fps.toFixed(1)} | median ${perf.medianMs.toFixed(1)}ms ` +
      `p95 ${perf.p95Ms.toFixed(1)}ms max ${perf.maxMs.toFixed(1)}ms | long(>20ms) ${perf.longPct}%`
  );
}

for (const d of sweep) await measure(d);
await browser.close();
