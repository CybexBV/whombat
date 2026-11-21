import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, idPrefix, newId } from './ids.js';

describe('ID_PREFIXES', () => {
  it('gives every kind a prefix of its own, so an id says what it is', () => {
    const seen = new Map<string, string>();
    for (const [kind, prefix] of Object.entries(ID_PREFIXES)) {
      expect(seen.get(prefix), `${kind} and ${seen.get(prefix)} share ${prefix}`).toBeUndefined();
      seen.set(prefix, kind);
    }
  });

  it('makes new ids with the kind’s prefix', () => {
    expect(idPrefix(newId('delegation'))).toBe('dlg');
  });
});
