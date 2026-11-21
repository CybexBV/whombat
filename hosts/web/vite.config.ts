/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fixturesPlugin } from './dev/fixtures/plugin.ts';

// `pnpm dev`           -> proxies /api (HTTP + WebSocket) to the hub on :8080
// `pnpm dev:fixtures`  -> serves /api/v1 from docs/handoff/sample-data
export default defineConfig(({ mode }) => {
  const fixtures = mode === 'fixtures';
  const hub = process.env.RACKOON_HUB ?? 'http://127.0.0.1:8080';
  return {
    plugins: [react(), ...(fixtures ? [fixturesPlugin()] : [])],
    server: {
      port: 5173,
      host: process.env.VITE_HOST ?? '127.0.0.1',
      proxy: fixtures
        ? undefined
        : {
            '/api': { target: hub, changeOrigin: false, ws: true },
          },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
    },
    test: {
      include: ['src/**/*.test.ts', 'dev/**/*.test.ts'],
      environment: 'node',
    },
  };
});
