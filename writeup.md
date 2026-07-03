# Monet Enveloppe — Technical Writeup

A record of the stylization methods this project has gone through, why each was
tried, how each is architected, and why we moved on. The goal throughout has
been the same: take an uploaded photo and make it look like a **Monet painting**
that drifts through the changing light of a day (Monet's *série* / *l'enveloppe*
concept).

The first three engines pursued this **entirely client-side** — no backend, no
API keys. The fourth deliberately abandoned that constraint. The project's locked
vision is a *brushstroke repaint* between **genuinely relit keyframes** (§4): a
repaint between recolored copies of one painting is a *fake* repaint, so the day
needs more than one canvas re-tinted per hour. No client-side method could
produce relightable keyframes, so the project moved to a hosted, image-conditioned
generative model and accepted a small per-upload cost.

Four stylization engines, in order:

1. **Arbitrary image stylization** (Ghiasi et al.) — two small networks, tfjs.
2. **CycleGAN `style_monet`** (Zhu et al.) — image-to-image GAN, ONNX + onnxruntime-web.
3. **Gatys optimization** — VGG19 + iterative optimization, tfjs (last client-side engine).
4. **Hosted image model** (OpenAI gpt-image-2) — image-conditioned relight keyframes, server-side (current direction).

The headline lesson: there is a spectrum from *structure-preserving* methods
(fast, but look like a filtered photo) to *texture-imposing* methods (slower,
but look like an actual painting). The project walked that spectrum end to end
client-side, then concluded that production-quality paint — and a painting that
can actually be *relit* for the repaint — was worth stepping off it onto a hosted
model.

---

## 0. The invariant: the "enveloppe" color-drift system

Independent of which stylization engine is in use, the time-of-day machinery is
the same, and it's worth describing once.

### Reference palette

Paintings live in `public/monet-refs/` and are auto-discovered at build time by
a small Vite plugin (`monetRefsPlugin` in `vite.config.js`), exposed to the app
as the virtual module `virtual:monet-refs` (`REFERENCES = [{ src, title }]`).
Files are ordered by natural-sort on filename and **spaced evenly across the 24h
day** (`assignHoursEvenly` in `src/app.js`): with *n* paintings, painting *i*
sits at hour `i*24/n`, with a wrap segment from the last back to the first
across midnight.

### Interpolation

`src/enveloppe.js` provides `locate(sortedAnchors, hour) -> { a, b, t }`: the two
references bracketing a given hour and the fractional position `t` between them
(wrapping across midnight). This drives both the color drift and, in the Gatys
engine, the choice of style target.

### Per-frame compositing

Each reference's **color statistics** (per-channel mean/std, computed once from a
downscaled copy) are cached. Every `requestAnimationFrame`, for the current hour
we interpolate the two nearest references' stats and re-tint the cached
stylized image toward them. This is cheap plain-JS pixel work
(`composeFrame` in `src/color.js`), so the day-sweep stays smooth regardless of
how expensive the stylization itself was.

This compositing has two knobs, both live (they do **not** re-run stylization):

- **Palette match** — how strongly to pull colors toward the hour's palette.
- **Strength** — cross-fade between the original photo and the stylized result.

> **Color-transfer subtlety (important).** The compositing originally used a
> full **Reinhard color transfer** (match both mean *and* standard deviation of
> the output to the target palette). This is fine when the stylized base is
> low-contrast, but a punchy painting matched to a low-contrast reference
> palette gets its contrast **crushed** — the image washes out to a milky haze.
> Measured example: a Gatys painting had per-channel std ≈ `[48,44,74]`; the
> noon `pale-lavender` reference has std ≈ `[19,19,21]` and mean ≈ `[200,208,241]`.
> At 50% Reinhard the painting was dragged bright and flat. The fix was to switch
> to a **mean-only tint**: shift the color cast toward the target mean (per-hour
> temperature) but preserve the painting's own contrast/brushwork. See
> `composeFrame`.

### Palette ordering matters (it's a loop)

Because the day wraps at midnight, the references form a **cycle**, so the first
and last must also transition smoothly. We order them as a **brightness loop** —
dimmest near midnight, brightest near midday — which both minimizes the
adjacent jumps and makes the "light" track real time of day. Concretely, after
reordering, the worst single palette jump dropped from 142 to 101 and the
midnight wrap from 142 to 49 (Euclidean distance in mean-RGB).

### What the repaint engine changes (forward note)

