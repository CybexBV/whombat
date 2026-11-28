import type { HostGuest, HostGuestApp } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { ConnectionArgumentError } from '../connections/request';
import { appAskBound, appAskRefusal } from './app-ask';
import { appAskPhrase, appCardNote, appOutcomeLine, appsOutcomeText } from './app-words';
import type { HostsChange } from './service';
import {
  AppBindError,
  appFacts,
  askReasons,
  bindAppArgs,
  bindingOf,
  bindingReasons,
  boundToServer,
  cardReasons,
  parseBindings,
  proxmoxGuestOf,
  snapshotFinished,
  snapshotName,
  stillBound,
  tooManyWith,
  unboundText,
  withSharedImage,
  yesAllowsMajor,
  yesCovers,
} from './tools-apps';
import { serversTaskWords } from './words';

const D = `sha256:${'e'.repeat(64)}`;

const app = (over: Partial<HostGuestApp> = {}): HostGuestApp => ({
  service: 'server',
  version: 'v2.3.1',
  newVersion: 'v2.4.0',
  blocked: null,
  updating: false,
  last: null,
  newDigest: D,
  configHash: 'c0ffee',
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
    expect(appCardNote({ reasons: ['version_unknown'] })).toContain('major version');
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
    // Not what the person said yes to any more, or stopped part-way: each says so, not a plain failure.
    const failed = appOutcomeLine({ app: 'Immich', status: 'failed' }, 'nas');
    for (const reason of ['changed', 'interrupted']) {
      const line = appOutcomeLine({ app: 'Immich', status: 'failed', reason }, 'nas');
      expect(line).toContain('Immich');
      expect(line).not.toBe(failed);
    }
    expect(appOutcomeLine({ app: 'Immich', status: 'failed', reason: 'changed' }, 'nas')).toContain(
      'said yes',
    );
    expect(appOutcomeLine({ app: 'Immich', status: 'failed', reason: 'interrupted' }, 'nas')).toContain(
      'nas',
    );
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
      { app: 'k', status: 'failed', reason: 'changed' },
      { app: 'l', status: 'failed', reason: 'interrupted' },
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
    // A version that isn't known may be a new major one: it asks first, like a database.
    expect(askReasons([web, db])).toEqual(['database', 'version_unknown']);
    const latest = guest('web', { image: 'ghcr.io/example/web:latest', app: app({ version: null }) });
    expect(askReasons([latest])).toEqual(['version_unknown']);
    expect(appFacts(latest, true).asksFirst).toEqual(['version_unknown']);
  });

  it('asks first for a database, a new major version or versions that aren’t known', () => {
    expect(bindingReasons({ image: 'postgres:16', version: '16.4', newVersion: '16.5', digest: D })).toEqual([
      'database',
    ]);
    expect(bindingReasons({ image: 'web:1', version: '1.9', newVersion: '2.0', digest: D })).toEqual([
      'major',
    ]);
    expect(bindingReasons({ image: 'web:latest', version: null, newVersion: '2.0', digest: D })).toEqual([
      'version_unknown',
    ]);
    expect(bindingReasons({ image: 'web:latest', version: '1.2', newVersion: null, digest: D })).toEqual([
      'version_unknown',
    ]);
    expect(bindingReasons({ image: 'web:1', version: '1.2', newVersion: '1.3', digest: D })).toEqual([]);
    // Without the newer image's digest the tag is pulled, whatever it names by then: its version isn't known.
    expect(bindingReasons({ image: 'web:1', version: '1.2', newVersion: '1.3', digest: null })).toEqual([
      'version_unknown',
    ]);
    // A yes that said it may be a new major version covers one whose version isn't known, and lets it through.
    expect(yesCovers(['major'], 'version_unknown')).toBe(true);
    expect(yesCovers(['database'], 'version_unknown')).toBe(false);
    expect(yesAllowsMajor(['version_unknown'])).toBe(true);
    expect(yesAllowsMajor(['database'])).toBe(false);
    expect(yesAllowsMajor([])).toBe(false);
  });
});

