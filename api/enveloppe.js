// POST /api/enveloppe  — upload a photo, get N relit Monet keyframes.
//
// Flow: validate -> cache lookup -> cost protection -> 1 base generation +
// (N-1) edit-of-base relights (gpt-image-2 @ medium) -> store keyframes in Blob
// -> cache manifest in KV -> return { keyframes:[{hour,label,url}] }.
//
// COST PROTECTION (per the locked design):
//   - hard daily SPEND cap ($5), FAIL CLOSED: if the KV spend counter can't be
//     read/written, the job is REFUSED (503), never allowed through.
//   - per-IP rate limit (3/hr, 5/day) + global concurrency cap (~2 in flight).
//   - reserve estimated spend up front, reconcile to measured cost after.
//
// Secrets/integrations are provided by the Vercel project env (you set them):
//   OPENAI_API_KEY, plus the KV + Blob integration vars. DAILY_CAP optional.
import { kv } from '@vercel/kv';
import { put } from '@vercel/blob';
import crypto from 'node:crypto';
import { BASE_PROMPT, RELIGHT, LIGHTS, KEYFRAMES, QUALITY } from './_prompts.js';

// All limits are env-tunable (change on Vercel without a redeploy of code).
// DAILY_CAP is the HARD global ceiling on spend/day and the real backstop — the
// job is refused once the day's reserved+measured spend would exceed it.
const DAILY_CAP = Number(process.env.DAILY_CAP || 1); // USD/day, hard stop
const N = KEYFRAMES.length;
const EST_PER_IMAGE = 0.06; // conservative reservation (medium measured ~$0.053)
const EST_JOB = Number((EST_PER_IMAGE * N).toFixed(4));
const RATE = { img: 8 / 1e6, txt: 5 / 1e6, out: 30 / 1e6 }; // gpt-image-2 $/token
const PROMPT_VERSION = 'v1';
const MAX_BYTES = 12 * 1024 * 1024;
// Per-IP caps: default ONE upload per IP per hour AND per day. (IP is a soft
// signal — bypassable via VPN/other device — so DAILY_CAP above is what actually
// bounds the bill; these just stop casual repeat uploads.)
const IP_HOUR_LIMIT = Number(process.env.IP_HOUR_LIMIT || 10);
const IP_DAY_LIMIT = Number(process.env.IP_DAY_LIMIT || 30);
// Bump this to abandon poisoned rate-limit counters (e.g. after a debugging
// session inflates them past the cap). Old keys expire on their own TTL.
const RL_VER = 'v2';
const CONCURRENCY_LIMIT = Number(process.env.CONCURRENCY_LIMIT || 2);