Engines 1–3 used this colour drift as the **whole** day: one cached stylization,
re-tinted per hour. The hosted engine (§4) keeps the drift but demotes it to
*within-segment* duty. The day is now anchored by **N genuinely relit keyframes**;
the **brushstroke repaint** animates the transition between adjacent keyframes;
and `composeFrame` does only the fine colour motion *between* anchors. Same
machinery, smaller job — the heavy lifting of "different light" moves from a
colour tint to a real relit painting.

---

## 1. Arbitrary image stylization (Ghiasi et al.) — the first engine

**Reference:** Ghiasi et al., *Exploring the structure of a real-time, arbitrary
neural artistic stylization network* (2017); tfjs port by Reiichiro Nakano.
**Runtime:** `@tensorflow/tfjs` (WebGL).

### Architecture

Two networks:

- **Style prediction network** (Inception/MobileNet backbone): takes a style
  image and produces a **100-D "style bottleneck"** vector,
  `image -> [1,1,1,100]`. Run **once per reference painting** at load and cached.
- **Style transform network**: takes `[content image, style bottleneck]` and
  produces a stylized image, `[1,h,w,3]`. Resident; one forward pass per frame.

### How it was used here

Because we had direct access to the 100-D bottleneck (rather than the
`@magenta/image` wrapper), we could **interpolate styles per frame**:

- `predictStyleBottleneck(refImage)` → cache a vector per painting.
- Per frame: `lerpBottleneck(b0, b1, t)` between the two nearest hours, then
  `stylize(contentTensor, bottleneck)` — one forward pass.
- `applyStrength` blended the style bottleneck with the *photo's own* bottleneck
  to dial stylization down.
- A `STYLE_SIZE` knob downscaled the style image before extraction (smaller →
  proportionally larger brushstrokes).

### Why we moved on

- **Inherently mild.** The model is built to generalize to *any* style from one
  example; that generality means it captures palette and loose texture but never
  commits to Monet's hand. Output read as "tinted photo."
- **Interpolation washout.** Linearly interpolating two 100-D style vectors
  yields a vector of *smaller magnitude* than either endpoint, so between-hour
  mixes were even weaker than the anchors. We added a "style gain" (extrapolate
  the interpolated vector away from the palette's mean bottleneck) and lowered
  `STYLE_SIZE`, which helped but couldn't overcome the fundamental mildness.

**Verdict:** too weak. Doesn't look like Monet.

---

## 2. CycleGAN `style_monet` — the second engine

**Reference:** Zhu, Park, Isola & Efros, *Unpaired Image-to-Image Translation
using Cycle-Consistent Adversarial Networks* (2017). The official
`style_monet` generator.
**Runtime:** `onnxruntime-web` (WASM).

### Architecture

A single **ResNet generator** (fully convolutional): `c7s1-64, d128, d256,
9×ResnetBlock(256), u128, u64, c7s1-3, tanh`, with **InstanceNorm** and
**reflection padding**. Input/output are RGB in `[-1,1]`, NCHW. Fully
convolutional ⇒ accepts arbitrary H×W (downsamples by 4×, so dims must be
multiples of 4).

Trained with a **cycle-consistency loss**: photo→Monet→photo must reconstruct
the original. This is the crux of its behavior (below).

### Conversion pipeline (PyTorch → browser)

There is **no** ready-made browser build of this model anywhere (checked ml5,
HuggingFace). So we built one offline, in an isolated venv (`.convert-venv`):

1. Downloaded the authors' pretrained PyTorch checkpoint (`style_monet.pth`,
   ~45 MB) — a bare generator `state_dict`.
2. Vendored the `ResnetGenerator` architecture (`convert/export_onnx.py`) so we
   didn't need the whole training repo. Key gotcha: the pretrained norm layers
   are `InstanceNorm2d(affine=False, track_running_stats=True)` — i.e. they carry
   `running_mean`/`running_var` but no affine weights; the state_dict won't load
   under the wrong config.
3. Exported to ONNX. The naive chain PyTorch→TF→tfjs is broken on Python 3.12
   (`onnx-tf` is abandoned), so we went **PyTorch → ONNX → onnxruntime-web**
   instead. The modern `dynamo` exporter handled InstanceNorm + ReflectionPad
   cleanly with dynamic H/W axes; the legacy exporter choked. The dynamo path
   spilled weights to an external `.onnx.data` sidecar, so we **consolidated**
   back into one self-contained `.onnx` with `onnx.save_model(...,
   save_as_external_data=False)`.
