/**
 * Setting a place up by hand (backup-places.md BPL-09): the compose holds the user's bcrypt line and no cleanup, the
 * password waits a day and the same app is handed out meanwhile, and “Check it” sets the place once the app answers.
 */
import type { BackupPlaceKind } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { BY_HAND_TTL_MS, type ByHandDeps, type PendingPlace, placeByHand, placeCheck } from './by-hand';
import { readPlaceCompose } from './compose';
import { htpasswdMatches } from './htpasswd';
import { NasPlaceError } from './types';

const CLIENT = 'whombat-home-3fkq';

function deps(kind: BackupPlaceKind, over: Partial<ByHandDeps> = {}) {
  const store = new Map<string, PendingPlace>();
  let now = new Date('2026-11-03T12:00:00Z');
  const finished: Parameters<ByHandDeps['finish']>[0][] = [];
  const d: ByHandDeps = {
    place: async (id) => (id === 'connection:c1' ? { id, kind, name: 'Vault' } : null),
    client: async () => CLIENT,
    pending: async (id) => store.get(id) ?? null,
    putPending: async (id, p) => {
      store.set(id, p);
    },
    address: async () => '192.168.1.30',
    probe: async () => 401,
    finish: async (input) => {
      finished.push(input);
      return {
        placeId: input.place.id,
        destination: input.place.name,
        locationName: null,
        appendOnly: 'verified',
        firstBackup: true,
      };
    },
    now: () => now,
    ...over,
  };
  return { d, store, finished, later: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe('backup.placeByHand', () => {
  it('hands out the compose with the user’s bcrypt line and no cleanup, and keeps the password a day', async () => {
    const { d, store } = deps('qnap');
    const out = await placeByHand(d, { placeId: 'connection:c1' });
    const pending = store.get('connection:c1');
    expect(pending).toMatchObject({ client: CLIENT, port: 8747 });
    expect(out.expiresAt).toBe(new Date(Date.parse('2026-11-03T12:00:00Z') + BY_HAND_TTL_MS).toISOString());
    const read = readPlaceCompose(out.compose);
    expect(htpasswdMatches(read.htpasswd ?? '', pending?.password ?? '')).toBe(true);
    expect(read.cleanup).toBeNull();
    expect(read.dataPath).toBe(`/share/Container/whombat-backups/${CLIENT}`);
    expect(out.compose).not.toContain(pending?.password ?? '');
    expect(Object.keys((parse(out.compose) as { services: object }).services)).toEqual(['server']);
    expect(out.steps.length).toBeGreaterThanOrEqual(3);
    expect(out.steps.some((s) => s.includes('Container Station'))).toBe(true);
  });

  it('asked again the same day: the same password, so a compose pasted earlier still checks', async () => {
    const { d, store, later } = deps('synology');
    await placeByHand(d, { placeId: 'connection:c1' });
    const first = store.get('connection:c1')?.password;
    later(60 * 60_000);
    await placeByHand(d, { placeId: 'connection:c1' });
    expect(store.get('connection:c1')?.password).toBe(first);
    later(BY_HAND_TTL_MS);
    await placeByHand(d, { placeId: 'connection:c1' });
    expect(store.get('connection:c1')?.password).not.toBe(first);
  });

  it('per kind: where the backups go and what the person does', async () => {
    const syn = await placeByHand(deps('synology').d, { placeId: 'connection:c1' });
    expect(readPlaceCompose(syn.compose).dataPath).toBe('./backups');
    expect(syn.steps.some((s) => s.includes('Container Manager'))).toBe(true);
    const tn = await placeByHand(deps('truenas').d, { placeId: 'connection:c1' });
    expect(readPlaceCompose(tn.compose).dataPath).toBe(`/mnt/tank/whombat-backups/${CLIENT}`);
    expect(tn.steps.some((s) => s.includes('Install via YAML'))).toBe(true);
    expect(tn.steps.some((s) => s.includes('tank'))).toBe(true);
    const pooled = await placeByHand(deps('truenas', { trueNasPool: async () => 'fast' }).d, {
      placeId: 'connection:c1',
    });
    expect(readPlaceCompose(pooled.compose).dataPath).toBe(`/mnt/fast/whombat-backups/${CLIENT}`);
    expect(pooled.steps.some((s) => s.includes('tank'))).toBe(false);
    const linux = await placeByHand(deps('linux').d, { placeId: 'connection:c1' });
    expect(linux.steps.some((s) => s.includes('docker compose up -d'))).toBe(true);
  });

  it('an unknown place fails plainly', async () => {
    await expect(placeByHand(deps('qnap').d, { placeId: 'connection:other' })).rejects.toBeInstanceOf(
      NasPlaceError,
    );
  });
});

describe('backup.placeCheck', () => {
  it('sets the place with the waiting password once the app answers', async () => {
    const { d, store, finished } = deps('synology');
    await placeByHand(d, { placeId: 'connection:c1' });
    const out = await placeCheck(d, { placeId: 'connection:c1', move: true });
    expect(out).toMatchObject({ placeId: 'connection:c1', appendOnly: 'verified' });
    expect(finished).toEqual([
      expect.objectContaining({
        client: CLIENT,
        address: '192.168.1.30',
        port: 8747,
        password: store.get('connection:c1')?.password,
        move: true,
      }),
    ]);
  });

  it('an app that doesn’t answer yet, or a password that waited too long, says what to do', async () => {
    const quiet = deps('qnap', { probe: async () => null });
    await placeByHand(quiet.d, { placeId: 'connection:c1' });
    await expect(placeCheck(quiet.d, { placeId: 'connection:c1' })).rejects.toMatchObject({
      reason: 'failed',
      message: /8747/,
    });
    expect(quiet.finished).toEqual([]);
    const late = deps('qnap');
    await placeByHand(late.d, { placeId: 'connection:c1' });
    late.later(BY_HAND_TTL_MS + 1);
    await expect(placeCheck(late.d, { placeId: 'connection:c1' })).rejects.toMatchObject({
      reason: 'failed',
    });
    const never = deps('qnap');
    await expect(placeCheck(never.d, { placeId: 'connection:c1' })).rejects.toMatchObject({
      reason: 'failed',
    });
  });
});
