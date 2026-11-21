import { describe, expect, it } from 'vitest';
import {
  newShare,
  openSnapshot,
  parseShareLocation,
  SHARE_KEY_BYTES,
  type SharedSnapshot,
  sealSnapshot,
  shareExpiresAt,
  shareLink,
} from './index.js';

const snapshot: SharedSnapshot = {
  v: 1,
  title: 'Holiday plans',
  sharedAt: 1_762_300_000_000,
  person: { name: 'John' },
  assistant: { name: 'Dusty', face: 'dusty' },
  messages: [
    { from: 'person', at: 1_762_299_000_000, text: 'Where should we go?' },
    { from: 'assistant', at: 1_762_299_100_000, text: '**Lisbon** in May.', pictures: ['p1'] },
  ],
  pictures: [{ id: 'p1', mime: 'image/png', data: 'iVBORw0KGgo' }],
};

describe('shared links', () => {
  it('opens what it sealed, only under the same id and key', () => {
    const { id, key } = newShare();
    const sealed = sealSnapshot(snapshot, id, key);
    expect(openSnapshot(sealed, id, key)).toEqual(snapshot);
    expect(openSnapshot(sealed, newShare().id, key)).toBeNull();
    expect(openSnapshot(sealed, id, newShare().key)).toBeNull();
    const tampered = sealed.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
    expect(openSnapshot(tampered, id, key)).toBeNull();
  });

  it('puts the key after # and reads it back from a viewer location', () => {
    const { id, key } = newShare();
    expect(key).toHaveLength(SHARE_KEY_BYTES);
    const link = shareLink(`https://app.example/s/${id}`, key);
    const [before, fragment] = link.split('#');
    expect(before).toBe(`https://app.example/s/${id}`);
    const pathname = `/s/${id}`;
    const hash = `#${fragment}`;
    const parsed = parseShareLocation(pathname, hash);
    expect(parsed?.id).toBe(id);
    expect(parsed?.key).toEqual(key);
    expect(parseShareLocation(pathname, '')).toBeNull();
    expect(parseShareLocation('/s/nope', hash)).toBeNull();
  });

  it('stops a week after it was made unless the person said otherwise', () => {
    expect(shareExpiresAt('7d', 1000)).toBe(1000 + 7 * 86_400);
    expect(shareExpiresAt('never', 1000)).toBeNull();
  });
});