describe('what a yes is bound to', () => {
  const ID = (c: string) => `sha256:${c.repeat(64)}`;
  const bound = (name: string, over: Partial<HostGuest> = {}, a: Partial<HostGuestApp> = {}) =>
    guest(name, {
      imageId: ID('a'),
      app: app({ service: name, newDigest: ID('e'), configHash: 'c0ffee', ...a }),
      ...over,
    });

  it('reads the service, the image, Compose’s hash and the newer image’s digest', () => {
    expect(bindingOf(bound('immich_server'))).toEqual({
      server: 'nas',
      app: 'docker:immich_server',
      service: 'immich_server',
      imageId: ID('a'),
      image: 'ghcr.io/example/immich_server:v2.3.1',
      digest: ID('e'),
      configHash: 'c0ffee',
      version: 'v2.3.1',
      newVersion: 'v2.4.0',
    });
    expect(bindingOf(bound('x', { imageId: 'abc' }))).toBeNull();
    expect(bindingOf(guest('x', { imageId: ID('a'), app: undefined }))).toBeNull();
    // Without Compose's hash of its settings nothing can be bound to it.
    expect(bindingOf(bound('x', {}, { configHash: null }))).toBeNull();
  });

  it('takes along the other services of the project that run the same image', () => {
    const server = bound('immich_server');
    const micro = bound('immich_microservices');
    const other = bound('other', { project: 'elsewhere' });
    const stopped = bound('stopped', { state: 'stopped' });
    const unhealthy = bound('unhealthy', { state: 'unhealthy' });
    const redis = bound('redis', { imageId: ID('b') });
    const all = [server, micro, other, stopped, unhealthy, redis];
    // Running or not, healthy or not: the agent updates them all together.
    expect(withSharedImage(all, [server]).map((g) => g.name)).toEqual([
      'immich_server',
      'immich_microservices',
      'stopped',
      'unhealthy',
    ]);
    expect(withSharedImage(all, [redis]).map((g) => g.name)).toEqual(['redis']);
  });

  it('names the app when its shared image makes more than one update takes', () => {
    const many = Array.from({ length: 11 }, (_, i) => bound(`worker_${i}`));
    const picked = [many[0] as HostGuest];
    expect(tooManyWith(picked, withSharedImage(many, picked))?.name).toBe('worker_0');
    const ten = many.slice(0, 10);
    expect(tooManyWith(picked, withSharedImage(ten, picked))).toBeNull();
  });

  it('refuses what changed since', () => {
    const g = bound('web');
    const b = bindingOf(g);
    if (!b) throw new Error('bound');
    expect(stillBound(g, b)).toBe(true);
    expect(stillBound(bound('web', { imageId: ID('f') }), b)).toBe(false);
    expect(stillBound(bound('web', {}, { service: 'api' }), b)).toBe(false);
    expect(stillBound(bound('web', {}, { configHash: 'beef' }), b)).toBe(false);
    // Settings that can't be read any more aren't the ones the yes was for.
    expect(stillBound(bound('web', {}, { configHash: null }), b)).toBe(false);
    expect(stillBound(g, { ...b, configHash: null })).toBe(false);
    // A newer image found since isn't a change: the yes keeps its own.
    expect(stillBound(bound('web', {}, { newDigest: ID('d') }), b)).toBe(true);
    // The same app on another server isn't the one the yes was for.
    expect(stillBound(bound('web', { serverId: 'nas-2' }), b)).toBe(false);
  });

  it('holds to the server it was read on, whatever name the call gives it', () => {
    const b = bindingOf(bound('web'));
    if (!b) throw new Error('bound');
    expect(boundToServer([b], 'nas')).toBe(true);
    // Another server has come to go by the name the call says.
    expect(boundToServer([b], 'nas-2')).toBe(false);
    expect(boundToServer([b, { ...b, server: 'nas-2' }], 'nas')).toBe(false);
  });

  it('reads back only Whombat’s own shape', () => {
    const b = bindingOf(bound('web'));
    expect(parseBindings([b])).toEqual([b]);
    expect(parseBindings([{ app: 'docker:web' }])).toBeNull();
    expect(parseBindings([{ ...b, configHash: null }])).toBeNull();
    // Without the server it was read on, a yes isn't bound to anything.
    expect(parseBindings([{ ...b, server: undefined }])).toBeNull();
    expect(parseBindings('x')).toBeNull();
    expect(parseBindings([])).toBeNull();
  });
});

