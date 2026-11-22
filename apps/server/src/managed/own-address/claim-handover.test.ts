import { describe, expect, it, vi } from 'vitest';
import { ManagerCallError, type ManagerPort } from '../ports';
import { ClaimLinkHandover } from './claim-handover';

function setup(answer: () => Promise<void> = async () => {}) {
  const sent: (string | null)[] = [];
  let link: string | null = null;
  const manager = {
    linkClaim: vi.fn(async (req: { claimLink?: string }) => {
      await answer();
      sent.push(req.claimLink ?? null);
    }),
  } as unknown as ManagerPort;
  const log = { debug: vi.fn() } as never;
  const handover = new ClaimLinkHandover({ manager, current: () => link, log, timers: false });
  return {
    handover,
    sent,
    manager: manager as unknown as { linkClaim: ReturnType<typeof vi.fn> },
    set: (next: string | null) => {
      link = next;
    },
  };
}

describe('handing the claim link to the manager', () => {
  it('gives a new link at once, the same one only on the regular hand-over, and takes it back once there is none', async () => {
    const t = setup();
    t.set('pqrtvw');
    await t.handover.start();
    await t.handover.sync();
    expect(t.sent).toEqual(['pqrtvw']);
    // Again now and then: a manager that restarted has it back.
    await t.handover.sync(true);
    expect(t.sent).toEqual(['pqrtvw', 'pqrtvw']);
    // A new link after new letters; then the box is claimed.
    t.set('abcdef');
    await t.handover.sync();
    t.set(null);
    await t.handover.sync();
    await t.handover.sync(true);
    expect(t.sent).toEqual(['pqrtvw', 'pqrtvw', 'abcdef', null]);
  });

  it('keeps the order of its calls, so a link taken back right after it was given stays taken back', async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const t = setup(async () => {
      if (first) {
        first = false;
        await slow;
      }
    });
    t.set('pqrtvw');
    const giving = t.handover.sync();
    // The first call is at the manager and slow to answer when the box is claimed.
    await new Promise((r) => setImmediate(r));
    expect(t.manager.linkClaim).toHaveBeenCalledTimes(1);
    t.set(null);
    const taking = t.handover.sync();
    release();
    await Promise.all([giving, taking]);
    expect(t.sent).toEqual(['pqrtvw', null]);
  });

  it('tries again after a failure, and leaves a manager without the route alone until the link changes', async () => {
    let fail: Error | null = new ManagerCallError('/v1/link/claim', 0, 'unreachable', 'down');
    const t = setup(async () => {
      if (fail) throw fail;
    });
    t.set('pqrtvw');
    await t.handover.sync();
    fail = null;
    await t.handover.sync();
    expect(t.sent).toEqual(['pqrtvw']);

    fail = new ManagerCallError('/v1/link/claim', 404, 'not_found', 'manager: 404 not found');
    t.set('abcdef');
    await t.handover.sync();
    const calls = t.manager.linkClaim.mock.calls.length;
    await t.handover.sync(true);
    await t.handover.sync();
    expect(t.manager.linkClaim.mock.calls.length).toBe(calls);
    // An updated manager takes the next change.
    fail = null;
    t.set('hjkmnp');
    await t.handover.sync();
    expect(t.sent).toEqual(['pqrtvw', 'hjkmnp']);
  });

  it('does nothing with a manager that has no such call', async () => {
    const handover = new ClaimLinkHandover({
      manager: {} as ManagerPort,
      current: () => 'pqrtvw',
      log: { debug: vi.fn() } as never,
      timers: false,
    });
    await expect(handover.start()).resolves.toBeUndefined();
  });
});
