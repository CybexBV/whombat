/**
 * The subpaths the widget loader and frame bundle (`@whombat/core/feedback/sanitize`, `/drop`, `/reporters`; CT-163)
 * stay free of Zod and of everything but `@noble/*`: every value import, followed through relative files, is checked.
 * Type-only imports are erased and don't count.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FEEDBACK = join(import.meta.dirname, '..', '..', '..', 'packages', 'core', 'src', 'feedback');

function valueImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?\sfrom\s+'([^']+)';$/gms)]
    .filter((m) => !m[1])
    .map((m) => m[2] as string);
}

function closure(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of valueImports(file)) {
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      else packages.add(spec);
    }
  };
  visit(entry);
  return { files: [...files], packages: [...packages] };
}

describe('widget-safe feedback subpaths', () => {
  it.each(['sanitize.ts', 'drop.ts', 'reporters.ts'])('%s imports only @noble at runtime', (name) => {
    const { files, packages } = closure(join(FEEDBACK, name));
    for (const p of packages) expect(p, `${name} → ${p}`).toMatch(/^@noble\//);
    for (const f of files) expect(f, `${name} → ${f}`).not.toMatch(/[/\\]domain[/\\]/);
  });

  it('keeps sanitize without any import (the loader bundles it alone)', () => {
    expect(valueImports(join(FEEDBACK, 'sanitize.ts'))).toEqual([]);
  });
});
