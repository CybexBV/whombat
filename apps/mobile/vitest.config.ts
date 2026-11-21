import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineProject, type Plugin } from 'vitest/config';
import { withModuleCache } from '../../scripts/vitest-project.js';

const require = createRequire(import.meta.url);
const { slimSvg } = require('./svg-markup.cjs') as { slimSvg: (src: string) => string };
const { isRuntimeFile, runtimeDataUrl } = require('./preview-runtime.cjs') as {
  isRuntimeFile: (file: string) => boolean;
  runtimeDataUrl: (src: string) => string;
};

/** `.svg` imports are their markup, as Metro's `metro-svg-transformer.cjs` makes them (FA-09, AP-903). */
const svgMarkup: Plugin = {
  name: 'whombat-svg-markup',
  enforce: 'pre',
  load(id) {
    const file = id.split('?')[0] ?? id;
    if (!file.endsWith('.svg')) return null;
    return `export default ${JSON.stringify(slimSvg(readFileSync(file, 'utf8')))};`;
  },
};

/** The browser runtimes are `data:` URLs of their bytes, as Metro makes them (`preview-runtime.cjs`). */
const runtimeUrls: Plugin = {
  name: 'whombat-runtime-urls',
  enforce: 'pre',
  load(id) {
    const file = id.split('?')[0] ?? id;
    if (!isRuntimeFile(file)) return null;
    return `export default ${JSON.stringify(runtimeDataUrl(readFileSync(file, 'utf8')))};`;
  },
};

// Logic only (view models, the avatar files, session helpers): nothing here imports React Native.
export default defineProject(
  withModuleCache({
    plugins: [svgMarkup, runtimeUrls],
    test: {
      globalSetup: ['../../scripts/vitest-temp-root.ts'],
      name: '@whombat/mobile',
      environment: 'node',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'modules/**/*.test.ts'],
      setupFiles: ['./src/test/setup.ts'],
      // As web and admin: a test's first import of the copy transforms the contracts' sources, which takes seconds while
      // the whole repository's suites run at once.
      testTimeout: 15000,
    },
  }),
);
