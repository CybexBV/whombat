/**
 * A 1Password vault kept in step with the Vault over the session (docs/decisions/onepassword-sync.md): its three
 * operations on the connection's own path, how a client may ask again after a lost answer, that the assistant's
 * settings leave them alone, and the minor that brings them.
 */
import { describe, expect, it } from 'vitest';
import { assistantSetting } from './assistant-settings/index.js';
import { OPERATION_SAFETY } from './operation-safety.js';
import { API_OPERATIONS } from './operations.js';
import { ACCOUNT_PAGES_MINOR, ONEPASSWORD_SYNC_MINOR, SESSION_PROTOCOL } from './version.js';

const OPS = [
  'connections.onePassword',
  'connections.onePasswordSync',
  'connections.onePasswordRemovals',
] as const;

describe('the 1Password sync over the session', () => {
  it('is three operations on the connection’s own path', () => {
    for (const op of OPS) {
      const spec = API_OPERATIONS.get(op);
      expect(spec?.endpoint?.path, op).toMatch(
        /^\/burrows\/:burrow\/connections\/:connectionId\/onepassword/,
      );
      expect(spec?.secret, op).toBe(false);
    }
    expect(
      OPS.map((op) => [API_OPERATIONS.get(op)?.endpoint?.method, API_OPERATIONS.get(op)?.mutating]),
    ).toEqual([
      ['GET', false],
      ['POST', true],
      ['POST', true],
    ]);
  });

  it('asks the page again, resends Sync now by its receipt, and leaves the guard’s answer to a person', () => {
    expect(OPS.map((op) => OPERATION_SAFETY[op])).toEqual([
      { destructive: false, retry: 'safe' },
      { destructive: false, retry: 'receipt' },
      { destructive: true, retry: 'receipt' },
    ]);
  });

  it('is no setting of the assistant: the sync is the person’s, like the Vault', () => {
    for (const op of OPS) expect(assistantSetting(op), op).toEqual({ access: 'none' });
  });

  it('lets disconnecting keep or remove the entries it brought', () => {
    const query = API_OPERATIONS.get('connections.disconnect')?.endpoint?.query;
    expect(query?.safeParse({}).success).toBe(true);
    expect(query?.safeParse({ vaultEntries: 'remove' }).success).toBe(true);
    expect(query?.safeParse({ vaultEntries: 'all' }).success).toBe(false);
  });

  it('comes with session minor 8, after account pages', () => {
    expect(ONEPASSWORD_SYNC_MINOR).toBe(ACCOUNT_PAGES_MINOR + 1);
    expect(SESSION_PROTOCOL.minor).toBeGreaterThanOrEqual(ONEPASSWORD_SYNC_MINOR);
  });
});