const today = () => new Date().toISOString().slice(0, 10);
const ipOf = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // ---- validate (free, pre-flight) ----
  const { imageBase64, mime } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string')
    return res.status(400).json({ error: 'missing imageBase64' });
  if (mime && !/^image\//.test(mime)) return res.status(400).json({ error: 'not an image' });
  const bytes = Buffer.from(imageBase64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_BYTES)
    return res.status(400).json({ error: 'bad image size' });

  const hash = crypto
    .createHash('sha256')
    .update(imageBase64)
    .update(`|${N}|${QUALITY}|${PROMPT_VERSION}`)
    .digest('hex')
    .slice(0, 32);

  const date = today();
  const spendKey = `spend:${date}`;
  let reserved = false;
  let inflightInc = false;

  // ---- cache + cost protection. FAIL CLOSED: any KV error => refuse. ----
  try {
    const cached = await kv.get(`cache:${hash}`);
    if (cached) {
      return res.status(200).json({ uploadId: hash, quality: QUALITY, cached: true, keyframes: cached.keyframes });
    }

    const ip = ipOf(req);
    const hKey = `rl:h:${RL_VER}:${ip}:${date}:${new Date().getUTCHours()}`;
    const dKey = `rl:d:${RL_VER}:${ip}:${date}`;
    const h = await kv.incr(hKey);
    if (h === 1) await kv.expire(hKey, 3600);
    const d = await kv.incr(dKey);
    if (d === 1) await kv.expire(dKey, 86400);
    if (h > IP_HOUR_LIMIT || d > IP_DAY_LIMIT) {
      // Don't let a rejected attempt keep inflating the window — otherwise
      // retries/probes dig the counter ever deeper past the cap and you stay
      // blocked for the whole window even after raising the limit.
      await kv.decr(hKey);
      await kv.decr(dKey);
      return res.status(429).json({ error: 'rate_limited' });
    }

    const inflight = await kv.incr('inflight');
    inflightInc = true;
    // Self-heal: if a job is killed mid-generation (e.g. hits the function
    // timeout) its decr never runs and this counter would wedge at >LIMIT
    // forever, rejecting everyone with `busy`. A short TTL lets a leaked slot
    // expire on its own. TTL is kept safely above the function's maxDuration so
    // a legit long-running job never has its slot reaped before it decrements.
    if (inflight === 1) await kv.expire('inflight', 180);
    if (inflight > CONCURRENCY_LIMIT) {
      await kv.decr('inflight');
      inflightInc = false;
      return res.status(429).json({ error: 'busy' });
    }

    const newSpend = Number(await kv.incrbyfloat(spendKey, EST_JOB));
    reserved = true;
    if (Math.abs(newSpend - EST_JOB) < 1e-9) await kv.expire(spendKey, 172800);
    if (newSpend > DAILY_CAP) {
      await kv.incrbyfloat(spendKey, -EST_JOB);
      reserved = false;
      if (inflightInc) { await kv.decr('inflight'); inflightInc = false; }
      return res.status(503).json({ error: 'daily_cap', cap: DAILY_CAP });
    }
  } catch (e) {
    // FAIL CLOSED — release best-effort and refuse.
    try { if (reserved) await kv.incrbyfloat(spendKey, -EST_JOB); } catch {}
    try { if (inflightInc) await kv.decr('inflight'); } catch {}
    return res.status(503).json({ error: 'unavailable' });
  }

  // ---- generation (own error handling; reconciles spend either way) ----
  let actualCost = 0;
  const addCost = (c) => { actualCost += c; };
  try {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

    // base (midday) — the single generation from the photo
    const base = KEYFRAMES.find((k) => k.kind === 'base');
    const baseBytes = await edit(BASE_PROMPT, bytes, mime || 'image/jpeg', addCost);

    // relights — EDIT OF THE BASE, not the photo
    const pngByLabel = { [base.label]: baseBytes };
    for (const kf of KEYFRAMES) {
      if (kf.kind === 'base') continue;
      pngByLabel[kf.label] = await edit(RELIGHT(LIGHTS[kf.light]), baseBytes, 'image/png', addCost);
    }

    // store keyframes in Blob
    const keyframes = [];
    for (const kf of KEYFRAMES) {
      const blob = await put(`enveloppe/${hash}/${kf.label.toLowerCase()}.png`, pngByLabel[kf.label], {
        access: 'public',
        contentType: 'image/png',
        addRandomSuffix: true,
      });
      keyframes.push({ hour: kf.hour, label: kf.label, url: blob.url });
    }
    keyframes.sort((a, b) => a.hour - b.hour);

    await kv.set(`cache:${hash}`, { keyframes }, { ex: 60 * 60 * 24 * 30 });
    await reconcile(spendKey, actualCost);
    await kv.decr('inflight');
    return res.status(200).json({ uploadId: hash, quality: QUALITY, keyframes });
  } catch (e) {
    try { await reconcile(spendKey, actualCost); } catch {}
    try { await kv.decr('inflight'); } catch {}
    return res.status(502).json({ error: 'generation_failed', detail: String(e.message || e) });
  }
}

// Replace the up-front reservation with the actually-measured cost.
async function reconcile(spendKey, actualCost) {
  await kv.incrbyfloat(spendKey, Number((actualCost - EST_JOB).toFixed(4)));
}

// One gpt-image-2 edit (multipart). Retries once on 5xx/429; measures cost from
// the usage tokens. Rebuilds the form per attempt (FormData is single-use).
async function edit(prompt, imgBytes, imgMime, addCost) {
  let lastErr = 'unknown';
  for (let attempt = 0; attempt < 2; attempt++) {
    const form = new FormData();
    form.append('model', 'gpt-image-2');
    form.append('prompt', prompt);
    form.append('size', '1536x1024');
    form.append('quality', QUALITY);
    form.append('n', '1');
    form.append('image', new Blob([imgBytes], { type: imgMime }), imgMime === 'image/jpeg' ? 'in.jpg' : 'in.png');

    // Send the org explicitly when provided — without it the key uses its default
    // org, which 401s ("invalid_organization") if that default is inaccessible.
    const org = process.env.OPENAI_ORG || process.env.OPENAI_ORGANIZATION;
    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...(org ? { 'OpenAI-Organization': org } : {}),
      },
      body: form,
    });
    if (r.ok) {
      const data = await r.json();
      const u = data.usage || {};
      const it = u.input_tokens_details || {};
      addCost((it.image_tokens || 0) * RATE.img + (it.text_tokens || 0) * RATE.txt + (u.output_tokens || 0) * RATE.out);
      return Buffer.from(data.data[0].b64_json, 'base64');
    }
    lastErr = `${r.status} ${await r.text()}`;
    if (r.status < 500 && r.status !== 429) break; // don't retry hard client errors
  }
  throw new Error(`edit failed: ${lastErr}`);
}
