import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONSOLE, GUIDE, GUIDE_LABEL, INSTALLER, WORD } from './copy';

// The console's words must stay those of the text console (CG-07): every WORD is a string literal in
// console/internal/screen, with %s / %d where the page fills in a value.
const go = ['render.go', 'start.go']
  .map((f) => readFileSync(new URL(`../../../internal/screen/${f}`, import.meta.url), 'utf8'))
  .join('\n');

describe('WORD', () => {
  it.each(Object.entries(WORD))('%s is verbatim from the text console', (_, w) => {
    const text = typeof w === 'function' ? (w as (v: never) => string)('\u0000' as never) : w;
    const literal = text.replace('\u0000', typeof w === 'function' && /min\.$/.test(text) ? '%d' : '%s');
    expect(go).toContain(`"${literal}"`);
  });
});

// The guide is Hazel, as in the app's sign-in and claim pages (CG-35, CG-338).
describe('the guide', () => {
  it('is Hazel', () => {
    expect(GUIDE).toBe('Hazel');
    expect(GUIDE_LABEL).toBe('Hazel, your guide');
    expect(INSTALLER.welcomeSay).toBe('Hi, I’m Hazel. I’ll show you the way. It’s mostly digging.');
  });
});

describe('the alert', () => {
  it('says what the text console says (console/internal/screen/alert.go)', () => {
    const alertGo = readFileSync(new URL('../../../internal/screen/alert.go', import.meta.url), 'utf8');
    const m = /const WordAlertForeign = "([^"]*)" \+\s*"([^"]*)"/.exec(alertGo);
    expect(m ? `${m[1]}${m[2]}` : null).toBe(CONSOLE.alertForeign);
  });
});

describe('the start problem (CG-409)', () => {
  it('names the release when there is one', async () => {
    const { startWords } = await import('./console');
    expect(startWords({ problem: 'release-missing', release: 'whombat-20261120.15' })).toContain(
      'its version, whombat-20261120.15, on',
    );
    expect(startWords({ problem: 'release-missing', release: '' })).toBe(WORD.startReleaseMissingNoId);
    expect(startWords({ problem: 'offline', release: '' })).toBe(WORD.startOffline);
    expect(startWords({ problem: 'failed', release: 'x' })).toBe(WORD.startFailed);
  });
});
