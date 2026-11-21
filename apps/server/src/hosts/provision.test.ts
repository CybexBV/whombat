/**
 * The built-in Servers connection as clients read it (one-whombat-servers.md ONE-DH14): its sign-in is one of the
 * contract's kinds. The first version stored `builtin`, which the app's tolerant decoding dropped from the Connections
 * list, so a box with servers showed “1 item needs a newer version of the app.” that no reload cleared.
 */
import { api, type ConnectionView, SignInKind } from '@whombat/core';
import { decodeTolerant } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import type { CatalogConnectionRow } from '../connections/types';
import { toConnectionView } from '../connections/views';
import { SERVERS_CATALOG_ID, SERVERS_LABEL, SERVERS_SIGN_IN } from './provision';

/** The Servers row of a DEV box (2026-10-17) as the first version made it. */
const stored = (signIn: string) =>
  ({
    id: 'con_uG3o1Y5iLvNs',
    catalogId: SERVERS_CATALOG_ID,
    burrowId: 'bur_LlCbMZcjg6uM',
    connectedById: null,
    label: SERVERS_LABEL,
    handle: 'servers',
    transport: 'builtin',
    signIn,
    baseUrl: 'whombat-hosts:',
    fields: {},
    auth: null,
    status: 'active',
    reauthReason: null,
    checks: [],
    checkedAt: null,
    toolCount: 14,
    access: 'manage',
    lookedAfterById: null,
    externalName: null,
    createdAt: new Date('2026-10-17T14:52:52.366Z'),
    lastUsedAt: null,
  }) as unknown as CatalogConnectionRow;

/** What the app's tolerant decoding leaves out of `connections.list` with this one row. */
function leftOut(row: CatalogConnectionRow) {
  const view: ConnectionView = toConnectionView(row, new Map());
  const r = decodeTolerant(api.connections.list.response, {
    connections: [view],
    count: 1,
  });
  if (!r.ok) throw r.error;
  return r.skipped.filter((s) => s.action === 'dropped');
}

describe('the Servers connection in the Connections list', () => {
  it('signs in with one of the contract’s kinds', () => {
    expect(SignInKind.safeParse(SERVERS_SIGN_IN).success).toBe(true);
  });

  it('is read whole as provisioned', () => {
    expect(leftOut(stored(SERVERS_SIGN_IN))).toEqual([]);
  });

  it('was left out with the first version’s `builtin`, which provisioning now sets right', () => {
    expect(leftOut(stored('builtin'))).toEqual([
      { path: ['connections', 0], value: 'builtin', action: 'dropped' },
    ]);
  });
});
