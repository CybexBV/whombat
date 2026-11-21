/**
 * MailTriggerService poll-loop isolation tests: a failing or stalled mailbox must never block other mailboxes.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../services';
import { MailTriggerService } from './service';
import type { ListenedMailbox } from './store';

vi.mock('./store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store')>();
  return {
    ...actual,
    listenedMailConnections: vi.fn(),
  };
});

import { listenedMailConnections } from './store';

function makeMailbox(connectionId: string): ListenedMailbox {
  return {
    burrowId: 'bur_test',
    since: new Date('2026-10-28T10:00:00Z'),
    triggers: [{ kind: 'mail', connectionId }],
    entries: [
      {
        automationId: `aut_${connectionId}`,
        automationName: `Auto ${connectionId}`,
        trigger: { kind: 'mail', connectionId },
        activeAt: new Date('2026-10-28T10:00:00Z'),
      },
    ],
  };
}

function makeServices() {
  const emptyQuery = { from: () => ({ where: async () => [] }) };
  const warn = vi.fn();
  const services = {
    schemaAccess: 'read-write',
    clock: () => new Date('2026-10-28T10:05:00Z'),
    db: {
      select: () => emptyQuery,
      selectDistinct: () => emptyQuery,
    },
    log: { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() },
    background: { run: vi.fn() },
    housekeeping: { add: vi.fn() },
    automations: { nudge: vi.fn() },
  } as unknown as Services;
  return { services, warn };
}

describe('MailTriggerService.pollOnce', () => {
  it('isolates one mailbox failure and runs mailboxes concurrently so a stalled mailbox never blocks others', async () => {
    const mailboxes = new Map<string, ListenedMailbox>([
      ['conn_broken', makeMailbox('conn_broken')],
      ['conn_slow', makeMailbox('conn_slow')],
      ['conn_healthy', makeMailbox('conn_healthy')],
    ]);
    vi.mocked(listenedMailConnections).mockResolvedValueOnce(mailboxes);

    const { services, warn } = makeServices();
    const svc = new MailTriggerService(services);

    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let healthyFinishedWhileSlowBlocked = false;
    let slowReleased = false;

    const spy = vi.spyOn(svc, 'syncConnection').mockImplementation(async (connectionId) => {
      if (connectionId === 'conn_broken') {
        throw new Error('unexpected mailbox failure');
      }
      if (connectionId === 'conn_slow') {
        await slowGate;
        return 1;
      }
      if (connectionId === 'conn_healthy') {
        healthyFinishedWhileSlowBlocked = !slowReleased;
        return 2;
      }
      return 0;
    });

    const pollPromise = svc.pollOnce();
    // Wait until conn_healthy has finished while conn_slow is still waiting on slowGate.
    await vi.waitFor(() => {
      expect(healthyFinishedWhileSlowBlocked).toBe(true);
    });
    slowReleased = true;
    releaseSlow();

    const triggered = await pollPromise;
    expect(triggered).toBe(3);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'conn_broken', err: 'unexpected mailbox failure' }),
      'mail trigger sync failed for mailbox',
    );
  });
});
