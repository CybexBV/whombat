import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The package root must run in browsers and Hermes: Node-only APIs are allowed only under src/node.
const src = fileURLToPath(new URL('../src', import.meta.url));

describe('purity', () => {
  it('uses no Node-only APIs outside src/node', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(src)) {
      if (!name.endsWith('.ts')) continue;
      const text = readFileSync(join(src, name), 'utf8');
      for (const [re, what] of [
        [/from ['"](node:|fs|path|os|crypto|net|buffer)['"/]/, 'node import'],
        [/\brequire\(/, 'require'],
        [/\bprocess\./, 'process'],
        [/\bBuffer\b/, 'Buffer'],
        [/from ['"]@libp2p\/noise\/crypto['"]/, 'node crypto subpath'],
        [/from ['"]\.\/node\//, 'node subpath'],
      ] as const) {
        if (re.test(text)) offenders.push(`${name}: ${what}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