4. Validated in Python with `onnxruntime` (the *same* engine as the browser)
   before writing any browser code.

### Browser runtime

`src/cyclegan.js`:

- `ort.env.wasm.numThreads = 1` (avoids the cross-origin-isolation COOP/COEP
  headers that multi-threaded ORT needs — keeps it a plain static site).
- `ort.env.wasm.wasmPaths` → jsDelivr CDN matching the package version (so we
  don't bundle the `.wasm` binaries).
- Preprocess canvas → NCHW `[-1,1]`; run; postprocess → RGBA `ImageData`.
- Runs **once per uploaded photo**; the result is cached and the per-hour color
  drift composites on top. A multi-pass option (feed the output back in, since
  the tanh output is already in the input domain) compounded the effect.

### Why we moved on

CycleGAN is **structure-preserving by design** — the cycle-consistency loss
explicitly rewards keeping the photo reconstructable, so the generator makes
conservative edits (recolor, light texture) and keeps every photographic edge.
We empirically confirmed this: rendering passes 1→4 showed texture accumulating
but the building edges, windows, and layout staying *frozen*. Pushing harder
(more passes, strength extrapolation `>1`) only added an HDR-sharpen "bad
filter" look, not paint.

**Verdict:** looks like a filtered photo, never a painting. This is a ceiling of
the method, not a tuning problem.

---

## 3. Gatys optimization — the current engine

**Reference:** Gatys, Ecker & Bethge, *A Neural Algorithm of Artistic Style*
(2015), over VGG19 features (Simonyan & Zisserman, 2014).
**Runtime:** `@tensorflow/tfjs` (WebGL), with a hand-built differentiable VGG19.

### Why this is categorically different

Instead of a network that *maps* photo→painting, Gatys **optimizes the image's
pixels directly** to minimize:

- **Content loss** — MSE between the image's and the photo's features at one
  deep layer (`conv4_2`). Keeps the subject recognizable.
- **Style loss** — MSE between the **Gram matrices** of the image's and a real
  Monet's features at several layers (`conv1_1, conv2_1, conv3_1, conv4_1,
  conv5_1`). Gram matrices capture feature *co-occurrence* — i.e. texture —
  discarding spatial layout. Matching them **imposes the painting's brushwork
  everywhere** and *destroys* photographic structure.

That destruction is exactly what reads as "an actual painting." It's the
texture-imposing end of the spectrum.

`total = contentWeight·contentLoss + styleWeight·styleLoss`, with
`contentWeight = 5`, `styleWeight = 1e6` (calibrated). Higher content weight
keeps more of the photo.

### Calibration in Python first (`convert/gatys.py`)

Optimization style transfer is finicky (layer choice, Gram normalization, loss
weights, optimizer), so we validated the entire recipe in PyTorch before porting:

- VGG19 `features`, **in-place ReLU disabled** (otherwise the captured
  activations are overwritten and autograd fails — the classic Gatys gotcha).
- Features captured **post-conv, pre-ReLU**.
- Gram normalized by `C·H·W`.
- ImageNet normalization on input.
- Validated with both **LBFGS** (quality ceiling) and **Adam** (what the browser
  must use, since tfjs has no LBFGS). Adam @ lr 0.02, ~400–500 iters, 256px
  reproduced the painterly look. This locked the hyperparameters that the
  browser code mirrors.

### VGG19 weight export (`convert/export_vgg.py`)

We can't run an optimization loop through a tfjs *GraphModel* (no autodiff), so
we implement VGG19 manually with `tf.conv2d` (which **is** differentiable in
tfjs). We export the raw conv weights up to `conv5_1`:

- torchvision `vgg19.features` conv indices `[0,2,5,7,10,12,14,16,19,21,23,25,28]`
  (13 conv layers).
- Weight layout converted from torch `[outC,inC,kh,kw]` to tfjs filter
  `[kh,kw,inC,outC]` (`permute(2,3,1,0)`).
- Saved as one float32 `.bin` (weights+bias per layer, in order, ~52 MB) plus a
  small JSON manifest. The browser hardcodes the VGG19 topology and consumes the
  weights in order.

### Browser runtime

- **`src/vgg.js`** — loads the weights, exposes:
  - `preprocess(img)` — ImageNet normalization.
  - `vggForward(imgNormalized, captureSet)` — forward pass with `tf.conv2d`
    (`'same'` padding) + bias broadcast + ReLU, `tf.maxPool` (`2×2/valid`) after
    blocks 1–4, capturing the requested post-conv activations.
  - `gram(feat)` — `matMul(F, F, transposeA=true) / (C·H·W)`.
- **`src/gatys.js`** — `runGatys(contentCanvas, styleCanvas, opts)`:
  - Precompute style Gram targets and the content target (kept resident with
    `tf.keep`).
  - `img = tf.variable(content)`; `tf.train.adam(lr)`.
  - Loop `iterations`: `optimizer.minimize(lossFn)`, where `lossFn` (inside
    `tf.tidy`) clips the image to `[0,1]`, runs `vggForward`, and sums the
    content + style losses. Every few steps `await tf.nextFrame()` to keep the UI
    alive and report progress.
  - Read back with `tf.browser.toPixels` (outside `tidy` — it returns a Promise),
    dispose targets/variable/optimizer.
- **`src/app.js`** wiring: the painting whose brushwork is used as the **style
  target** is the reference nearest the current hour (`styleRefForHour`); the
  optimization runs **once per photo** with a progress overlay; the per-hour
  color drift composites on top exactly as before. Content is processed at 256px,
  rounded to a multiple of **16** (VGG pools the spatial dims by 16×).

### Numerical verification (port correctness)

We can't headlessly run a 400-iteration WebGL optimization, so we verified the
riskiest piece — that the hand-built tfjs VGG matches PyTorch — **numerically**:
fed an identical synthetic input to both and compared `conv1_1` output. Exact
match (mean `0.01180`, std `1.58353`, identical values), confirming the weight
layout / transpose / normalization / conv / padding are all correct. Since the
rest of the forward and the Adam loop are built from these validated ops plus
the calibrated Python recipe, the port is sound.

### Trade-off

- **Quality:** genuinely looks like a painting — forms dissolve into brushwork,
  Monet palette, recognizable subject.
- **Cost:** the optimization needs a **WebGL GPU** and takes tens of seconds per
  photo (CPU fallback is minutes). It runs once per photo, with a progress bar.
- **Download:** ~52 MB of VGG19 weights (cached after first load).

**Verdict:** the method that actually produces a painting; the cost is the
one-time per-photo optimization.

### Why we moved on

Gatys produces a single beautiful painting, but the day is still carried by
colour drift alone — and the locked vision needs the day carried by *genuinely
relit keyframes* the repaint can move between, not recolours of one canvas. Gatys
fundamentally can't relight: it optimizes one image against one style target.
Reaching the repaint vision required a model that can take a painting and
**re-light it while holding its brushwork and composition** — an image-conditioned
edit, which took the project off the client-side spectrum entirely. See §4.

---

## 4. Hosted image model (OpenAI gpt-image-2) — the current direction

### Why we left the client-side box

Engines 1–3 shared a hard constraint: everything client-side, no backend, no
keys. Inside that box the day-of-light was carried entirely by the colour-drift
system (§0) re-tinting one cached stylization. That is a *colour* day, not a
*lighting* day — and the repaint vision needs a lighting day: scrub a slider and
watch the scene **repaint** from dawn into golden hour through brushstrokes. A
repaint between recoloured copies of one painting is a **fake repaint** (the
strokes never change, only the hue). Selling it requires **genuinely different
lighting paintings per keyframe that share the same brushwork and composition and
differ only in light** — which no client-side method here could produce. So the
no-backend constraint was deliberately relaxed.

### Architecture: one base, N relit keyframes, repaint between them

Each hosted call costs real money, so the design uses a *small* number of calls
per upload (N ≈ 4–5), not 24:

- **One base generation.** Upload photo → one Monet painting, composition
  preserved (image-conditioned, not text-only).
- **N−1 relight edits of that base.** Each keyframe (dawn / midday / golden /
  dusk …) is an **edit of the single base painting**, *not* an independent
  generation from the photo. This is the crux of keyframe consistency: every
  keyframe is at most **one edit from the shared base anchor**, so they share
  brushwork and composition and diverge only in light. (Independent generations
  from the photo drift in composition — confirmed empirically below.)
- **Repaint between adjacent keyframes.** The brushstroke-reveal transition
  (prototyped in `repaint.html`) paints frame B over frame A in a
  content-independent stroke order as the slider scrubs between two hours.
- **Colour drift within a segment.** The mean-tint drift (§0) still does the fine,
  cheap colour motion *between* the N anchors, so the day stays smooth at
  sub-keyframe resolution.

N hosted calls per upload, cached; everything else is cheap client-side
compositing — preserving the project's "expensive once, slider cheap" invariant.

### Model selection — validated empirically, not from spec sheets

We ran the same Tübingen photo through each candidate as a base→day→dusk probe
(throwaway scripts in `validate/`, each emitting an HTML contact sheet) and judged
two axes by eye: **(1)** genuine dissolved Monet brushwork vs. a filtered photo,
and **(2)** does a relight hold composition so the keyframes are
repaint-compatible.

- **Gemini 2.5 Flash Image ("Nano Banana"), ~$0.039/img.** Cheapest, fastest,
  composition rock-solid — but the output is a painterly **filter**, not paint:
  crisp photographic buildings under an oily texture. Gemini exposes no
  img2img-strength knob, so we swept prompt aggression (mild→extreme) ×
  conditioning detail (downscaling the input). Prompt aggression barely moved the
  needle — diagnostic of a **preserve-the-photo bias that overrides the
  instruction**. The best cell still read as a filter. *Verdict: a ceiling, not a
  tuning miss.*
- **FLUX.1 Kontext [pro], ~$0.04/img.** A first generic "impressionist oil" prompt
  gave a high-detail painting with a Van-Gogh-ish swirly sky — not Monet — and the
  relights diverged in composition. Two refits fixed both: a **Monet-specific
  prompt** (loose broken-colour daubs, no hard outlines, pale high-key palette,
  "in the manner of Claude Monet," Haystacks/Rouen handling) and a
  **maximal-preservation relight prompt**. After the refit, **composition held**
  (day/dusk were the same scene relit, mutually consistent — repaint-compatible)
  and the palette was right, but the brushwork **smoothed into a polished
  impressionist *illustration*** rather than loose visible daubs. Partway, not all
  the way.
- **OpenAI gpt-image-2 (high), $0.177/img (measured from the API usage tokens).**
  The winner on **both** axes. The base is genuine broken-colour impressionism —
  stippled sky daubs, dabbed foliage, broken water reflections, no hard outlines,
  forms dissolved into paint. The relights held composition tightly (identical
  tree, building line, spire, figures; same daub texture) while changing only the
  light. gpt-image-2 processes every input image at high fidelity automatically,
  which is exactly why the relights stayed locked. These three frames are
  repaint-ready.

### The price of quality

gpt-image-2 is ~4.4× FLUX's per-image cost. At N=4 keyframes ≈ **$0.71/upload** vs
FLUX's ~$0.16. That doesn't change the architecture but it raises the stakes on a
public endpoint: the abuse/cost cap must be tighter (≈50–75 uploads/day ≈
$35–53), and `quality: "medium"` (~half the cost) is worth testing as a lever
before launch. gpt-image-2 bills per token ($8/M image-input, $30/M output), so
the probe reads the *actual* cost back from the `usage` field per call rather than
guessing.

### Status

Validated end-to-end at the probe level: base + relights produce repaint-ready
keyframes. The production endpoint — upload in, N cached keyframes out, with
rate-limit + hard daily cap, latency UX, failure/retry, and blob caching — is
**designed but not yet built**; keys and backend are intentionally deferred. The
frontend swap is surgical: replace the client-side stylization call with a fetch
to the endpoint; `enveloppe.js` (24h interpolation), `color.js` (within-segment
drift), and the `repaint.html` transition mechanic all carry over unchanged.

---

## Side-by-side

| | Arbitrary (Ghiasi) | CycleGAN `style_monet` | Gatys | Hosted (gpt-image-2) |
|---|---|---|---|---|
| Family | feed-forward, arbitrary style | feed-forward, image-to-image GAN | iterative optimization | hosted image-conditioned generative |
| Where style comes from | 100-D bottleneck per painting | baked into trained weights | Gram matrices of a real Monet | model prior + Monet-specific prompt |
| Structure | preserved (mild) | **preserved (by construction)** | **deliberately destroyed** | preserved (high input fidelity) |
| Looks like | tinted photo | filtered photo | a painting | a painting (genuine Monet daubs) |
| Runtime | tfjs / WebGL | onnxruntime-web / WASM | tfjs / WebGL | server-side API (OpenAI) |
| Per-frame cost | one forward pass | cached + color drift | cached + color drift | cached keyframes + repaint + drift |
| Per-photo cost | negligible | one forward pass (~seconds) | optimization (~tens of seconds) | N hosted calls (~$0.71 at N=4) |
| Download | ~12 MB (2 nets) | ~46 MB (ONNX) | ~52 MB (VGG19) | none (server-rendered) |
| Day-drift | interpolate style vectors | color tint only | color tint only | relit keyframes + repaint + colour drift |
| Key failure mode | too weak / interpolation washout | structure-preserving "filter" | slow; needs a GPU | per-upload cost / public-endpoint abuse |

**The spectrum:** structure-preserving methods are fast and stable but cap out
at "filtered photo"; texture-imposing methods look like paintings but cost a
per-photo optimization. The project moved left→right across that spectrum as the
quality bar rose — and once the bar rose past what client-side could do (a
*relightable* painting for the repaint), it stepped off the spectrum onto a
hosted model, trading "no backend, no keys" for production-quality Monet and a
small, hard-capped per-upload cost.

---

## Engineering patterns that carried across all four

- **Validate offline in the same engine before writing browser code.** ORT
  Python for CycleGAN; PyTorch (and a numerical parity check) for Gatys. Every
  method was confirmed to produce the intended image *before* the browser
  integration, so visual bugs could be isolated to the runtime, not the model.
- **Validate the hosted model before building the backend.** Same spirit, server
  side: each candidate (Gemini, FLUX, OpenAI) was run on the same photo as a
  base→relight probe with an eyeball contact sheet, judged on brushwork *and*
  composition-hold, before committing a cent of production spend or writing an
  endpoint. The probe also reads the *real* per-image cost back from the API.
- **Run the expensive stylization once (or N small times) per photo; keep the
  slider cheap.** The per-hour drift and the repaint are always plain-JS / canvas
  pixel work, so interactivity is decoupled from generation cost.
- **Isolated conversion / validation workspaces.** Offline tooling lives in
  `convert/` + `.convert-venv/` (gitignored); model-selection probes live in
  `validate/` and read keys from a gitignored `.env` (never committed).

---

## File map

```
src/
  app.js          orchestration: load, references, content, render loop, controls
  config.js       method selection + all tunable hyperparameters
  enveloppe.js    24h interpolation (locate / sortAnchors / formatClock)
  color.js        per-frame compositing: mean-only tint + strength cross-fade
  style.css       UI
  vgg.js          (Gatys) differentiable VGG19 in tfjs
  gatys.js        (Gatys) optimization loop
  -- removed --
  model.js        (Arbitrary) two-network tfjs stylization
  cyclegan.js     (CycleGAN) onnxruntime-web runner

convert/          offline toolchain (gitignored)
  export_onnx.py  (CycleGAN) PyTorch checkpoint -> single-file ONNX
  gatys.py        (Gatys) reference recipe / hyperparameter calibration
  export_vgg.py   (Gatys) torchvision VGG19 conv weights -> .bin + manifest
  validate.py     ORT sanity check of the exported model

validate/         hosted-model selection probes (throwaway; run with your own key)
  relight-probe.mjs         FLUX Kontext base + relight probe
  relight-probe-gemini.mjs  Gemini base + relight probe
  sweep-gemini.mjs          Gemini prompt × conditioning-detail sweep
  compare3.mjs              3-way FLUX vs OpenAI vs Gemini base→day→dusk compare
  out/                      generated contact sheets + cells (gitignored)

repaint.html      brushstroke repaint-transition prototype (consumes 2 keyframes)

public/
  monet-refs/     reference paintings (auto-discovered, ordered as a brightness loop)
  models/vgg/     committed VGG19 conv weights (Gatys-era; client-side engine)
  sample.jpg      default content photo (Tübingen Neckarfront)

.env              GEMINI / BFL / OPENAI keys (gitignored, never committed)
vite.config.js    monetRefsPlugin (folder -> virtual:monet-refs)
```

> Note: the hosted engine (§4) is validated but its production backend is not yet
> built, so the live app still runs the Gatys client-side engine. The `validate/`
> probes and `repaint.html` prototype are the proof-of-concept for the planned
> upload → N-keyframe → repaint pipeline.

> Note: the "removed" files and the CycleGAN/ONNX weights are not in the current
> tree — they're listed for the historical record. The live client-side engine is
> Gatys; the hosted gpt-image-2 pipeline (§4) is the validated next direction.
