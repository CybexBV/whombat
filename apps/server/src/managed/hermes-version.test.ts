import { describe, expect, it } from 'vitest';
import { applianceHermes } from './hermes-version';

const check = (ready: boolean, version: string | null) => ({ ready, version, problem: null, detail: null });

describe('the Hermes version This Whombat shows', () => {
  it('is the ready runner’s version', () => {
    expect(applianceHermes(check(true, '0.22.5'))).toEqual({ version: '0.22.5' });
  });

  it('is unknown while no runner said, or its Hermes isn’t ready', () => {
    expect(applianceHermes(null)).toBeNull();
    expect(applianceHermes(check(false, '0.22.5'))).toBeNull();
    expect(applianceHermes(check(true, null))).toBeNull();
    expect(applianceHermes(check(true, '  '))).toBeNull();
  });

  it('fits the contract', () => {
    expect(applianceHermes(check(true, 'x'.repeat(120)))?.version).toHaveLength(64);
  });
});
