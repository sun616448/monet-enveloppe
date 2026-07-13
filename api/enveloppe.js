// POST /api/enveloppe  — upload a photo, get Monet keyframes relit across the day.
//
// TWO-STAGE delivery (cuts time-to-first-paint): stage 'initial' (default) does
// 1 base generation + 1 edit-of-base relight (midday + dusk) and streams back as
// soon as those two are done — the client can already show/scrub the scene. A
// SECOND request, stage 'night', does the last (deferred) relight from the base
// image the first response handed back, so the photo/base never regenerates.
//
// Each stage is itself streamed via SSE using OpenAI's partial-image streaming:
// the client gets rough in-progress previews as each image renders, not just a
// spinner, THEN a `complete` event per keyframe, THEN a final `done` event.
//
// COST PROTECTION (per the locked design, unchanged by staging):
//   - hard daily SPEND cap ($5 default), FAIL CLOSED: if the KV spend counter
//     can't be read/written, the job is REFUSED (503), never allowed through.
//   - per-IP rate limit (hour/day) + global concurrency cap, checked per stage.
//   - reserve estimated spend up front (sized to that stage's image count),
//     reconcile to measured cost after.
//
// Secrets/integrations are provided by the Vercel project env (you set them):
//   OPENAI_API_KEY, plus the KV integration vars. DAILY_CAP optional.
// Keyframes are returned INLINE as base64 data URLs (no Blob store to
// configure); the browser loads them straight from the stream.
import { kv } from '@vercel/kv';
import crypto from 'node:crypto';
import { BASE_PROMPT, RELIGHT, LIGHTS, KEYFRAMES, QUALITY } from './_prompts.js';

const DAILY_CAP = Number(process.env.DAILY_CAP || 1); // USD/day, hard stop
const IMMEDIATE_KEYFRAMES = KEYFRAMES.filter((k) => !k.deferred); // midday, dusk
const DEFERRED_KEYFRAMES = KEYFRAMES.filter((k) => k.deferred); // night
const EST_PER_IMAGE = 0.06; // conservative reservation (medium measured ~$0.053; low is cheaper)
const EST_INITIAL = Number((EST_PER_IMAGE * IMMEDIATE_KEYFRAMES.length).toFixed(4));
const EST_NIGHT = Number((EST_PER_IMAGE * DEFERRED_KEYFRAMES.length).toFixed(4));
const RATE = { img: 8 / 1e6, txt: 5 / 1e6, out: 30 / 1e6 }; // gpt-image-2 $/token
const MAX_BYTES = 12 * 1024 * 1024;
const PARTIAL_IMAGES = 2; // in-progress previews per generated image (0-3 supported)
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
  const body = req.body || {};
  if (body.stage === 'night') return handleNight(req, res, body);
  return handleInitial(req, res, body);
}

// ---- stage: initial (midday + dusk) ----------------------------------------

