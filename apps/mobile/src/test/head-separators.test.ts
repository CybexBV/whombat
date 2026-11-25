/**
 * The heads of a thing's and a server's page lay out their small parts (the state, when it was read, the week's line)
 * in a row that wraps on a narrow phone. The row's gap sets them apart; a part that starts with its own “·” would
 * start the next line with it when the row wraps. A static guard, as `talkback-order.test.ts` is.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../', import.meta.url);
const HEADS = ['screens/ServerScreen.tsx', 'screens/ThingPageScreen.tsx'];

describe('the heads’ wrapping rows', () => {
  it.each(HEADS)('%s starts no part with its own “·”', (file) => {
    const source = readFileSync(new URL(file, SRC), 'utf8');
    // A part's text that begins with the separator: `· ${…}` or '· …'.
    expect(source).not.toMatch(/[`'"]· (\$\{|[A-Za-z])/);
  });
});
