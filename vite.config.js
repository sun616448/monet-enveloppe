import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFS_DIR = path.resolve(__dirname, 'public/monet-refs');
const IMAGE_RE = /\.(jpe?g|png|webp|avif|gif)$/i;
const naturalSort = (a, b) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// Turn a slug like "03-rouen-cathedral" into a readable "Rouen Cathedral".
// Leading sort numbers/separators are dropped; the rest is title-cased.
function titleFromSlug(slug) {
  const cleaned = slug
    .replace(/^[0-9]+[-_.\s]*/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  const text = cleaned || slug;
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

// The active palette is a single set of paintings dropped directly into
// public/monet-refs (sharing a colour palette — e.g. Monet's Venice lagoon).
// Files are ordered by name and spaced across the day at runtime, so prefix
// them in palette order (01-…, 02-…). Subfolders (e.g. "_extras") and dotfiles
// are ignored, so park unused paintings in a subfolder rather than deleting.
function listReferences() {
  if (!fs.existsSync(REFS_DIR)) return [];
  return fs
    .readdirSync(REFS_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && IMAGE_RE.test(d.name))
    .map((d) => d.name)
    .sort(naturalSort)
    .map((file) => ({
      src: `monet-refs/${file}`,
      title: titleFromSlug(file.replace(/\.[^.]+$/, '')),
    }));
}

// Exposes the discovered references as `virtual:monet-refs`. Adding or removing
// a painting under public/monet-refs triggers a full reload in dev.
function monetRefsPlugin() {
  const virtualId = 'virtual:monet-refs';
  const resolvedId = '\0' + virtualId;
  return {
    name: 'monet-refs',
    resolveId(id) {
      if (id === virtualId) return resolvedId;
    },
    load(id) {
      if (id === resolvedId) {
        return `export const REFERENCES = ${JSON.stringify(listReferences())};`;
      }
    },
    configureServer(server) {
      server.watcher.add(REFS_DIR);
      const onChange = (file) => {
        if (!path.resolve(file).startsWith(REFS_DIR)) return;
        const mod = server.moduleGraph.getModuleById(resolvedId);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', onChange);
      server.watcher.on('unlink', onChange);
      server.watcher.on('addDir', onChange);
      server.watcher.on('unlinkDir', onChange);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [monetRefsPlugin()],
  server: {
    open: true,
  },
  build: {
    target: 'es2020',
  },
});