async function handleInitial(req, res, body) {
  const { imageBase64, mime } = body;
  if (!imageBase64 || typeof imageBase64 !== 'string')
    return res.status(400).json({ error: 'missing imageBase64' });
  if (mime && !/^image\//.test(mime)) return res.status(400).json({ error: 'not an image' });
  const bytes = Buffer.from(imageBase64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_BYTES)
    return res.status(400).json({ error: 'bad image size' });

  const hash = crypto.createHash('sha256').update(imageBase64).update(`|initial|${QUALITY}`).digest('hex').slice(0, 32);
  const date = today();
  const budget = await reserveBudget(req, date, EST_INITIAL);
  if (!budget.ok) return res.status(budget.status).json(budget.body);

  const sse = openSSE(res);
  let actualCost = 0;
  const addCost = (c) => { actualCost += c; };
  try {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

    const base = IMMEDIATE_KEYFRAMES.find((k) => k.kind === 'base');
    const baseBytes = await streamedEdit(BASE_PROMPT, bytes, mime || 'image/jpeg', addCost, (b64) =>
      sse.send({ type: 'partial', label: base.label, dataUrl: `data:image/png;base64,${b64}` })
    );
    sse.send({ type: 'complete', label: base.label, hour: base.hour, dataUrl: `data:image/png;base64,${baseBytes.toString('base64')}` });

    const relights = IMMEDIATE_KEYFRAMES.filter((k) => k.kind !== 'base');
    // relights are edits OF THE BASE and depend only on it, so run concurrently
    await Promise.all(
      relights.map(async (kf) => {
        const png = await streamedEdit(RELIGHT(LIGHTS[kf.light]), baseBytes, 'image/png', addCost, (b64) =>
          sse.send({ type: 'partial', label: kf.label, dataUrl: `data:image/png;base64,${b64}` })
        );
        sse.send({ type: 'complete', label: kf.label, hour: kf.hour, dataUrl: `data:image/png;base64,${png.toString('base64')}` });
      })
    );

    await budget.reconcile(actualCost);
    sse.send({
      type: 'done',
      uploadId: hash,
      quality: QUALITY,
      baseImage: DEFERRED_KEYFRAMES.length ? baseBytes.toString('base64') : undefined,
      deferred: DEFERRED_KEYFRAMES.map((k) => ({ hour: k.hour, label: k.label })),
    });
  } catch (e) {
    try { await budget.reconcile(actualCost); } catch {}
    sse.send({ type: 'error', code: 'generation_failed', detail: String(e.message || e) });
  } finally {
    sse.end();
  }
}

// ---- stage: night (deferred relight of the already-generated base) ---------

async function handleNight(req, res, body) {
  const { baseImage } = body;
  if (!baseImage || typeof baseImage !== 'string')
    return res.status(400).json({ error: 'missing baseImage' });
  const baseBytes = Buffer.from(baseImage, 'base64');
  if (baseBytes.length === 0 || baseBytes.length > MAX_BYTES)
    return res.status(400).json({ error: 'bad image size' });
  if (!DEFERRED_KEYFRAMES.length) return res.status(400).json({ error: 'nothing deferred' });

  const date = today();
  const budget = await reserveBudget(req, date, EST_NIGHT);
  if (!budget.ok) return res.status(budget.status).json(budget.body);

  const sse = openSSE(res);
  let actualCost = 0;
  const addCost = (c) => { actualCost += c; };
  try {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

    await Promise.all(
      DEFERRED_KEYFRAMES.map(async (kf) => {
        const png = await streamedEdit(RELIGHT(LIGHTS[kf.light]), baseBytes, 'image/png', addCost, (b64) =>
          sse.send({ type: 'partial', label: kf.label, dataUrl: `data:image/png;base64,${b64}` })
        );
        sse.send({ type: 'complete', label: kf.label, hour: kf.hour, dataUrl: `data:image/png;base64,${png.toString('base64')}` });
      })
    );

    await budget.reconcile(actualCost);
    sse.send({ type: 'done' });
  } catch (e) {
    try { await budget.reconcile(actualCost); } catch {}
    sse.send({ type: 'error', code: 'generation_failed', detail: String(e.message || e) });
  } finally {
    sse.end();
  }
}

// ---- shared: rate limit + spend reservation ---------------------------------
// Returns { ok:false, status, body } to send as a plain JSON rejection, or
// { ok:true, reconcile(actualCost) } — reconcile swaps the up-front estimate
// for the measured cost and always releases the concurrency slot, exactly once,
// on both the success and failure paths.
async function reserveBudget(req, date, estJob) {
  const spendKey = `spend:${date}`;
  const ip = ipOf(req);
  let reserved = false;
  let inflightInc = false;
  try {
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
      return { ok: false, status: 429, body: { error: 'rate_limited' } };
    }

    const inflight = await kv.incr('inflight');
    inflightInc = true;
    // Self-heal: if a job is killed mid-generation its decr never runs and this
    // counter would wedge at >LIMIT forever, rejecting everyone with `busy`. A
    // short TTL lets a leaked slot expire on its own, safely below maxDuration.
    if (inflight === 1) await kv.expire('inflight', 180);
    if (inflight > CONCURRENCY_LIMIT) {
      await kv.decr('inflight');
      inflightInc = false;
      return { ok: false, status: 429, body: { error: 'busy' } };
    }

    const newSpend = Number(await kv.incrbyfloat(spendKey, estJob));
    reserved = true;
    if (Math.abs(newSpend - estJob) < 1e-9) await kv.expire(spendKey, 172800);
    if (newSpend > DAILY_CAP) {
      await kv.incrbyfloat(spendKey, -estJob);
      reserved = false;
      await kv.decr('inflight');
      inflightInc = false;
      return { ok: false, status: 503, body: { error: 'daily_cap', cap: DAILY_CAP } };
    }
  } catch (e) {
    // FAIL CLOSED — release best-effort and refuse.
    try { if (reserved) await kv.incrbyfloat(spendKey, -estJob); } catch {}
    try { if (inflightInc) await kv.decr('inflight'); } catch {}
    return { ok: false, status: 503, body: { error: 'unavailable' } };
  }
  return {
    ok: true,
    reconcile: async (actualCost) => {
      try { await kv.incrbyfloat(spendKey, Number((actualCost - estJob).toFixed(4))); } catch {}
      try { await kv.decr('inflight'); } catch {}
    },
  };
}

