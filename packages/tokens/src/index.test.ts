import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderTokensCss } from './index.js';

const committedCss = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8');

/** Extracts `--name: value` pairs from one CSS block. */
function _block(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing block ${selector}`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]));
}

describe('tokens.css', () => {
  it('is up to date (run `pnpm --filter @whombat/tokens generate`)', () => {
    expect(committedCss).toBe(renderTokensCss());
  });
});
