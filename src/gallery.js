// Curated gallery loader. Fetches the static manifest; returns scene descriptors
// (un-loaded — src/scene.js turns a descriptor into a renderable Scene). Fails
// soft: any error returns an empty list, and app.js falls back to a bundled
// built-in scene so a visitor never sees a broken/empty demo.
import { GALLERY_MANIFEST } from './config.js';

export async function fetchGallery() {
  try {
    const res = await fetch(GALLERY_MANIFEST, { cache: 'no-cache' });
    if (!res.ok) return [];
    const manifest = await res.json();
    return Array.isArray(manifest.scenes) ? manifest.scenes : [];
  } catch {
    return [];
  }
}
