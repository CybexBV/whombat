import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readPropsMeta, rewriteDataProps } from './props';
import { type ReferenceFile, referencePath } from './reference';

// The design references the visual harness reads (docs/design-handoff/design/).
const read = (file: ReferenceFile) => readFileSync(referencePath(file), 'utf8');
const desktop = read('desktop');
const avatar = read('avatar');
const mobile = read('mobile');

describe('data-props', () => {
  it('rewrites defaults with coercion and validation', () => {
    const html = rewriteDataProps(desktop, { start: 'run', theme: 'dark' });
    const meta = readPropsMeta(html);
    expect(meta.start?.default).toBe('run');
    expect(meta.theme?.default).toBe('dark');
    expect(html.length).toBeGreaterThan(desktop.length - 50);

    const av = readPropsMeta(rewriteDataProps(avatar, { role: 'developer', silhouette: 'true' }));
    expect(av.role?.default).toBe('developer');
    expect(av.silhouette?.default).toBe(true);
  });

  it('rejects unknown props, bad enum values and prop-less files', () => {
    expect(() => rewriteDataProps(desktop, { nope: 'x' })).toThrow(/Unknown prop/);
    expect(() => rewriteDataProps(desktop, { start: 'nowhere' })).toThrow(/must be one of/);
    expect(() => rewriteDataProps(mobile, { theme: 'dark' })).toThrow(/no data-props/);
  });
});
