/**
 * The NAS drivers in the places' registry (backup-places.md BPL-04, BPL-09): failures as the registry's, the status
 * the places list shows (with “Set it up by hand” where a person could), and the NAS's say kept between lists.
 */
import { BACKUP_PLACE_TEXT, type BackupPlaceKept } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { CatalogConnectionRow } from '../../connections/types';
import type { Services } from '../../services';
import { PlaceError } from '../drivers/types';
import { forgetNasLooks, nasDriverFactory, nasStatus, placeErrorOf } from './place-driver';
import { type NasPlaceDriver, NasPlaceError } from './types';

const R = BACKUP_PLACE_TEXT.reasons;

describe('nasStatus', () => {
  it('ready with the free space, or why not and whether a person could do it by hand', () => {
    expect(nasStatus('truenas', { reason: null, freeBytes: 5 })).toEqual({
      supported: true,
      reason: null,
      byHand: false,
      freeBytes: 5,
      locations: [],
      wasIn: null,
    });
    expect(nasStatus('synology', { reason: R.synologyOld, freeBytes: null })).toMatchObject({
      supported: false,
      reason: R.synologyOld,
      byHand: false,
    });
    // Container Station's API isn't documented: not finding it may be Whombat's mistake.
    expect(nasStatus('qnap', { reason: R.qnapNoContainerStation, freeBytes: null }).byHand).toBe(true);
    expect(nasStatus('synology', { error: new NasPlaceError('refused', 'No.') })).toMatchObject({
      supported: false,
      reason: 'No.',
      byHand: true,
    });
    expect(nasStatus('synology', { error: new NasPlaceError('unreachable', 'Gone.') }).byHand).toBe(false);
    expect(nasStatus('truenas', { error: new Error('x') })).toMatchObject({ reason: R.other, byHand: true });
  });

  it('maps a NAS driver’s failure to the registry’s', () => {
    expect(placeErrorOf(new NasPlaceError('unsupported', 'a'))).toMatchObject({
      code: 'unsupported',
      message: 'a',
    });
    expect(placeErrorOf(new NasPlaceError('unreachable', 'b'))).toMatchObject({ code: 'unreachable' });
    expect(placeErrorOf(new NasPlaceError('failed', 'c'))).toBeInstanceOf(PlaceError);
    const other = new Error('d');
    expect(placeErrorOf(other)).toBe(other);
  });
});

describe('nasDriverFactory', () => {
  const row = {
    id: 'c1',
    catalogId: 'synology',
    label: 'DS',
    access: 'manage',
    status: 'active',
  } as CatalogConnectionRow;
  const services = {
    db: { select: () => ({ from: () => ({ where: async () => [row] }) }) },
  } as unknown as Services;
  const kept: BackupPlaceKept = {
    usedBytes: 1,
    freeBytes: 2,
    cleanup: { on: true, keepDays: 90, lastAt: null, ok: null },
    byHand: false,
  };

  function fake() {
    const calls: string[] = [];
    const driver: NasPlaceDriver = {
      ensure: async () => {
        calls.push('ensure');
        return { address: '192.168.1.20', port: 8747, path: '/x', location: 'tank' };
      },
      cleanup: async () => {
        calls.push('cleanup');
      },
      forget: async () => {
        throw new NasPlaceError('refused', 'Not allowed.');
      },
      kept: async () => {
        calls.push('kept');
        return kept;
      },
      unsupported: async () => null,
      look: async () => {
        calls.push('look');
        return { reason: null, freeBytes: 7, locations: [], wasIn: 'tank' };
      },
    };
    return { calls, make: () => driver };
  }

  const ctx = {
    services,
    target: {
      id: 'connection:c1',
      ref: { type: 'connection' as const, id: 'c1' },
      kind: 'synology' as const,
      name: 'DS',
    },
    actor: { id: 'whombat', name: 'Whombat', role: 'viewer' as const },
  };

  it('keeps the NAS’s say and what it keeps between lists, and forgets them after a change', async () => {
    forgetNasLooks(services, 'c1');
    const { calls, make } = fake();
    const d = nasDriverFactory('synology', make)(ctx);
    expect(await d.status?.()).toMatchObject({ supported: true, freeBytes: 7 });
    expect(await d.status?.()).toMatchObject({ supported: true });
    expect(await d.kept('whombat-home-3fkq')).toEqual(kept);
    await d.kept('whombat-home-3fkq');
    expect(calls).toEqual(['look', 'kept']);
    await d.ensure('whombat-home-3fkq', 'pw');
    await d.kept('whombat-home-3fkq');
    expect(calls).toEqual(['look', 'kept', 'ensure', 'kept']);
  });

  it('a failure is the registry’s, in the NAS’s sentence', async () => {
    const { make } = fake();
    const d = nasDriverFactory('synology', make)(ctx);
    await expect(d.forget('whombat-home-3fkq', false)).rejects.toMatchObject({
      name: 'PlaceError',
      code: 'refused',
      message: 'Not allowed.',
    });
  });

  it('the NAS’s address for the address follow', async () => {
    const { make } = fake();
    const d = nasDriverFactory(
      'synology',
      make,
    )({
      ...ctx,
      services: {
        db: {
          select: () => ({
            from: () => ({ where: async () => [{ ...row, baseUrl: 'https://192.168.1.20:5001' }] }),
          }),
        },
      } as unknown as Services,
    });
    expect(await d.addresses?.()).toEqual(['192.168.1.20']);
  });
});
