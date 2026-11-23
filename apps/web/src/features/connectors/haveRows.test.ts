/**
 * The overview's rows by what the box answers: on a box at session minor 7 a connected account's row opens its own page
 * (Google, Microsoft 365 and Email by their connection, GitHub's and Website feedback's own things); on an older box
 * its Settings page. Catalog connections open their page either way.
 */
import { describe, expect, it } from 'vitest';
import { type ConnectionEntry, haveRows } from './ConnectionsOverview';
import type { CatalogRow } from './catalog';

const connected = (thing: string) => ({ detail: null, meta: '', ok: true, state: 'Connected', thing });
const ENTRIES: ConnectionEntry[] = [
  { page: 'github', connected: connected('connection:github'), tile: { action: 'Open', note: null } },
  { page: 'google', connected: connected('connection:con_mara'), tile: { action: 'Open', note: null } },
  { page: 'imap', connected: null, tile: { action: 'Connect', note: null } },
  { page: 'feedback', connected: connected('connection:feedback'), tile: { action: 'Set up', note: null } },
];
const CATALOG: CatalogRow[] = [
  {
    id: 'con_ha',
    catalogId: 'homeassistant',
    label: 'Home Assistant',
    name: 'Home Assistant',
    address: '10.100.0.5:8123',
    lookOnly: false,
    state: 'Connected',
    tone: 'ok',
    reason: null,
  },
];

describe('haveRows', () => {
  it('opens a connected account’s own page on a box at minor 7', () => {
    const rows = haveRows(ENTRIES, CATALOG, true);
    expect(rows.map((r) => [r.key, r.thing])).toEqual([
      ['github', '/things/connection%3Agithub'],
      ['google', '/things/connection%3Acon_mara'],
      ['feedback', '/things/connection%3Afeedback'],
      ['con_ha', '/things/connection%3Acon_ha'],
    ]);
  });

  it('keeps an account’s Settings page on an older box', () => {
    const rows = haveRows(ENTRIES, CATALOG);
    expect(rows.map((r) => r.thing)).toEqual([null, null, null, '/things/connection%3Acon_ha']);
    expect(rows[1]?.search).toEqual({ tab: 'connections', connection: 'google' });
  });
});
