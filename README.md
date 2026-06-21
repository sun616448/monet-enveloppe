# Monet Enveloppe

Recreate Monet's *série* (l'*enveloppe*) — the same motif painted under
different light — using **real-time neural style transfer**, fully in the
browser. Upload a photo, drag the time-of-day slider (or press play), and watch
it drift through a single Monet palette, blended frame by frame.

## How it works

It uses the two-network arbitrary image stylization model (Ghiasi et al.),
ported to TensorFlow.js by Reiichiro Nakano:

- **Style prediction network** (MobileNet) turns a style image into a 100-D
  *style bottleneck* vector. We run it **once per reference painting at load**
  and cache the vectors.
- **Style transform network** (separable conv) takes `[content image, style
  vector]` and produces the stylized image. It stays resident in memory.

The palette is **spaced evenly across the 24h day** in filename order. For
any hour, we find the two nearest paintings, **linearly interpolate their style
vectors** (wrapping across midnight), and run a single forward pass per
`requestAnimationFrame` tick. Only interpolation + one forward pass runs per
frame, so it stays interactive on a WebGL GPU.

Performance: the content image is downscaled to ~384px on the long edge before
stylizing; the canvas is upscaled for display only.

## Run

```bash
npm install
npm run dev
```

The two model files (~12 MB total) are fetched from jsDelivr on first load and
then cached by the browser. No backend, no API keys.

## The palette (reference paintings)

Reference paintings are **auto-discovered from `public/monet-refs/`**. The app
uses a **single palette**: every image placed *directly* in that folder. They
share a colour palette (currently Monet's Venice lagoon — Grand Canal, the
Doge's Palace, San Giorgio), so the day-sweep is a smooth colour drift rather
than a jump between motifs. To change the palette, just edit the folder and
restart the dev server (or rebuild):

```
public/monet-refs/
  01-pale-lavender.jpg     → spaced across the day in this order
  02-misty-lavender.png
  03-grey-blue.jpg
  04-pink-palace.png
  05-blue-dusk.png
  06-saturated-teal.jpeg
  _extras/                 → ignored (parked, unused paintings)
```

- **Files** are ordered by name (natural numeric sort) and then spaced evenly
  across the 24h day, so name them in **palette order** (`01-…`, `02-…`).
  Reorder anytime by renaming the numeric prefix. More paintings = finer drift.
- **Subfolders** (and dotfiles) are **ignored** — park unused paintings in
  `_extras/` rather than deleting them.
- For the smoothest drift, every painting should share a **coherent palette**,
  so interpolating between adjacent colours stays believable.

The scan happens in a small Vite plugin (`monetRefsPlugin` in `vite.config.js`),
exposed to the app as the `virtual:monet-refs` module (`REFERENCES`). There's no
frontend upload for references — they live entirely in the folder.

Note: this is style *extraction*, not training — each painting just gets one
forward pass to produce its 100-D style vector.

## Configure

Edit `src/config.js` for model variants (`STYLE_MODEL_URL` /
`TRANSFORM_MODEL_URL`), the content/style downscale sizes (`MAX_CONTENT_SIZE` /
`STYLE_SIZE` — lower `STYLE_SIZE` = more painterly), default strength,
default palette match, or the auto-play day length. The paintings themselves
live in `public/monet-refs/`.

### Palette match (colour fidelity)

The stylization network reproduces Monet's *brushwork* faithfully but its
*colours* drift. The **Palette match** control applies a Reinhard colour
transfer — re-keying the output's per-channel mean/std to the real painting's
palette (interpolated between the two nearest hours, same as the style vectors).
It's a cheap per-frame GPU op, so the day-sweep stays real-time. This is not
training: it's a deterministic colour correction toward the source paintings.

## Credits

- Model: [arbitrary-image-stylization-tfjs](https://github.com/reiinakano/arbitrary-image-stylization-tfjs)
  by Reiichiro Nakano; original paper Ghiasi et al., 2017.
- Paintings: Claude Monet, public domain via Wikimedia Commons.
