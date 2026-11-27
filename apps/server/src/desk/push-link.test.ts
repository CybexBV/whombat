import { describe, expect, it } from 'vitest';
import { opaqueRef, registerPushResolver, resolvePushRef } from '../managed/push';
import type { Services } from '../services';
import { DESK_SETTINGS_PATH, UnlockPushes, unlockPushPreview, unlockPushWhat } from './push-link';

const refOf = (what: string) => opaqueRef('ref', what);
const ORIGIN = 'https://app.whombat.test/';

describe('a tap on the unlock push (DK-S21)', () => {
  it('opens This Whombat for the account it went to, as long as a push lives', () => {
    const sent = new UnlockPushes(3_600_000);
    sent.remember('dur_0001', 'acc_mara', 'burrow-hq', 0);
    const ref = refOf(unlockPushWhat('dur_0001'));
    expect(sent.resolve(ref, 'acc_mara', 1_000, refOf, ORIGIN)).toEqual({
      burrow: 'burrow-hq',
      link: { type: 'external', url: `https://app.whombat.test${DESK_SETTINGS_PATH}` },
    });
    expect(DESK_SETTINGS_PATH).toBe('/settings?tab=appliance');
    expect(sent.resolve(ref, 'acc_tom', 1_000, refOf, ORIGIN)).toBeNull();
    expect(sent.resolve(refOf(unlockPushWhat('dur_0002')), 'acc_mara', 1_000, refOf, ORIGIN)).toBeNull();
    expect(sent.resolve(ref, 'acc_mara', 3_600_001, refOf, ORIGIN)).toBeNull();
  });

  it('is what push.resolve answers before the inbox is looked at', async () => {
    const services = { config: {}, db: null } as unknown as Services;
    const ref = refOf(unlockPushWhat('dur_0003'));
    const target = { burrow: 'burrow-hq', link: { type: 'external' as const, url: `${ORIGIN}x` } };
    const off = registerPushResolver(services, async (account, asked) =>
      account === 'acc_mara' && asked === ref ? target : null,
    );
    expect(await resolvePushRef(services, 'acc_mara', ref)).toEqual(target);
    off();
    await expect(resolvePushRef(services, 'acc_mara', 'not a ref')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('the unlock push’s words', () => {
  it('are in the person’s language, English without one', () => {
    const english = unlockPushPreview(null);
    expect(english.title).toContain('unlock');
    expect(english.body).toContain('Unlock');
    const dutch = unlockPushPreview('nl-NL');
    expect(dutch.title).toContain('ontgrendelen');
    expect(dutch.body).toContain('Ontgrendel');
  });
});
