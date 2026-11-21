import { VAULT_BLANKED } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { vaultSavedRows } from './vaultSaved';

const at = '2026-10-21T09:00:00.000Z';

describe('vaultSavedRows (AP-4007)', () => {
  it('opens the saved entry, and the SSH key a password used once put on a server', () => {
    const rows = vaultSavedRows({
      vaultSaved: [
        { entryId: 'vlt_plex', name: 'Plex', kind: 'login', how: 'saved', server: null, at },
        { entryId: 'vlt_servers', name: 'Servers', kind: 'ssh', how: 'used_once', server: 'web-1', at },
      ] as never,
    });
    expect(rows.map((r) => r.entryId)).toEqual(['vlt_plex', 'vlt_servers']);
    expect(rows[0]?.text).toContain('Plex');
    expect(rows[1]?.text).toContain('web-1');
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it('is empty for a message the Vault didn’t touch (and from an older server)', () => {
    expect(vaultSavedRows({})).toEqual([]);
    expect(VAULT_BLANKED).toBe('••••••');
  });
});
