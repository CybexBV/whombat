import type { ApplianceSession } from '@whombat/client/session';
import { resourceKey } from '@whombat/client/session';
import { fixturePictureDataUrl, fixturePictureRef } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { createPictureLru, picturePlan } from './thingPictures';

const REF = fixturePictureRef('poster', 'dune-part-two');
const THING = 'connection:con_plex';

describe('a page’s pictures (AP-4650, AP-4651)', () => {
  it('are drawn on the phone in the demo world, a ref it doesn’t draw showing the letter', () => {
    const drawn = picturePlan({
      burrow: 'hq',
      thing: THING,
      ref: REF,
      access: null,
      drawn: fixturePictureDataUrl,
    });
    expect(drawn.kind).toBe('drawn');
    expect(drawn.kind === 'drawn' ? drawn.uri : '').toMatch(/^data:image\/png;base64,/);
    const other = picturePlan({
      burrow: 'hq',
      thing: THING,
      ref: 'eyJjIjoiY29uX3BsZXgifQ.c2lnbmF0dXJl',
      access: null,
      drawn: fixturePictureDataUrl,
    });
    expect(other.kind).toBe('none');
  });

  it('wait until the session is known', () => {
    expect(picturePlan({ burrow: 'hq', thing: THING, ref: REF, access: null, drawn: null }).kind).toBe(
      'wait',
    );
  });

  it('stream through a managed Whombat’s session as a `thing-image` resource, cached under a short key', () => {
    const session = {} as ApplianceSession;
    const plan = picturePlan({
      burrow: 'hq',
      thing: THING,
      ref: REF,
      access: { kind: 'session', session, scope: 'org/apl/acc' },
      drawn: null,
    });
    if (plan.kind !== 'session') throw new Error(plan.kind);
    expect(plan.ref).toEqual({ kind: 'thing-image', burrow: 'hq', thing: THING, ref: REF });
    expect([plan.scope, plan.session]).toEqual(['org/apl/acc', session]);
    // The cache's directory name fits (a ref is up to 600 characters).
    expect(resourceKey(plan.ref)).toMatch(/^img:[0-9a-f]{40}$/);
  });

  it('keep the most recently shown in the cache, letting the oldest go', () => {
    const lru = createPictureLru(3);
    expect(['a', 'b', 'c'].flatMap((k) => lru.touch(k))).toEqual([]);
    // Shown again: no longer the oldest.
    expect(lru.touch('a')).toEqual([]);
    expect(lru.touch('d')).toEqual(['b']);
    expect(lru.touch('e')).toEqual(['c']);
    expect(lru.size).toBe(3);
  });
});
