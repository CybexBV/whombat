import { describe, expect, it } from 'vitest';
import { epochMs, isWhombatPush, managedPush, pushPayload, shadeEntry } from './iosPayload';

const REF = 'AbCdEfGhIjKlMnOpQrStUv';

/** A remote notification as expo-notifications reports it on iOS: Expo's `body` in data, the APNs payload in the trigger. */
function remote(payload: Record<string, unknown>, identifier = 'thr_1') {
  return {
    identifier,
    content: { data: null },
    trigger: { type: 'push', payload: { aps: { alert: { title: 'Dusty', body: 'Done' } }, ...payload } },
  };
}

describe('iOS push payloads', () => {
  it('reads the APNs payload from the trigger, not content.data', () => {
    const p = pushPayload(remote({ w: { kind: 'mention', ref: REF } }));
    expect(managedPush(p)).toEqual({ kind: 'mention', ref: REF });
  });

  it('falls back to content.data for a local notification', () => {
    const p = pushPayload({ content: { data: { path: '/c/general' } }, trigger: null });
    expect(p).toEqual({ path: '/c/general' });
  });

  it('knows Whombat alerts and leaves others alone', () => {
    expect(isWhombatPush(pushPayload(remote({ w: { kind: 'run', ref: REF } })))).toBe(true);
    expect(isWhombatPush(pushPayload(remote({ path: '/runs/4' })))).toBe(true);
    expect(isWhombatPush(pushPayload(remote({ other: 1 })))).toBe(false);
    expect(isWhombatPush(null)).toBe(false);
  });

  it('turns iOS seconds into epoch ms', () => {
    expect(epochMs(1_730_000_000.25)).toBe(1_730_000_000_250);
    expect(epochMs(1_730_000_000_250)).toBe(1_730_000_000_250);
  });

  it('describes delivered notifications for the shade check by their collapse id', () => {
    expect(
      shadeEntry({ date: 1_730_000_000, request: remote({ w: { kind: 'approval', ref: REF } }, 'apr_12') }),
    ).toEqual({ tag: 'apr_12', postedAt: 1_730_000_000_000, kind: 'approval', ref: REF });
    expect(
      shadeEntry({
        date: 1_730_000_000,
        request: remote({ path: '/c/general', burrow: 'lumio', notificationId: 'ntf_3' }, 'x'),
      }),
    ).toEqual({
      tag: 'x',
      postedAt: 1_730_000_000_000,
      notificationId: 'ntf_3',
      burrow: 'lumio',
      path: '/c/general',
    });
    expect(shadeEntry({ date: 1, request: remote({ path: '/c/general' }) })).toBeNull();
  });
});