// ---- shared: our own SSE relay to the browser -------------------------------
function openSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  return {
    send: (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`),
    end: () => res.end(),
  };
}

// ---- one gpt-image-2 edit (multipart, streamed) -----------------------------
// Streams OpenAI's partial-image events through `onPartial(b64)` as they arrive,
// and returns the final image bytes once the edit completes. Retries once on
// 5xx/429 (a retried attempt just re-streams fresh partials — the caller only
// ever cares about the latest one, so no special handling needed there).
async function streamedEdit(prompt, imgBytes, imgMime, addCost, onPartial) {
  let lastErr = 'unknown';
  for (let attempt = 0; attempt < 2; attempt++) {
    const form = new FormData();
    form.append('model', 'gpt-image-2');
    form.append('prompt', prompt);
    // Square, not the wider 1536x1024: latency/cost scale with token count (≈
    // pixel area), and 1024x1024 is ~33% fewer pixels — the biggest single lever
    // on wall-clock time for the base + relight calls. Output canvas ends up
    // square regardless of the uploaded photo's own aspect ratio (already true
    // before this change, since gpt-image-2 only offers these 3 fixed sizes).
    form.append('size', '1024x1024');
    form.append('quality', QUALITY);
    form.append('n', '1');
    form.append('stream', 'true');
    form.append('partial_images', String(PARTIAL_IMAGES));
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
      let finalB64 = null;
      let usage = {};
      try {
        for await (const evt of sseEvents(r)) {
          if (evt.type === 'image_edit.partial_image' && evt.b64_json) {
            onPartial(evt.b64_json);
          } else if (evt.type === 'image_edit.completed' && evt.b64_json) {
            finalB64 = evt.b64_json;
            usage = evt.usage || usage;
          }
        }
      } catch (streamErr) {
        lastErr = `stream error: ${streamErr.message || streamErr}`;
        continue; // treat like a failed attempt, retry once
      }
      if (finalB64) {
        const it = usage.input_tokens_details || {};
        addCost((it.image_tokens || 0) * RATE.img + (it.text_tokens || 0) * RATE.txt + (usage.output_tokens || 0) * RATE.out);
        return Buffer.from(finalB64, 'base64');
      }
      lastErr = 'stream ended without a completed image';
      continue;
    }
    lastErr = `${r.status} ${await r.text()}`;
    if (r.status < 500 && r.status !== 429) break; // don't retry hard client errors
  }
  throw new Error(`edit failed: ${lastErr}`);
}

// Parse an SSE response body into a stream of parsed JSON event objects. Only
// reads `data:` lines — event names (if any) are carried in the JSON's own
// `type` field, so a bare `data:`-only stream works the same as `event:`+`data:`.
async function* sseEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLines = raw.split('\n').filter((l) => l.startsWith('data:'));
        if (!dataLines.length) continue;
        const jsonStr = dataLines.map((l) => l.slice(5).trim()).join('');
        if (jsonStr === '[DONE]') continue;
        try { yield JSON.parse(jsonStr); } catch {}
      }
    }
  } finally {
    // Runs on normal completion AND on early exit (e.g. the caller's retry
    // loop `continue`s out of the for-await after a mid-stream error) — a
    // leaked locked reader would otherwise keep that upstream connection open.
    reader.releaseLock();
  }
}
