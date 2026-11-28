import type { HostGuest, HostGuestApp } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { appAskRefusal } from './app-ask';
import { appAskPhrase, appCardNote, appOutcomeLine, appsOutcomeText } from './app-words';
import { appFacts, askReasons, cardReasons, proxmoxGuestOf, snapshotName } from './tools-apps';
import { serversTaskWords } from './words';

const app = (over: Partial<HostGuestApp> = {}): HostGuestApp => ({
  service: 'server',
  version: 'v2.3.1',
  newVersion: 'v2.4.0',
  blocked: null,
  updating: false,
  last: null,
  ...over,
});

const guest = (name: string, over: Partial<HostGuest> = {}): HostGuest => ({
  id: `docker:${name}`,
  serverId: 'nas',
  name,
  platform: 'docker',
  kind: 'container',
  image: `ghcr.io/example/${name}:v2.3.1`,
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

describe('the card for an app update', () => {
  it('names the apps and the server', () => {
    const one = appAskPhrase({ server: 'nas', apps: ['docker:immich_server'] });
    expect(one.ask).toContain('immich_server');
    expect(one.ask).toContain('nas');
    expect(one.ask).not.toContain('docker:');
    expect(appAskPhrase({ server: 'nas', apps: ['a', 'b', 'c'] }).ask).toContain('3 apps');
  });

  it('says why it asks, what can’t be undone, the snapshot and the way back', () => {
    const plain = appCardNote({ server: 'nas', apps: ['docker:web'] }) ?? '';
    expect(plain).toContain('previous version back');
    expect(plain).not.toContain('database');
    const db =
      appCardNote({ server: 'nas', apps: ['docker:db'], reasons: ['database'], snapshot: true }) ?? '';
    expect(db).toContain('database');
    expect(db).toContain('can’t undo');
    expect(db).toContain('snapshot');
    expect(appCardNote({ reasons: ['major'] })).toContain('major version');
    expect(appCardNote({ reasons: ['version_unknown'] })).toContain('isn’t known');
  });
});

describe('the line when an app update ended', () => {
  it('says the new version, or the one it put back', () => {
    expect(appOutcomeLine({ app: 'Immich', status: 'updated', from: 'v2.3', to: 'v2.4' }, 'nas')).toBe(
      'Immich is updated to 2.4.',
    );
    expect(appOutcomeLine({ app: 'Immich', status: 'rolled_back', from: '2.3', to: '2.4' }, 'nas')).toBe(
      'Immich 2.4 didn’t start, so I put 2.3 back.',
    );
    expect(appOutcomeLine({ app: 'Immich', status: 'held', from: '1.9', to: '2.0' }, 'nas')).toContain('2.0');
    expect(appOutcomeLine({ app: 'Immich', status: 'failed', reason: 'no_cli' }, 'nas')).toContain('nas');
    expect(
      appOutcomeLine({ app: 'Immich', status: 'failed', reason: 'back_failed', to: '2.4' }, 'nas'),
    ).toContain('needs a look');
  });

  it('keeps to four apps and counts the rest', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ app: `app${i}`, status: 'current' }));
    const text = appsOutcomeText(many, 'nas') ?? '';
    expect(text).toContain('app3');
    expect(text).not.toContain('app4');
    expect(text).toContain('2 more');
    expect(appsOutcomeText([], 'nas')).toBeNull();
  });

  it('says each line in Dutch for a Dutch reader, with the names and versions as they are', () => {
    const back = appOutcomeLine(
      { app: 'Immich', status: 'rolled_back', from: '2.3', to: '2.4' },
      'nas',
      'nl-NL',
    );
    expect(back).toContain('Immich 2.4');
    expect(back).toContain('2.3');
    expect(back).toContain('teruggezet');
    const lines = [
      { app: 'a', status: 'updated', from: '1', to: '2' },
      { app: 'b', status: 'current' },
      { app: 'c', status: 'held', from: '1.9', to: '2.0' },
      { app: 'd', status: 'failed', reason: 'pull' },
      { app: 'e', status: 'failed', reason: 'no_files' },
      { app: 'f', status: 'failed', reason: 'no_cli' },
      { app: 'g', status: 'failed', reason: 'gone' },
      { app: 'h', status: 'failed', reason: 'back_failed', to: '2' },
      { app: 'i', status: 'failed', reason: 'timeout' },
      { app: 'j', status: 'failed' },
    ];
    for (const r of lines) {
      const nl = appOutcomeLine(r, 'nas', 'nl-NL');
      expect(nl).toContain(r.app);
      expect(nl).not.toBe(appOutcomeLine(r, 'nas'));
      expect(nl).not.toMatch(/\b(I|is updated|didn’t|couldn’t)\b/);
    }
    const many = Array.from({ length: 6 }, (_, i) => ({ app: `app${i}`, status: 'current' }));
    expect(appsOutcomeText(many, 'nas', 'nl-NL')).toContain('En nog 2');
  });

  it('is followed with the apps’ outcome', () => {
    const words = serversTaskWords(
      'app_update',
      { server: 'nas', apps: ['docker:immich_server'] },
      { server: 'nas' },
    );
    expect(words?.after).toBe('apps');
    expect(words?.server).toBe('nas');
  });
});

