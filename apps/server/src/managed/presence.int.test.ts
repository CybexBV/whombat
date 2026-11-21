/**
 * Presence over a managed session (docs/decisions/essentials-conversations.md EC-27; one-person.md OP-S14): following a
 * burrow counts as the person's connection there, and the session closing takes it away.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { presenceFor } from '../realtime/presence-tracker';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';

const m = useManagedRuntime({ seed: true });
let mara: Awaited<ReturnType<typeof m.enroll>>;

beforeAll(async () => {
  mara = await m.enroll(IDS.mara);
});

const state = () => presenceFor(m.t.services).stateOf(IDS.mara);
const until = async (want: string) => {
  for (let i = 0; i < 100 && state() !== want; i++) await new Promise((r) => setTimeout(r, 20));
  return state();
};

describe('a managed session’s presence', () => {
  it('is active while it follows the burrow, offline once it closes', async () => {
    expect(state()).toBe('offline');
    const session = await m.client(mara);
    session.send({ t: 'subscribe', sub: 'b', topics: [`burrow:${TEST_BURROW_ID}`, `me:${IDS.mara}`] });
    await session.waitFor((x) => x.t === 'subscribed');
    expect(await until('active')).toBe('active');
    session.close();
    expect(await until('offline')).toBe('offline');
  });
});
