import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { AVATAR_FACES, AVATAR_FILE_STEMS, AVATAR_VARIANTS } from '@whombat/avatars';
import { describe, expect, it } from 'vitest';
import { AVATAR_XML, svgDataUri } from './files';

const SVG_DIR = join(import.meta.dirname, '../../../../packages/avatars/svg');
const require = createRequire(import.meta.url);
const transformer = require('../../metro-svg-transformer.cjs') as {
  svgModuleSource: (src: string) => string;
  slimSvg: (src: string) => string;
};
const file = (key: string, variant: string) => readFileSync(join(SVG_DIR, `${key}-${variant}.svg`), 'utf8');

/** Every element as it draws: its tag and attributes in order, `<x …></x>` and `<x …/>` alike, metadata left out. */
function drawing(markup: string): string[] {
  const body = markup.replace(/<metadata\b[^>]*>[\s\S]*?<\/metadata>/g, '');
  return [...body.matchAll(/<([A-Za-z][\w:.-]*)([^<>]*?)\/?>/g)].map(([, tag, attrs = '']) =>
    `${tag} ${attrs.replace(/\sxmlns:c2pa="[^"]*"/, '').trim()}`.trim(),
  );
}

describe('the avatar files on Android (FA-09)', () => {
  it('are the web’s files, one per face and variant, less what doesn’t draw (AP-903)', () => {
    expect(Object.keys(AVATAR_XML)).toEqual([...AVATAR_FACES]);
    for (const face of AVATAR_FACES)
      for (const variant of AVATAR_VARIANTS) {
        const original = file(AVATAR_FILE_STEMS[face], variant);
        const shipped = AVATAR_XML[face][variant];
        expect(shipped).toBe(transformer.slimSvg(original));
        // The same elements with the same attributes, in the same order: the same picture.
        expect(drawing(shipped)).toEqual(drawing(original));
        expect(shipped).not.toMatch(/metadata|c2pa/);
        // The crew's files (crew.md) carry no metadata; the earlier ones lost a third of their bytes here.
        expect(shipped.length).toBeLessThanOrEqual(original.length);
      }
  });

  it('come from Metro as a module whose default export is the markup', () => {
    const markup = file('lead', 'head-small');
    const module = { exports: {} as { default?: string } };
    new Function('module', transformer.svgModuleSource(markup))(module);
    expect(module.exports.default).toBe(transformer.slimSvg(markup));
  });

  it('keeps what it doesn’t know to be inert', () => {
    const { slimSvg } = transformer;
    expect(
      slimSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:c2pa="x" xmlns:xlink="y"><metadata><c2pa:m>…</c2pa:m></metadata>' +
          '<use xlink:href="#a"></use><text x="1">Hi</text><g></g></svg>',
      ),
    ).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="y"><use xlink:href="#a"/><text x="1">Hi</text><g/></svg>',
    );
  });
});

describe('the small avatars’ image addresses', () => {
  it('carry each file whole, and the files are ASCII so base64 takes them as they are', () => {
    for (const face of AVATAR_FACES)
      for (const variant of AVATAR_VARIANTS) {
        const markup = AVATAR_XML[face][variant];
        expect(markup).toMatch(/^[\t\n\r -~]*$/);
        const uri = svgDataUri(markup);
        expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
        expect(Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64').toString('utf8')).toBe(markup);
        // Made once: the same string again.
        expect(svgDataUri(markup)).toBe(uri);
      }
  });
});
