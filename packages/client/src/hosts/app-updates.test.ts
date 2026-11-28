import type { HostGuest, HostGuestApp } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { appUpdateRow, appUpdatesNote } from './app-updates';

const NOW = Date.parse('2026-11-28T12:00:00Z');

const app = (over: Partial<HostGuestApp> = {}): HostGuestApp => ({
  service: 'server',
  version: 'v2.3.1',
  newVersion: 'v2.4.0',
  blocked: null,
  updating: false,
  last: null,
  ...over,
});

const guest = (over: Partial<HostGuest> = {}): HostGuest => ({
  id: 'docker:immich_server',
  serverId: 'nas',
  name: 'immich_server',
  platform: 'docker',
  kind: 'container',
  image: 'ghcr.io/immich-app/immich-server:v2.3.1',
  state: 'running',
  cpuPct: 1,
  memoryUsedMb: 1,
  memoryLimitMb: 1,
  uptimeS: 1,
  console: { available: false },
  project: 'immich',
  updateAvailable: true,
  app: app(),
  ...over,
});

const row = (g: HostGuest, manage = true, locale?: string) =>
  appUpdateRow(g, { agentHasApps: true, manage, now: NOW, locale });

describe('an app in a server’s list', () => {
  it('shows Update with the new version where the person may change the server', () => {
    const r = row(guest());
    expect(r.state).toBe('available');
    expect(r.line).toContain('2.4.0');
    expect(r.line).not.toContain('v2.4.0');
    expect(r.tone).toBe('note');
    expect(r.update).toBe(true);
    expect(r.asks).toBeNull();
    expect(row(guest(), false).update).toBe(false);
  });

  it('says why a database or a major version asks first', () => {
    expect(
      row(guest({ image: 'postgres:16', app: app({ version: '16.4', newVersion: '16.6' }) })).asks,
    ).toContain('database');
    expect(row(guest({ app: app({ version: '1.9', newVersion: '2.0' }) })).asks).toContain('major');
  });

  it('says an update runs, a pinned image, and how the last one went for a week', () => {
    expect(row(guest({ app: app({ updating: true }) })).update).toBe(false);
    expect(row(guest({ app: app({ blocked: 'pinned' }) })).update).toBe(false);
    const back = row(
      guest({
        updateAvailable: false,
        app: app({
          last: {
            status: 'rolled_back',
            reason: 'unhealthy',
            from: '2.3',
            to: '2.4',
            at: '2026-11-28T09:00:00Z',
          },
        }),
      }),
    );
    expect(back.line).toContain('2.4');
    expect(back.line).toContain('2.3');
    expect(back.tone).toBe('bad');
    const old = row(
      guest({
        updateAvailable: false,
        app: app({
          last: { status: 'updated', reason: null, from: '2.3', to: '2.4', at: '2026-11-01T09:00:00Z' },
        }),
      }),
    );
    expect(old.line).toBeNull();
  });

  it('says nothing for a VM, and speaks Dutch', () => {
    expect(row(guest({ platform: 'pve', id: 'pve:101' })).line).toBeNull();
    expect(row(guest(), true, 'nl').line).toContain('beschikbaar');
  });
});

describe('the list’s note', () => {
  it('says the helper is older, or that only Compose apps update', () => {
    const old = guest({ app: undefined });
    expect(appUpdatesNote([old])).toContain('newer helper');
    const run = guest({ app: undefined, project: undefined });
    expect(appUpdatesNote([run, guest()])).toContain('Docker Compose');
    expect(appUpdatesNote([guest()])).toBeNull();
    expect(appUpdatesNote([])).toBeNull();
  });
});
