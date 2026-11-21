import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import pagesRuntime from '@whombat/client/pages/pages-runtime.js';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { isRuntimeFile, runtimeModuleSource } = require('../../preview-runtime.cjs') as {
  isRuntimeFile: (file: string) => boolean;
  runtimeModuleSource: (src: string) => string;
};

/** What Metro's module for a runtime file exports. */
function metroModule(src: string): string {
  const module = { exports: {} as { default: string } };
  runInNewContext(runtimeModuleSource(src), { module });
  return module.exports.default;
}

describe('the phone’s bundled preview runtime', () => {
  it('embeds the installed Mermaid bytes without running them in React Native', () => {
    const file = require.resolve('mermaid/dist/mermaid.min.js');
    const src = readFileSync(file, 'utf8');
    expect(isRuntimeFile(file)).toBe(true);
    const url = metroModule(src);
    expect(url.startsWith('data:application/javascript;base64,')).toBe(true);
    expect(Buffer.from(url.split(',')[1] ?? '', 'base64').toString('utf8')).toBe(src);
  });

  it('embeds the page set viewer’s script the same way, here as in Metro', () => {
    const file = require.resolve('@whombat/client/pages/pages-runtime.js');
    const src = readFileSync(file, 'utf8');
    expect(isRuntimeFile(file)).toBe(true);
    expect(isRuntimeFile(file.replace('pages-runtime.js', 'index.ts'))).toBe(false);
    const url = metroModule(src);
    expect(Buffer.from(url.split(',')[1] ?? '', 'base64').toString('utf8')).toBe(src);
    // The tests' module is the bundle's.
    expect(pagesRuntime).toBe(url);
  });
});
