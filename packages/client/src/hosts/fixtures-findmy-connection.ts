/**
 * The Find My connection of the fixture worlds (docs/implementation/macos/findmy-connection.md): Find My on the fixture
 * Mac, studio, read every 15 minutes in the background because an automation waits for Ruben to get home. Its row in
 * the connections list (its `mac` and `background` fields), its tile on Overview and its page as the server's kind
 * sends it — the Find My tab naming the Mac, which the apps draw themselves. The web's fixture world lists it beside the
 * Mac (`localStorage['whombat.fixtures.mac']`); the phone's demo world always. Not imported by production code.
 */
import { type HostSeriesRange, type ThingPage, type ThingSummary, thingHref, thingId } from '@whombat/core';
import type { ConnectionView } from '@whombat/core/domain';
import { MAC_SERVER } from './fixtures-mac';

export const FIND_MY_CONNECTION_ID = 'con_findmy';

/** Its thing id, `connection:con_findmy`. */
export const FIND_MY_THING = thingId('connection', FIND_MY_CONNECTION_ID);

/** What the person picked when connecting it: the Mac, and Read in the background every 15 minutes. */
export const FIND_MY_CONNECTION_FIELDS: Readonly<Record<string, string>> = {
  mac: MAC_SERVER,
  background: '15',
};

/** The connection as `connections.list` and `connections.tools` carry it. */
export function findMyConnectionView(at: string, over: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: FIND_MY_CONNECTION_ID as ConnectionView['id'],
    catalogId: 'findmy',
    label: 'Find My',
    handle: 'findmy' as ConnectionView['handle'],
    connectedBy: { id: null, name: 'Mara' },
    detail: MAC_SERVER,
    signIn: 'none',
    transport: 'rest',
    fields: { ...FIND_MY_CONNECTION_FIELDS },
    status: 'active',
    reauthReason: null,
    checks: [{ id: 'credential', state: 'ok', message: null }],
    checkedAt: at,
    toolCount: 1,
    access: 'manage',
    poller: null,
    createdAt: at,
    lastUsedAt: at,
    ...over,
  };
}

/** Its tile on Overview and in the sidebar: how many people, when it was read (never a place). */
export function findMyConnectionThing(): ThingSummary {
  return {
    id: FIND_MY_THING,
    kind: 'connection',
    catalogId: 'findmy',
    name: 'Find My',
    icon: 'findmy',
    status: 'ok',
    line: '4 people · read 5 min ago',
    facts: [],
    href: thingHref('connection', FIND_MY_CONNECTION_ID),
  };
}

/** Its page: the Find My tab, which names the Mac and carries no panels, then the apps' own tabs. */
export function findMyConnectionPage(readAt: string, range: HostSeriesRange = '24h'): ThingPage {
  return {
    id: FIND_MY_THING,
    kind: 'connection',
    connectionId: FIND_MY_CONNECTION_ID as ThingPage['connectionId'],
    catalogId: 'findmy',
    name: 'Find My',
    icon: 'findmy',
    status: 'ok',
    badge: 'Connected',
    facts: [],
    runsOn: null,
    settings: true,
    tabs: [{ key: 'findmy', label: 'Find My', server: MAC_SERVER, panels: [] }],
    actions: [],
    readAt,
    range,
    ranges: [range],
    refreshS: 60,
  };
}