describe('what Dusty reads and the card must say', () => {
  it('reads one app plainly', () => {
    const facts = appFacts(guest('immich_server'), true);
    expect(facts).toMatchObject({
      app: 'docker:immich_server',
      state: 'available',
      version: '2.3.1',
      newVersion: '2.4.0',
    });
    expect(facts.asksFirst).toBeUndefined();
    const db = appFacts(
      guest('db', { image: 'postgres:16', app: app({ version: '16.4', newVersion: '17.1' }) }),
      true,
    );
    expect(db.asksFirst).toEqual(['database', 'major']);
    const latest = appFacts(guest('web', { app: app({ newVersion: null }) }), true);
    expect(latest.newVersionKnown).toBe(false);
  });

  it('carries the reasons the card must say', () => {
    const web = guest('web');
    const db = guest('db', { image: 'postgres:16', app: app({ version: '16.4', newVersion: null }) });
    expect(cardReasons([web])).toEqual([]);
    expect(cardReasons([web, db])).toEqual(['database', 'version_unknown']);
    expect(askReasons([web, db])).toEqual(['database']);
  });

  it('finds the Proxmox guest a server is, by a shared address, only when it is one', () => {
    const index = {
      servers: ['nas', 'pve-01'],
      machines: [
        { serverId: 'nas', guestId: null, name: 'nas', addresses: ['10.100.0.20'] },
        { serverId: 'pve-01', guestId: null, name: 'pve-01', addresses: ['10.100.0.2'] },
        { serverId: 'pve-01', guestId: 'pve:qemu/120', name: 'pve-01 · VM 120', addresses: ['10.100.0.20'] },
      ],
    };
    expect(proxmoxGuestOf(index, 'nas')).toEqual({
      serverId: 'pve-01',
      guestId: 'pve:qemu/120',
      name: 'pve-01 · VM 120',
    });
    expect(proxmoxGuestOf(index, 'pve-01')).toBeNull();
    expect(snapshotName(new Date('2026-11-28T22:05:00Z'))).toBe('whombat-apps-202611282205');
  });

  it('refuses the page’s Update in the person’s words', () => {
    expect(appAskRefusal([guest('web')], ['docker:web'])).toBeNull();
    expect(appAskRefusal([guest('web')], ['docker:gone'])).not.toBeNull();
    const old = guest('web', { app: undefined });
    expect(appAskRefusal([old], ['docker:web'])).toContain('newer helper');
    const run = guest('web', { app: undefined, project: undefined });
    expect(appAskRefusal([run, guest('other')], ['docker:web'])).toContain('Docker Compose');
    expect(appAskRefusal([guest('web', { app: app({ blocked: 'pinned' }) })], ['docker:web'])).toContain(
      'pinned',
    );
  });

  it('refuses in Dutch for a Dutch reader', () => {
    expect(appAskRefusal([guest('web')], ['docker:gone'], 'nl-NL')).toContain('niet meer');
    const pinned = appAskRefusal(
      [guest('web', { app: app({ blocked: 'pinned' }) })],
      ['docker:web'],
      'nl-NL',
    );
    expect(pinned).toContain('web');
    expect(pinned).not.toContain('pinned');
  });
});
