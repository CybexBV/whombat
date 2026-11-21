/**
 * A thing page's head before `things.page` answers (app page-speed.md AP-2650, AP-2651): read from the cache, Home's
 * things first, then `connections.list`, of the open burrow only; nothing cached, nothing drawn.
 */
import { QueryClient } from '@tanstack/react-query';
import type { HomeOverview, ThingSummary } from '@whombat/core';
import { api, type ConnectionsListResponse } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import { endpointKey } from '../query/keys';
import { cachedThingHead } from './home';

const thing = (id: string, name: string, status: ThingSummary['status']) =>
  ({ id, kind: 'connection', name, icon: 'homeassistant', status, facts: [], href: '/' }) as ThingSummary;
const home = (things: ThingSummary[]) => ({ things }) as unknown as HomeOverview;
const list = (label: string) =>
  ({
    connections: [{ id: 'con_ha', catalogId: 'homeassistant', label, fields: {} }],
  }) as unknown as ConnectionsListResponse;

describe('cachedThingHead (AP-2650, AP-2651)', () => {
  it('finds the thing in Home’s things of the burrow', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      endpointKey(api.home.overview, { params: { burrow: 'hq' } }),
      home([thing('connection:con_ha', 'Home Assistant', 'ok')]),
    );
    qc.setQueryData(
      endpointKey(api.home.overview, { params: { burrow: 'other' } }),
      home([thing('connection:con_x', 'Elsewhere', 'ok')]),
    );
    expect(cachedThingHead(qc, 'hq', 'connection:con_ha')).toMatchObject({
      name: 'Home Assistant',
      status: 'ok',
    });
    expect(cachedThingHead(qc, 'hq', 'connection:con_x')).toBeNull();
  });

  it('prefers Home’s row, else the connections list; nothing cached gives null', () => {
    const qc = new QueryClient();
    expect(cachedThingHead(qc, 'hq', 'connection:con_ha')).toBeNull();
    qc.setQueryData(endpointKey(api.connections.list, { params: { burrow: 'hq' } }), list('Attic'));
    expect(cachedThingHead(qc, 'hq', 'connection:con_ha')).toMatchObject({ name: 'Attic', status: null });
    qc.setQueryData(
      endpointKey(api.home.overview, { params: { burrow: 'hq' } }),
      home([thing('connection:con_ha', 'Home Assistant', 'bad')]),
    );
    expect(cachedThingHead(qc, 'hq', 'connection:con_ha')).toMatchObject({
      name: 'Home Assistant',
      status: 'bad',
    });
  });
});
