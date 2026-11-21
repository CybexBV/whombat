/** Settings → Connections in the demo world (connections-more-android.md AP-2815): its answers match the contracts. */
import { type AnyEndpoint, api } from '@whombat/core';
import { at } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ORIGIN } from '../data/config';
import { addConnectionRows, connectedRows, connectionsOverview } from '../data/connections';
import { createClock } from '../lib/time';
import { createFixtureServer } from './fixture-server';

const burrow = 'burrow-hq';

function setup() {
  return createFixtureServer({
    inner: createFixtureFetch(),
    now: createClock(new Date(at('14:05')), Date.now()),
    setTimer: () => undefined,
    assistant: true,
  });
}

/** The answer, parsed strictly with the endpoint's own response schema. */
async function answer<T>(server: ReturnType<typeof setup>, ep: AnyEndpoint, path: string): Promise<T> {
  const res = await server.fetch(`${FIXTURE_ORIGIN}/api/v1${path}`);
  expect(res.status).toBe(200);
  const parsed = ep.response.safeParse(await res.json());
  if (!parsed.success) throw new Error(`${ep.id}: ${parsed.error.message}`);
  return parsed.data as T;
}

describe('Settings → Connections in the demo world (AP-2815)', () => {
  it('answers the burrow’s connections, the catalog and Mara’s accounts', async () => {
    const server = setup();
    const list = await answer<{ connections: Parameters<typeof connectedRows>[0] }>(
      server,
      api.connections.list,
      `/burrows/${burrow}/connections`,
    );
    const catalog = await answer<{ entries: Parameters<typeof addConnectionRows>[0] }>(
      server,
      api.connections.catalog,
      '/connections/catalog',
    );
    const status = await answer<{
      connections: Parameters<typeof connectedRows>[1];
      imap?: { available: boolean };
    }>(server, api.connectors.status, '/connectors');

    const rows = connectedRows(list.connections, status.connections, burrow);
    const overview = connectionsOverview(rows);
    expect(overview.needsYou).toEqual([]);
    // Mara's Google and IMAP mailbox under ACCOUNTS, then the burrow's by label, each saying where.
    expect(overview.accounts.map((r) => [r.title, r.line])).toEqual([
      ['Google', 'mara@lumio.example'],
      ['Email (IMAP)', 'mara@okafor.example'],
    ]);
    expect(overview.apps.map((r) => [r.title, r.line])).toEqual([
      ['Hetzner', null],
      ['Home Assistant', '10.100.0.131:8123'],
      ['UniFi', '10.100.0.1'],
    ]);

    // Every entry is offered, Email (IMAP) too (AP-2816); what Mara has is tagged Connected.
    expect(status.imap?.available).toBe(true);
    const offered = addConnectionRows(
      catalog.entries,
      rows.map((r) => r.catalogId),
      burrow,
      { imap: status.imap?.available },
    );
    const connected = offered.filter((r) => r.tag?.text === 'Connected').map((r) => r.id);
    expect(connected).toEqual(
      expect.arrayContaining(['google', 'imap', 'homeassistant', 'unifi_network', 'hetzner']),
    );
    expect(offered.every((r) => r.note === null)).toBe(true);
  });
});
