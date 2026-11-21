import type { IndexHtmlTransformContext } from 'vite';
import { describe, expect, it } from 'vitest';
import { bootPreload, bootPreloads } from '../../boot-preload';

type Bundle = NonNullable<IndexHtmlTransformContext['bundle']>;

/** A bundle of chunks by file name: what each imports, its entry module and its CSS. */
function bundle(
  chunks: Record<string, { imports?: string[]; facade?: string; css?: string[]; entry?: boolean }>,
): Bundle {
  return Object.fromEntries(
    Object.entries(chunks).map(([fileName, c]) => [
      fileName,
      {
        type: 'chunk',
        fileName,
        isEntry: c.entry ?? false,
        facadeModuleId: c.facade ?? null,
        imports: c.imports ?? [],
        viteMetadata: { importedCss: new Set(c.css ?? []), importedAssets: new Set() },
      },
    ]),
  ) as unknown as Bundle;
}

const BOX = bundle({
  'assets/index.js': { entry: true, imports: ['assets/app.js'] },
  'assets/app.js': { imports: ['assets/react.js', 'assets/contracts.js'], css: ['assets/app.css'] },
  'assets/react.js': {},
  'assets/contracts.js': {},
  'assets/BoxRoot.js': {
    facade: '/web/src/managed/BoxRoot.tsx',
    imports: ['assets/app.js', 'assets/react.js', 'assets/shared-a.js'],
    css: ['assets/BoxRoot.css'],
  },
  'assets/boxEnv.js': { facade: '/web/src/managed/boxEnv.ts', imports: ['assets/shared-a.js'] },
  'assets/shared-a.js': { imports: ['assets/shared-b.js'], css: ['assets/shared-a.css', 'assets/app.css'] },
  'assets/shared-b.js': {},
  'assets/Settings.js': {
    facade: '/web/src/features/settings/SettingsScreen.tsx',
    css: ['assets/Settings.css'],
  },
});

describe('the page preloads its own root (boot-preload)', () => {
  it('preloads the root chunks and what they import that the page lacks, and their CSS', () => {
    const { scripts, styles } = bootPreloads(BOX, 'assets/index.js', [
      '/web/src/managed/BoxRoot.tsx',
      '/web/src/managed/boxEnv.ts',
    ]);
    expect(scripts).toEqual([
      'assets/BoxRoot.js',
      'assets/shared-a.js',
      'assets/shared-b.js',
      'assets/boxEnv.js',
    ]);
    expect(styles).toEqual(['assets/BoxRoot.css', 'assets/shared-a.css']);
  });

  it('stops the build when what main.tsx imports has no chunk of its own', () => {
    expect(() => bootPreloads(BOX, 'assets/index.js', ['/web/src/managed/Gone.tsx'])).toThrow(/Gone\.tsx/);
  });

  it('writes same-origin modulepreload and style preload links, none in fixture mode', () => {
    const transform = (modules: string[] | null) => {
      const plugin = bootPreload(modules);
      const hook = plugin.transformIndexHtml as { handler: (html: string, ctx: unknown) => unknown };
      return hook.handler('', { bundle: BOX, chunk: BOX['assets/index.js'] });
    };
    const tags = transform(['/web/src/managed/BoxRoot.tsx']) as { attrs: Record<string, string> }[];
    expect(tags.map((t) => [t.attrs.rel, t.attrs.as ?? null, t.attrs.href])).toEqual([
      ['modulepreload', null, '/assets/BoxRoot.js'],
      ['modulepreload', null, '/assets/shared-a.js'],
      ['modulepreload', null, '/assets/shared-b.js'],
      ['preload', 'style', '/assets/BoxRoot.css'],
      ['preload', 'style', '/assets/shared-a.css'],
    ]);
    expect(transform(null)).toBeUndefined();
  });
});
