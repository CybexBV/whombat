/** Sending a reply that links a duplicate (report-trackers.md TA-54): a refused link still sends the reply, closed. */
import { describe, expect, it } from 'vitest';
import type { BoundDriver } from './drivers';
import { SourceProblem, TrackerRefusal } from './errors';
import { sendReply } from './reply';

const REPORT = '6f1c2a0e-4d5b-4c3a-9e8f-1a2b3c4d5e6f';
const ORIGINAL = '7a2d3b1f-5e6c-4d4b-8f9a-2b3c4d5e6f70';

/** A driver whose report is new and whose original is investigating; what each send decided is kept. */
function fakeDriver(refuseLinks: boolean, originalDown = false) {
  const sends: { message?: string; status: string | null; duplicateOf?: string }[] = [];
  const driver = {
    item: async (id: string) => {
      if (originalDown && id === ORIGINAL)
        throw new SourceProblem('unreachable', 'The tracker didn’t answer.');
      return { id, status: id === REPORT ? 'new' : 'investigating', duplicateOf: null };
    },
    send: async (
      _id: string,
      input: { message?: string; status: (now: string) => unknown; duplicateOf?: string },
    ) => {
      const status = input.status('new') as string | null;
      sends.push({
        ...(input.message ? { message: input.message } : {}),
        status,
        ...(status === 'duplicate' && input.duplicateOf ? { duplicateOf: input.duplicateOf } : {}),
      });
      if (refuseLinks && status === 'duplicate' && input.duplicateOf)
        throw new TrackerRefusal('duplicates must link directly to an original');
      return { sent: true as const, status, already: false, now: 'new' };
    },
  } as unknown as BoundDriver;
  return { driver, sends };
}

describe('a reply that links a duplicate', () => {
  it('links it when the tracker takes the link', async () => {
    const { driver, sends } = fakeDriver(false);
    const sent = await sendReply(
      driver,
      REPORT,
      { message: 'Someone reported this too.', asks: false, closes: true, duplicateOf: ORIGINAL },
      'a8a0c1e5-8a4b-4c7d-9f00-000000000001',
    );
    expect(sent.status).toBe('duplicate');
    expect(sends.at(-1)).toMatchObject({ status: 'duplicate', duplicateOf: ORIGINAL });
  });

  it('still sends the reply, closed, when the tracker refuses the link', async () => {
    const { driver, sends } = fakeDriver(true);
    const sent = await sendReply(
      driver,
      REPORT,
      { message: 'Someone reported this too.', asks: false, closes: true, duplicateOf: ORIGINAL },
      'a8a0c1e5-8a4b-4c7d-9f00-000000000002',
    );
    expect(sent.status).toBe('closed');
    expect(sends).toHaveLength(2);
    expect(sends.at(-1)).toMatchObject({ status: 'closed', message: 'Someone reported this too.' });
    expect(sends.at(-1)).not.toHaveProperty('duplicateOf');
  });

  it('tries again later when the original can’t be read now, rather than dropping the link for good', async () => {
    const { driver, sends } = fakeDriver(false, true);
    await expect(
      sendReply(
        driver,
        REPORT,
        { message: 'Someone reported this too.', asks: false, closes: true, duplicateOf: ORIGINAL },
        'a8a0c1e5-8a4b-4c7d-9f00-000000000003',
      ),
    ).rejects.toThrow();
    expect(sends).toHaveLength(0);
  });
});
