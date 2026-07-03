# Monet Enveloppe

Recreate Monet's *série* — l'*enveloppe*, the changing veil of light across a
day — as a painting that **repaints itself hour by hour**. A photo becomes a
Monet at midday, is relit into dusk and night, and the day advances on its own
through brushstrokes that lay themselves down as the light drifts. Drag the hour
or press play.

> **Note on approach:** this started as in-browser [neural style
> transfer](#the-journey-processs) and pivoted to the hosted-keyframe pipeline
> below. The full journey — every model bake-off and dead end — is archived in
> [`process/`](#the-journey-processs).

## How it works

The live app has **no client-side model**. It runs on a small number of
generated **keyframes** and a **brushstroke repaint** engine that moves between
them.

### 1. Keyframes — one painting, relit (`gpt-image-2`)

A source photo becomes **N = 3 generated keyframes**:

- **Midday** is the single *base* generation: the photo repainted as a Monet
  (`api/_prompts.js` → `BASE_PROMPT`). Monet-specific steering matters — a
  generic "impressionist oil" prompt gave a Van-Gogh-swirl filter.
- **Dusk** and **Night** are **edits of the base**, not of the photo. Editing
  the base is what keeps composition and brushwork consistent across the day, so
  the repaint can cross-reveal them. Each genuinely *re-lights* the scene —
  sun direction, cast shadows, sky, lit windows — rather than tinting it.
- **Dawn** is **derived for free client-side** from the dusk frame with a tonal
  transform (`src/scene.js` → `dawnFromCanvas`): lift to high-key morning,
  de-orange/cool, add a rose bloom. Keeps cost at N = 3.

`gpt-image-2` at `quality: medium` (~$0.053/image) was chosen over Gemini (read
as a filter) and FLUX (a smoothed illustration). **~$0.16 per scene.**

### 2. The brushstroke repaint (`src/repaint.js`)

Between two adjacent keyframes the engine repaints frame **B** over frame **A**
through thousands of textured, directional **brush-dabs**, revealed in a
content-**independent** order (big coverage strokes first, fine detail last).
Two things move together:

- **Light drift** — A's strokes are recoloured toward B's low-frequency light
  field, so the colour shifts everywhere, spatially, like real light moving.
- **Stroke reveal** — B's fresh dabs are stamped on top as the day advances.

Orienting strokes by image gradients read as "melted plastic", so the reveal
order is a fixed flow-field + jitter (forward and backward scrub match exactly).
Dab **density is nearly free** — a persistent accumulation mask commits each
dab once, so per-frame cost is dominated by fixed compositing, not stroke count.
It's cranked high (`REPAINT.dens` in `src/config.js`) for maximum brushwork.

### 3. The auto-advancing day (`src/app.js`)

The day advances continuously toward the next keyframe at constant velocity
(`DAY_SWEEP_SECONDS`), scrubbable with a smooth grab → yield → resume handoff.
When idle, the surface "breathes" with a subtle sheen so it feels alive without
transforming. Sustained **~60 fps** in real Chrome at a 660px working resolution.

### 4. The gallery + your own photo

The default view is a **gallery wall**: the interactive painting center stage,
static Monet *série* paintings hung left and right, curated scenes on a shelf
below. **Try your own photo** POSTs to `/api/enveloppe`, which runs the same
pipeline server-side with cost protection (daily spend cap, per-IP rate limits,
KV cache, Blob storage). If the API is unavailable it falls back to a
client-side recolor preview, so the UX never breaks.

## Run

```bash
npm install
npm run dev
```

No keys needed for the gallery. The **live upload** path needs a deployed
backend — see [Deploy](#deploy).

## Project structure

```
index.html            gallery-wall UI
src/
  app.js              day loop, scrub handoff, upload, gallery
  repaint.js          brushstroke repaint engine (the core mechanic)
  scene.js            keyframes → Scene; derived dawn
  config.js           all the knobs (see below)
  color.js            colour stats for the light drift
api/
  enveloppe.js        POST upload → gpt-image-2 keyframes (serverless)
  _prompts.js         the base + relight prompts (single source of truth)
scripts/
  gallery-gen.mjs     batch-generate curated gallery scenes from photos
public/
  gallery/            curated scene keyframes (+ source photos) + manifest.json
  monet-refs/_extras/ the Monet paintings hung on the gallery wall
validate/             real-Chrome probes (fps, gallery capture, …)
process/              the full R&D journey — comparison images (see below)
```

## Configure (`src/config.js`)

| Knob | What it does |
|------|--------------|
| `DAY_SWEEP_SECONDS` | seconds for a full 24 h loop (30–60 sweet spot) |
| `REPAINT.dens` / `.size` | brush-dab density / size (density is ~free on fps) |
| `DEFAULT_DRIFT` | how strongly the light shifts across a segment (locked 65%) |
| `DISPLAY_MAX_EDGE` | working resolution (660 holds 60 fps) |
| `KEYFRAMES` / `DAWN` | the keyframe plan and derived-dawn tonal transform |

## Adding gallery scenes

Drop a source **photo** in `public/`, add a `{ id, from, title }` row to the
`SCENES` array in `scripts/gallery-gen.mjs`, then:

```bash
node scripts/gallery-gen.mjs <id>     # reads OPENAI_API_KEY from .env
```

It writes `public/gallery/<id>/{midday,dusk,night}.png` and prints a
manifest entry to paste into `public/gallery/manifest.json`. ~$0.16/scene.

## Deploy

The upload path is a Vercel serverless function and needs three things
provisioned on the project, or every upload silently falls back to the offline
preview:

1. **`OPENAI_API_KEY`** (+ `OPENAI_ORG` if the key needs an explicit org).
2. **KV store** (`@vercel/kv`, via the Marketplace / Upstash) — the function is
   *fail-closed*: no KV ⇒ every request refused. Sets `KV_REST_API_*`.
3. **Blob storage** (`@vercel/blob`) — stores keyframe PNGs. Sets
   `BLOB_READ_WRITE_TOKEN`.

Also raise `functions.maxDuration` in `vercel.json` to **~300 s** — a 3-image
generation takes ~200 s and the current `60` will time out. And commit
`public/gallery/**` (the curated assets) so the gallery doesn't 404.

## The journey (`process/`)

The interesting part was getting here. `process/` archives the comparison images
behind each decision (curate/prune freely — it's not shipped):

| Folder | What it shows |
|--------|---------------|
| `1-neural-style-transfer/` | the original in-browser Gatys/VGG19 approach — optimizer, scale, anchor & colour bake-offs, and the VGG ONNX weights. Abandoned: too slow, and content-oriented strokes looked melted. |
| `2-keyframe-model-selection/` | the pivot — **FLUX vs OpenAI vs Gemini**, the Gemini strength sweep, and conditioning tests. `gpt-image-2` won. |
| `3-relight/` | relight prompts + the **dawn** and **real-vs-derived night** experiments. |
| `4-repaint-transition/` | the brushstroke repaint being invented — filmstrips, mid-scrub blend fixes, and the `strokes-emerge` / `repaint-scrub` GIFs. |
| `5-brushstroke-density/` | dab-density crops (0.9 → 2.1) proving density is ~free. |
| `6-performance/` | real-Chrome fps captures for the auto-advancing day. |
| `7-final-layout/` | the finished gallery wall. |
| `monet-style-references/` | the Monet *série* paintings studied for the style. |

## Credits

- Keyframes: OpenAI **`gpt-image-2`**. Brushstroke repaint + colour drift:
  client-side, original.
- Paintings on the wall and studied for style: **Claude Monet**, public domain
  (Rouen Cathedral, Houses of Parliament, and Grainstack *séries*).
- Sample photo: Tübingen Neckarfront.
