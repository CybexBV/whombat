/**
 * The page's own root fetched with the page. `src/main.tsx` imports the box's page (`BoxRoot`, `boxEnv`) or the hosted
 * app (`ManagedRoot`, `connect`) only once the page's scripts have run, so without a hint the browser finds those chunks
 * a whole round of downloads late. The built `index.html` gets `<link rel="modulepreload">` for them and the chunks they
 * import that the page doesn't load already, and `<link rel="preload" as="style">` for their CSS: Vite still inserts
 * the stylesheets itself when the import runs, in its own order, so the cascade doesn't change. Same-origin files, so
 * the pages' policy (`script-src 'self'`) allows them. Build only.
 */
import type { IndexHtmlTransformContext, Plugin } from 'vite';

type Bundle = NonNullable<IndexHtmlTransformContext['bundle']>;
type Chunk = NonNullable<IndexHtmlTransformContext['chunk']>;

/**
 * What to preload for the chunks whose entry modules are `modules` (absolute ids): those chunks and their static imports
 * first, then their CSS, each without what the page's entry chunk `entry` loads already.
 */
export function bootPreloads(
  bundle: Bundle,
  entry: string,
  modules: readonly string[],
): { scripts: string[]; styles: string[] } {
  const chunks = new Map<string, Chunk>();
  for (const output of Object.values(bundle))
    if (output.type === 'chunk') chunks.set(output.fileName, output);
  const closure = (roots: readonly string[]) => {
    const seen = new Set<string>();
    const visit = (fileName: string) => {
      if (seen.has(fileName)) return;
      seen.add(fileName);
      for (const imported of chunks.get(fileName)?.imports ?? []) visit(imported);
    };
    for (const root of roots) visit(root);
    return seen;
  };
  const cssOf = (files: Iterable<string>) =>
    new Set([...files].flatMap((f) => [...(chunks.get(f)?.viteMetadata?.importedCss ?? [])]));
  const roots = modules.map((id) => {
    const chunk = [...chunks.values()].find((c) => c.facadeModuleId === id);
    if (!chunk) throw new Error(`bootPreload: no chunk starts at ${id} (what src/main.tsx imports changed?)`);
    return chunk.fileName;
  });
  const inPage = closure([entry]);
  const wanted = closure(roots);
  const pageCss = cssOf(inPage);
  return {
    scripts: [...wanted].filter((f) => !inPage.has(f)),
    styles: [...cssOf(wanted)].filter((f) => !pageCss.has(f)),
  };
}

/** Adds the preloads for `modules` to the built `index.html`; null (fixture mode, whose app is in the page): none. */
export function bootPreload(modules: readonly string[] | null): Plugin {
  let base = '/';
  return {
    name: 'whombat-boot-preload',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        if (!modules || !ctx.bundle || !ctx.chunk) return;
        const { scripts, styles } = bootPreloads(ctx.bundle, ctx.chunk.fileName, modules);
        // `crossorigin` as the page's own scripts and Vite's loader ask for them, so the browser reuses these responses.
        return [
          ...scripts.map((f) => ({ rel: 'modulepreload', href: `${base}${f}`, crossorigin: '' })),
          ...styles.map((f) => ({ rel: 'preload', as: 'style', href: `${base}${f}`, crossorigin: '' })),
        ].map((attrs) => ({ tag: 'link', attrs, injectTo: 'head' as const }));
      },
    },
  };
}
