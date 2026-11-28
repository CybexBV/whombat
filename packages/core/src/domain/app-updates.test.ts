import { describe, expect, it } from 'vitest';
import {
  agentReportsApps,
  appUpdateRisk,
  appUpdateState,
  HostGuest,
  type HostGuestApp,
  HostManageRequest,
  HostTask,
  imageRepo,
  isDatabaseImage,
  isMajorJump,
  serverAsksApply,
  versionMajor,
  versionWords,
} from './index.js';

const app = (over: Partial<HostGuestApp> = {}): HostGuestApp => ({
  service: 'server',
  version: 'v2.3.1',
  newVersion: 'v2.4.0',
  blocked: null,
  updating: false,
  last: null,
  ...over,
});

describe('which images are databases', () => {
  it('reads the repository without registry, tag or digest', () => {
    expect(imageRepo('ghcr.io/immich-app/immich-server:v2.3.1')).toBe('immich-app/immich-server');
    expect(imageRepo('postgres:16@sha256:abc')).toBe('postgres');
    expect(imageRepo('localhost:5000/team/app')).toBe('team/app');
    expect(imageRepo('docker.io/library/redis:7')).toBe('library/redis');
  });

  it('knows databases by name, not by the words around them', () => {
    for (const db of [
      'postgres:16',
      'docker.io/library/mariadb:11',
      'tensorchord/pgvecto-rs:pg14-v0.2.0',
      'ghcr.io/immich-app/postgres:14-vectorchord',
      'redis:7-alpine',
      'valkey/valkey:8',
      'mongo:7',
    ])
      expect(isDatabaseImage(db), db).toBe(true);
    for (const plain of [
      'ghcr.io/immich-app/immich-server:v2',
      'nextcloud:29',
      'redis-commander:latest',
      'pgadmin4',
    ])
      expect(isDatabaseImage(plain), plain).toBe(false);
  });
});

describe('versions', () => {
  it('reads a major number, but not a year', () => {
    expect(versionMajor('v2.4.0')).toBe(2);
    expect(versionMajor('16.4')).toBe(16);
    expect(versionMajor('2024.12.1')).toBeNull();
    expect(versionMajor('latest')).toBeNull();
    expect(versionMajor(null)).toBeNull();
    expect(versionWords('v2.4.0')).toBe('2.4.0');
    expect(versionWords('version-1')).toBe('version-1');
    expect(versionWords('  ')).toBeNull();
  });

  it('calls a jump to a higher major version a major jump, only when both are known', () => {
    expect(isMajorJump('1.9', '2.0')).toBe(true);
    expect(isMajorJump('2.3', '2.4')).toBe(false);
    expect(isMajorJump('2024.11', '2025.1')).toBe(false);
    expect(isMajorJump(null, '3.0')).toBe(false);
  });
});

describe('what an app update asks', () => {
  it('asks first for a database and for a new major version', () => {
    expect(appUpdateRisk({ image: 'immich-server', app: app() })).toEqual({
      reasons: [],
      from: '2.3.1',
      to: '2.4.0',
    });
    expect(
      appUpdateRisk({ image: 'postgres:16', app: app({ version: '16.4', newVersion: '17.0' }) }).reasons,
    ).toEqual(['database', 'major']);
    expect(appUpdateRisk({ image: 'x', app: app({ newVersion: null }) }).to).toBeNull();
  });

  it('says where a container stands', () => {
    expect(appUpdateState({ updateAvailable: true }, false)).toBe('none');
    expect(appUpdateState({ project: 'immich', updateAvailable: true }, false)).toBe('outdated');
    expect(appUpdateState({ project: 'immich' }, true)).toBe('none');
    expect(
      appUpdateState({ app: app({ updating: true, blocked: 'pinned' }), updateAvailable: true }, true),
    ).toBe('updating');
    expect(appUpdateState({ app: app({ blocked: 'pinned' }), updateAvailable: true }, true)).toBe('blocked');
    expect(appUpdateState({ app: app(), updateAvailable: true }, true)).toBe('available');
    expect(appUpdateState({ app: app(), updateAvailable: false }, true)).toBe('current');
    expect(appUpdateState({ app: app() }, true)).toBe('unknown');
    expect(agentReportsApps([{}, { app: app() }])).toBe(true);
    expect(agentReportsApps([{}])).toBe(false);
  });
});

describe('the contract', () => {
  const guest = {
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
  };

  it('carries an app on a guest and an ended task’s apps, and an older box’s without them', () => {
    expect(HostGuest.safeParse(guest).success).toBe(true);
    expect(HostGuest.safeParse({ ...guest, app: app() }).success).toBe(true);
    const task = {
      id: 'app:0123456789abcdef',
      serverId: 'nas',
      platform: 'host',
      type: 'app.update',
      status: 'ok',
      started: '2026-11-28T22:00:00Z',
    };
    const parsed = HostTask.safeParse({
      ...task,
      apps: [{ app: 'docker:immich_server', status: 'rolled_back', from: '2.3', to: '2.4' }],
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('takes app.update with one to ten Docker apps on platform host', () => {
    const req = (params: unknown) =>
      HostManageRequest.safeParse({ op: 'app.update', platform: 'host', params }).success;
    expect(req({ apps: ['docker:immich_server'] })).toBe(true);
    expect(req({ apps: ['docker:immich_server'], snapshot: true })).toBe(true);
    expect(req({ apps: [] })).toBe(false);
    expect(req({ apps: ['pve:101'] })).toBe(false);
    expect(req({ apps: Array.from({ length: 11 }, (_, i) => `docker:a${i}`) })).toBe(false);
  });

  it('asks on every server when the call says ask', () => {
    const never = { asksFirst: 'never' as const };
    expect(serverAsksApply('app_update', never, {})).toBe(false);
    expect(serverAsksApply('app_update', never, { ask: true })).toBe(true);
    expect(serverAsksApply('container_update', never, { ask: true })).toBe(false);
    expect(serverAsksApply('app_update', { asksFirst: 'risky' as const }, {})).toBe(true);
  });
});