describe('asking for an update only when it can be bound', () => {
  const ID = (c: string) => `sha256:${c.repeat(64)}`;
  const bound = (name: string, over: Partial<HostGuest> = {}, a: Partial<HostGuestApp> = {}) =>
    guest(name, { imageId: ID('a'), app: app({ service: name, ...a }), ...over });
  const reading =
    (all: HostGuest[]) =>
    async (_server: string): Promise<{ id: string; all: HostGuest[] }> => ({ id: 'nas', all });
  const refusal = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    if (!(err instanceof AppBindError)) throw new Error(`not refused: ${String(err)}`);
    return err;
  };

  it('binds every app and its siblings, and says every reason they ask for', async () => {
    const server = bound('immich_server');
    const ml = bound('immich_ml', { state: 'stopped' });
    const db = bound('postgres', { image: 'postgres:16', imageId: ID('b') });
    const args = await bindAppArgs(
      { server: 'nas', apps: ['immich_server', 'postgres'], reasons: ['major'], expect: [{ app: 'x' }] },
      reading([server, ml, db]),
    );
    expect(args.apps).toEqual(['docker:immich_server', 'docker:postgres', 'docker:immich_ml']);
    expect((args.expect as { app: string }[]).map((e) => e.app)).toEqual(args.apps);
    expect((args.expect as { server: string }[]).every((e) => e.server === 'nas')).toBe(true);
    // The agent forgot the database: the card says it all the same.
    expect(args.reasons).toEqual(['major', 'database']);
  });

  it('makes no card when an app can’t be bound or the apps can’t be read', async () => {
    const server = bound('immich_server');
    const noHash = bound('immich_ml', {}, { configHash: null });
    expect(
      (await refusal(bindAppArgs({ server: 'nas', apps: ['immich_server'] }, reading([server, noHash]))))
        .reason,
    ).toBe('invalid_arguments');
    const down = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    expect((await refusal(bindAppArgs({ server: 'nas', apps: ['immich_server'] }, down))).reason).toBe(
      'unreachable',
    );
    const unknown = async () => {
      throw new ConnectionArgumentError('There’s no server “x”.');
    };
    expect((await refusal(bindAppArgs({ server: 'x', apps: ['immich_server'] }, unknown))).reason).toBe(
      'invalid_arguments',
    );
    const gone = await refusal(bindAppArgs({ server: 'nas', apps: ['paperless'] }, reading([server])));
    expect(gone.message).toContain('paperless');
    const many = Array.from({ length: 11 }, (_, i) => bound(`worker_${i}`));
    expect(
      (await refusal(bindAppArgs({ server: 'nas', apps: ['worker_0'] }, reading(many)))).message,
    ).toContain('worker_0');
  });

  it('binds the page’s Update the same way, or says why it can’t, in the person’s words', () => {
    const server = bound('immich_server');
    const ml = bound('immich_ml', { state: 'unhealthy' });
    const ok = appAskBound([server, ml], ['docker:immich_server']);
    if ('refused' in ok) throw new Error(ok.refused);
    expect(ok.picked.map((g) => g.name)).toEqual(['immich_server', 'immich_ml']);
    expect(ok.expect.map((b) => b.app)).toEqual(['docker:immich_server', 'docker:immich_ml']);
    const noHash = appAskBound(
      [server, bound('immich_ml', {}, { configHash: null })],
      ['docker:immich_server'],
    );
    expect('refused' in noHash && noHash.refused).toContain('immich_ml');
    const many = Array.from({ length: 11 }, (_, i) => bound(`worker_${i}`));
    const tooMany = appAskBound(many, ['docker:worker_0'], 'nl');
    expect('refused' in tooMany && tooMany.refused).toContain('worker_0');
    expect(unboundText(server, true)).toBeNull();
  });
});

describe('a snapshot before an update', () => {
  const hub = () => {
    const listeners = new Set<(c: HostsChange) => void>();
    return {
      onChange(l: (c: HostsChange) => void) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      finish(actionId: string, result: string) {
        for (const l of [...listeners])
          l({
            kind: 'task',
            serverId: 'pve-01',
            guestId: 'pve:qemu/120',
            data: { action_id: actionId, result },
          });
      },
    };
  };

  it('hears a snapshot that finished before its id came back', async () => {
    const h = hub();
    const done = await snapshotFinished(
      h,
      async () => {
        h.finish('act_1', 'ok');
        return 'act_1';
      },
      60_000,
    );
    expect(done?.result).toBe('ok');
  });

  it('waits for the snapshot it asked for, and gives up when it doesn’t say', async () => {
    const h = hub();
    const later = snapshotFinished(h, async () => 'act_2', 60_000);
    await Promise.resolve();
    await Promise.resolve();
    h.finish('act_other', 'ok');
    h.finish('act_2', 'error');
    expect((await later)?.result).toBe('error');
    expect(await snapshotFinished(hub(), async () => 'act_3', 5)).toBeNull();
    expect(await snapshotFinished(hub(), async () => null, 5)).toBeNull();
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
