/** Where a production build's mock world may be (vite.config `noFixtureMode`, docs/app/decisions/look-around.md). */

/**
 * The chunks the mock world must not be in: every chunk, or with a demo loaded on demand those a page loads by itself
 * (the entries and what they import statically, transitively).
 */
export function fixtureChunks<C extends { fileName: string; isEntry: boolean; imports: readonly string[] }>(
  chunks: readonly C[],
  lazyDemo: boolean,
): C[] {
  if (!lazyDemo) return [...chunks];
  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  const loaded = new Set<string>();
  const visit = (name: string) => {
    if (loaded.has(name)) return;
    loaded.add(name);
    for (const next of byName.get(name)?.imports ?? []) visit(next);
  };
  for (const c of chunks) if (c.isEntry) visit(c.fileName);
  return chunks.filter((c) => loaded.has(c.fileName));
}
