/**
 * An app before Windows PCs (docs/decisions/windows-servers.md) sees a Windows PC as a standard server without an os
 * family or its Windows facts, in the fleet, on its page and in live updates. A newer app, the assistant and anything
 * outside a session get everything.
 */
import type { HostFleet, HostServerDetail, RealtimeEvent } from '@whombat/core';
import { WINDOWS_MINOR } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { beforeWindows, fleetFor, hostsEventFor, serverDetailFor } from './older-apps';

const OLD = WINDOWS_MINOR - 1;
const pc = { id: 'pc-01', name: 'pc-01', platform: 'windows', osFamily: 'windows' } as const;
const mac = { id: 'studio', name: 'studio', platform: 'macos', osFamily: 'macos' } as const;
const fleet = { servers: [pc, mac] } as unknown as HostFleet;
const detail = {
  server: pc,
  windows: { edition: 'Windows 11 Pro', volumes: [] },
} as unknown as HostServerDetail;

describe('servers for an app before Windows PCs', () => {
  it('shows an older app a Windows PC as a standard server and leaves the others alone', () => {
    const rows = fleetFor(fleet, OLD).servers;
    expect(rows[0]).toEqual({ id: 'pc-01', name: 'pc-01', platform: 'standard' });
    expect(rows[1]).toEqual(mac);
    expect(beforeWindows(mac)).toBe(mac);
  });

  it('drops the Windows facts from a PC’s page for an older app', () => {
    const old = serverDetailFor(detail, OLD) as unknown as Record<string, unknown>;
    expect(old.windows).toBeUndefined();
    expect(old.server).toEqual({ id: 'pc-01', name: 'pc-01', platform: 'standard' });
  });

  it('maps a live server row for an older app only', () => {
    const event = { type: 'hosts.server', serverId: 'pc-01', server: pc } as unknown as RealtimeEvent;
    expect(hostsEventFor(event, OLD)).toMatchObject({ server: { platform: 'standard' } });
    expect(hostsEventFor(event, WINDOWS_MINOR)).toBe(event);
    const gone = { type: 'hosts.server', serverId: 'pc-01', server: null } as unknown as RealtimeEvent;
    expect(hostsEventFor(gone, OLD)).toBe(gone);
  });

  it('gives a newer app, the assistant and anything outside a session everything', () => {
    for (const minor of [WINDOWS_MINOR, undefined]) {
      expect(fleetFor(fleet, minor)).toBe(fleet);
      expect(serverDetailFor(detail, minor)).toBe(detail);
    }
  });
});
