// Single source of truth for the gpt-image-2 prompts and the keyframe plan.
// These are the prompts validated in validate/compare3.mjs + quality-probe.mjs.
//
// CRITICAL: midday is the BASE generation (photo -> Monet). dawn and dusk are
// EDIT-OF-BASE relights of the midday image — NOT generated from the photo.
// Edit-of-base is what kept the keyframes composition- and brushwork-consistent
// in validation. If a refactor ever generates a keyframe from the photo, the
// repaint consistency breaks. Do not regress this.

export const QUALITY = 'medium'; // validated: the Monet daubs survive at medium

// Base: photo -> Monet, composition preserved. Monet-SPECIFIC steering (generic
// "impressionist oil" gave a Van-Gogh-swirl filter in validation).
export const BASE_PROMPT =
  'Repaint this scene as a painting in the manner of Claude Monet — French ' +
  'Impressionism, the handling of his Haystacks and Rouen Cathedral series. ' +
  'Loose broken-color daubs: short separate strokes of pure unmixed color laid ' +
  'side by side. NO hard outlines and NO crisp edges anywhere — buildings, ' +
  'windows, trees and water all dissolve softly into adjacent strokes. A pale, ' +
  'high-key, luminous palette with colored light and colored shadows. Paint the ' +
  'fleeting light and atmosphere, not architectural detail. It must look ' +
  'hand-painted with a loaded brush on canvas like an actual Monet — not a sharp ' +
  'digital oil painting, not a photo. Keep the overall composition and layout.';

// Relight: anchor composition + brushwork, but genuinely change the LIGHT.
// The earlier "change ONLY the color of the light / do not redraw anything"
// wording FORBADE real relighting — it produced midday + a hue wash (validated
// in validate/issue3-relight.mjs). This version keeps composition/brushwork but
// asks for light DIRECTION, cast shadows, sky character and brightness falloff,
// so dawn/midday/dusk are genuinely different paintings the repaint can reveal.
export const RELIGHT = (spec) =>
  'This is a Monet-style impressionist painting of a scene. Keep the SAME ' +
  'composition, the same buildings/objects in the same positions, and the same ' +
  'loose impressionist brushwork of separate daubs. Genuinely RE-LIGHT the scene: ' +
  spec +
  ' Change the direction and angle of the light, the length and direction of cast ' +
  'shadows, the brightness falloff across the scene, and the character of the sky — ' +
  'not merely the overall color tint. It must read as the same place at a ' +
  'different time of day, repainted in the same hand.';

export const LIGHTS = {
  dusk: 'warm golden-hour sunset — a low sun raking from one side casting long dramatic shadows across the scene, a glowing orange-and-violet sky, bright warm rim-light on surfaces facing the sun and deep dim shadow elsewhere.',
  night:
    'deep night long after sunset — NO sun anywhere and no warm sunset glow. A dark ' +
    'deep blue-black sky with a soft pale moon and faint moonlight. The scene is ' +
    'low-key and dark, lit only by cool ambient moonlight plus a scattering of small ' +
    'warm glowing lit windows in the buildings and their reflections on the water. ' +
    'Most of the scene sinks into deep cool blue-black shadow; the brightest accents ' +
    'are the moon, the lit windows, and moonlight glints on the river.',
};

// The keyframe plan. `kind:'base'` is the one generation from the photo; the rest
// are relights of that base. N = 3 generated (~$0.16/upload at medium): midday,
// dusk, and a REAL night (night needs invented dark content — moon, lit windows —
// a filter can't fake). DAWN is NOT here: it's derived free client-side from the
// dusk keyframe (see src/scene.js dawnFromCanvas), keeping cost at N=3.
export const KEYFRAMES = [
  { hour: 12, label: 'Midday', kind: 'base' },
  { hour: 18, label: 'Dusk', kind: 'relight', light: 'dusk' },
  { hour: 22, label: 'Night', kind: 'relight', light: 'night' },
];
