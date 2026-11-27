import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const vendor = (p: string) => fileURLToPath(new URL(`./vendor/whombat-app/${p}`, import.meta.url));

// The page is served by the local console / installer server at `/` (CG-01, CG-11): one index.html, hashed
// assets under /assets/, nothing from the network.
// The dev server injects CSS as <style> elements; the built page has none, so only dev relaxes style-src.
const devStyles: Plugin = {
  name: 'dev-inline-styles',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
};

export default defineConfig({
  plugins: [react(), devStyles],
  base: '/',
  resolve: {
    alias: [
      { find: '@whombat/avatars/react', replacement: vendor('avatars/src/react.tsx') },
      { find: '@whombat/avatars/live', replacement: vendor('avatars/src/live.tsx') },
      { find: '@whombat/avatars/face', replacement: vendor('avatars/src/face.ts') },
      { find: '@whombat/avatars/motion', replacement: vendor('avatars/src/faceMotion.ts') },
      { find: '@whombat/avatars/puppet', replacement: vendor('avatars/src/puppet.ts') },
      { find: '@whombat/avatars/urls', replacement: vendor('avatars/src/urls.ts') },
      { find: '@whombat/avatars', replacement: vendor('avatars/src/index.ts') },
      { find: '@whombat/brand/react', replacement: vendor('brand/src/react.tsx') },
      { find: '@whombat/brand', replacement: vendor('brand/src/index.ts') },
      { find: '@whombat/screen/react', replacement: vendor('screen/src/react.tsx') },
      { find: '@whombat/screen/fixtures', replacement: vendor('screen/src/fixtures.ts') },
      { find: '@whombat/screen', replacement: vendor('screen/src/index.ts') },
    ],
  },
  build: {
    target: 'chrome120',
    assetsInlineLimit: 0,
    sourcemap: false,
    reportCompressedSize: true,
  },
  server: { host: '127.0.0.1', strictPort: true },
});
