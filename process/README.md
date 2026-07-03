# Process archive

**Comparison images only** — the side-by-side shots behind each decision in Monet
Enveloppe. Individual single-render outputs were pruned; where a comparison only
existed as loose cells, they were stitched into one labeled composite
(`scripts/montage.mjs`). Not shipped with the app.

### `1-neural-style-transfer/`
The original in-browser **Gatys/VGG19** approach and its tuning bake-offs:
`optimizer_compare`, `scale_compare`, `anchor_compare`, `color_compare`,
`sim_compare`, `styleref_compare`, `compare_passes`, `haysck_vs_teal`,
`haystack_batch` (the whole Monet Haystacks series in one grid),
`loop_transition_check`. Abandoned: too slow, strokes looked "melted".
(`vgg-onnx-model/` holds the 49 MB exported weights — not a picture; delete if unwanted.)

### `2-keyframe-model-selection/`
The pivot to hosted keyframes:
- `model-bakeoff.png` — **FLUX vs OpenAI vs Gemini**, base/day/dusk each.
- `gemini-sweep.png` — Gemini style-strength × source-resolution grid.
- `conditioning-compare.png` — how much composition survives.
- **Verdict:** `gpt-image-2` @ medium.

### `3-relight/`
- `relight-compare.png` — tint-only (before) vs true relight (after).
- `dawn/compare.png`, `night/compare.png` — dawn derivation; real vs filtered night.

### `4-repaint-transition/`
The brushstroke repaint being invented:
- `filmstrip.png` / `filmstrip-BEFORE.png` — the day progression, after/before the fix.
- `blend-compare.png`, `scrub-compare.png` — the mid-segment "mud" fix.
- `repaint-progression.png`, `repaint-scrub.gif`, `strokes-emerge.gif` — the mechanic in motion.

### `5-brushstroke-density/`
`density-compare.png` — `dens 0.9 → 2.1`, proving density is ~free on fps.

### `7-final-layout/`
`wall-full.png` — the finished gallery wall.

### `monet-style-references/`
The Monet *série* paintings studied for palette/brushwork (kept as source
reference, not comparisons — delete if you want strictly comparisons).
