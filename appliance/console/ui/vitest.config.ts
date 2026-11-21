import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const vendor = (p: string) => fileURLToPath(new URL(`./vendor/whombat-app/${p}`, import.meta.url));

export default defineConfig({
  // The pure vendored modules the logic imports (vite.config.ts has the rest).
  resolve: {
    alias: [
      { find: '@whombat/avatars', replacement: vendor('avatars/src/index.ts') },
      { find: '@whombat/brand', replacement: vendor('brand/src/index.ts') },
      { find: '@whombat/screen/react', replacement: vendor('screen/src/react.tsx') },
      { find: '@whombat/screen/fixtures', replacement: vendor('screen/src/fixtures.ts') },
      { find: '@whombat/screen', replacement: vendor('screen/src/index.ts') },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
