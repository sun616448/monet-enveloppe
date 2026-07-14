# Monet Enveloppe

https://github.com/user-attachments/assets/1dadb94f-c2c0-41c5-8b8b-eabd4764798f

Try it out here: https://monet-enveloppe.vercel.app/ 

A photo becomes a Monet painting, and then the day moves through it. Drag the
hour or press play, and the same scene repaints itself from dawn to midday to
dusk to night, brushstroke by brushstroke, as the light drifts across it.

## Where this came from

The idea hit me at the Monet in Venice exhibition here in San Francisco. There
was a wall of them: the same church, the same palace on the water, painted over
and over, each canvas at a different moment of the day. Monet had a word for what
he was really after, *l'enveloppe*, the "envelope" of light and air that settles
over a place and changes it completely from one hour to the next. The same stone
wall is cool and violet at dawn, blazing gold at noon, and deep blue by dusk.
Paint it once and you capture a thing; paint it through the day and you capture
the light itself moving across it.

What stuck with me was that he painted the same view a dozen times to hold onto
something that never sits still, and that standing there, your own eye does the
work of stitching the canvases into motion. I wanted to make that motion real:
one painting you could actually watch change through the day, the strokes laying
themselves back down in a different light. You hand it a photo, it paints the
scene as Monet might have, and it relights that painting across a full day.

## What it does

- **Turns any photo into a Monet.** Upload your own, or explore the curated
  gallery of scenes.
- **Moves the light through a full day.** Four times of day (dawn, midday, dusk,
  night), each a genuinely different lighting of the same painting rather than a
  color filter over one image.
- **Repaints between hours instead of fading.** The transition lays thousands of
  brush-dabs over the current frame while the color drifts toward the new light,
  so it reads as painting rather than a slideshow dissolve.
- **Plays on its own, or on your command.** The day advances at a gentle pace;
  grab the timeline to scrub, and release to resume.
- **Never sits fully still.** When idle, the surface holds a faint shimmer, so it
  reads as wet paint rather than a frozen image.

## What I tried before this worked

The project began as a purist constraint: no server, no API, the browser does the
painting live. I built three client-side style-transfer engines chasing that
constraint before abandoning it.

The first was an optimization-based neural style-transfer engine (Gatys), which
redraws a photo to match the texture statistics of a reference painting. It ran,
but the output was a smeared photo rather than a painting: photographic edges
intact, brushwork absent. Rather than assume the cause, I ruled the alternatives
out one at a time. I verified numerically that my hand-built feature extractor
matched the reference implementation, then swept image resolution, the optimizer,
the strength of the style term, and roughly a dozen Monet reference paintings.
Every configuration converged on the same ceiling: the method preserves the
photo's structure too faithfully to ever read as hand-painted. A second engine
that synthesized brushstrokes directly from the photo's gradients produced
directionless, melted-looking texture. The conclusion was that the entire
"paint live in the browser" family caps out below the bar, and proving that
rather than assuming it is what let me commit to a different architecture.

The working approach generates the paintings up front with a hosted image model.
I ran a bake-off across several candidates: some rendered as a filter over the
photo, others as a smoothed illustration. OpenAI's model was the only one that
produced convincing, dissolved Monet brushwork while holding the scene's
composition steady under relighting, which the transition step depends on.

The remaining problem was the motion between keyframes. A cross-fade between two
paintings reads as a slideshow dissolve, so instead the app repaints the target
frame over the current one with thousands of brush-dabs while the color drifts
toward the new light. Naive alpha-blending of two different paintings averages
them into mud in the middle of a transition; the fix was to blend the two frames'
low-frequency light while drawing each brushstroke from a single source, so the
strokes stay crisp instead of double-exposing. The night-to-dawn transition, the
largest luminance swing in the loop, was the hardest segment to keep clean.

The full R&D trail, including every model comparison and dead end side by side,
is archived under [`process/`](process/).

## How the pipeline works

The expensive work runs once per photo; everything interactive afterward is cheap
client-side rendering.

1. **One photo becomes one painting.** The uploaded photo is painted into a
   *midday* Monet by the image model. This is the base frame.
2. **The base is relit into the other hours.** *Dusk* and *night* are produced as
   edits of the midday painting, not fresh generations, changing the sun position,
   shadows, sky, and lit windows while holding composition. Editing the base
   rather than regenerating is what keeps every frame the same scene, which the
   repaint transition requires.
3. **Dawn is derived for free.** *Dawn* is computed from the dusk painting with a
   color transform (raise brightness, cool the cast, add a rosy glow), so only
   three keyframes are ever generated.
4. **The browser renders the day.** Scrubbing, the repaint transition, the color
   drift, auto-advance, and the idle shimmer all run on the cached keyframes.
   Uploads are rate-limited and spend-capped so a public endpoint cannot run up a
   bill.

## Run it locally

```bash
npm install
npm run dev
```

Open the printed local URL. The curated gallery runs without any keys. "Try your
own photo" requires an OpenAI API key in the environment (see `api/enveloppe.js`);
without one, the gallery still works.

## Stack

Vanilla JS and Vite on the front end, with no UI framework; the brushstroke
engine is hand-written canvas rendering. A serverless endpoint calls OpenAI's
image model to generate a scene's keyframes. Deployed on Vercel.

## Code layout

```
index.html            the gallery-wall page
src/
  app.js              the day loop, scrubbing, uploads, the gallery
  repaint.js          the brushstroke engine
  scene.js            assembles keyframes into a scene; derives the dawn frame
  config.js           tunable parameters
api/
  enveloppe.js        the upload endpoint that generates a scene's paintings
public/
  gallery/            the curated scenes (paintings and source photos)
  monet-refs/         the Monet paintings shown on the wall
process/              the full R&D trail
```

To add a curated scene: place a source photo in `public/`, add a row to the
`SCENES` list in `scripts/gallery-gen.mjs`, and run
`node scripts/gallery-gen.mjs <id>`. It generates the three keyframes and prints a
manifest entry for `public/gallery/manifest.json` (about $0.16 per scene).