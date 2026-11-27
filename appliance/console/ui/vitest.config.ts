import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const vendor = (p: string) => fileURLToPath(new URL(`./vendor/whombat-app/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: '@whombat/avatars/react', replacement: vendor('avatars/src/react.tsx') },
      { find: '@whombat/avatars/urls', replacement: vendor('avatars/src/urls.ts') },
      { find: '@whombat/avatars', replacement: vendor('avatars/src/index.ts') },
      { find: '@whombat/brand/react', replacement: vendor('brand/src/react.tsx') },
      { find: '@whombat/brand', replacement: vendor('brand/src/index.ts') },
      { find: '@whombat/screen/react', replacement: vendor('screen/src/react.tsx') },
      { find: '@whombat/screen/fixtures', replacement: vendor('screen/src/fixtures.ts') },
      { find: '@whombat/screen', replacement: vendor('screen/src/index.ts') },
    ],
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
