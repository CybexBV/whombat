/**
 * MailTriggerService poll-loop isolation and recovery-boundary tests.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MailProviderCursor } from '../connectors/types';
import type { Services } from '../services';
import { setMailCursor } from './commands';
import { MailTriggerService } from './service';
import type { ListenedMailbox } from './store';

vi.mock('./store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store')>();
  return {
    ...actual,
    listenedMailConnections: vi.fn(),
    hasMirroredMailItem: vi.fn(async () => false),
  };
});

vi.mock('./principal', () => ({
  mailPrincipal: {
    ensure: vi.fn(async () => 'prn_mail'),
    is: () => true,
  },
}));

vi.mock('../connectors/providers', () => ({
  providerWorkspace: vi.fn(),
}));

import { providerWorkspace } from '../connectors/providers';
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
    newerAutomations: { ready: async () => true },
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

  it('records succeededAt from before the provider read rather than after slow body/attachment processing', async () => {
    const activation = new Date('2026-10-28T10:00:00.000Z');
    const beforeRead = new Date('2026-10-28T10:05:00.000Z');
    const afterBodies = new Date('2026-10-28T10:07:30.000Z');
    let now = beforeRead;

    const connRow = {
      id: 'con_gmail',
      accountId: 'acc_1',
      provider: 'google',
      status: 'active',
      services: ['mail'],
      email: 'you@example.com',
    };
    const existingCursorRow = {
      connectionId: 'con_gmail',
      cursor: { kind: 'gmail', historyId: '500' } satisfies MailProviderCursor,
      since: activation,
      succeededAt: new Date('2026-10-28T10:04:00.000Z'),
      problemCode: null,
      problem: null,
      readFailures: null,
    };

    let selectCall = 0;
    const committed: { name: string; input: Record<string, unknown> }[] = [];
    const services = {
      schemaAccess: 'read-write',
      clock: () => now,
      db: {
        select: () => ({
          from: () => ({
            where: async () => {
              selectCall += 1;
              return selectCall === 1 ? [connRow] : [existingCursorRow];
            },
          }),
        }),
      },
      google: { tokens: { accessFor: vi.fn(async () => 'tok') } },
      files: { maxBytes: 10 * 1024 * 1024, store: { stage: vi.fn(), discard: vi.fn() } },
      pipeline: {
        commit: vi.fn(async (cmd: { name: string }, input: Record<string, unknown>) => {
          committed.push({ name: cmd.name, input });
          return { status: 'ok', result: { created: true, rowId: 'mti_1' } };
        }),
      },
      log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
      background: { run: vi.fn() },
      housekeeping: { add: vi.fn() },
      automations: { nudge: vi.fn() },
      newerAutomations: { ready: async () => true },
    } as unknown as Services;

    vi.mocked(providerWorkspace).mockReturnValue({
      mailChanges: vi.fn(async () => {
        // Clock advances slightly during provider read; recovery boundary was captured before it.
        now = new Date('2026-10-28T10:05:02.000Z');
        return {
          cursor: { kind: 'gmail', historyId: '505' },
          headers: [
            {
              id: 'm_1',
              threadId: 't_1',
              messageId: '<m1@example.com>',
              from: 'billing@example.com',
              to: ['you@example.com'],
              subject: 'Invoice',
              snippet: 'Attached',
              date: '2026-10-28T10:04:55.000Z',
              hasAttachments: false,
              attachments: [],
            },
          ],
        };
      }),
      mailRead: vi.fn(async () => {
        // Downloading full body and attachments takes 2.5 minutes.
        now = afterBodies;
        return [
          {
            id: 'm_1',
            threadId: 't_1',
            from: 'billing@example.com',
            to: ['you@example.com'],
            cc: [],
            subject: 'Invoice',
            snippet: 'Attached',
            body: 'Body text',
            bodyTruncated: false,
            date: '2026-10-28T10:04:55.000Z',
            unread: true,
            labels: ['INBOX'],
            attachments: [],
          },
        ];
      }),
      mailAttachment: vi.fn(),
    } as unknown as ReturnType<typeof providerWorkspace>);

    const svc = new MailTriggerService(services);
    const created = await svc.syncConnection('con_gmail', makeMailbox('con_gmail'));
    expect(created).toBe(1);

    const cursorCommit = committed.find((c) => c.name === setMailCursor.name);
    expect(cursorCommit?.input).toMatchObject({
      connectionId: 'con_gmail',
      succeeded: true,
      succeededAt: beforeRead.toISOString(),
    });
    expect(cursorCommit?.input.succeededAt).not.toBe(afterBodies.toISOString());

    // Verify setMailCursor.apply stores the supplied pre-read succeededAt instead of the later commit ctx.now.
    let savedValues: Record<string, unknown> | null = null;
    const tx = {
      select: () => ({
        from: () => ({
          where: async () => [existingCursorRow],
        }),
      }),
      insert: () => ({
        values: (vals: Record<string, unknown>) => {
          savedValues = vals;
          return { onConflictDoUpdate: async () => undefined };
        },
      }),
    };
    await setMailCursor.apply(
      tx as unknown as Parameters<typeof setMailCursor.apply>[0],
      {
        actor: { id: 'prn_mail' },
        burrow: { id: 'bur_test' },
        now: afterBodies,
        emit: vi.fn(async () => undefined),
      } as unknown as Parameters<typeof setMailCursor.apply>[1],
      setMailCursor.schema.parse(cursorCommit?.input),
    );
    expect((savedValues as unknown as { succeededAt: Date })?.succeededAt).toEqual(beforeRead);
  });

  it('keeps the pre-backfill recovery boundary when finishing a multi-page Gmail backfill', async () => {
    const activation = new Date('2026-10-28T10:00:00.000Z');
    const priorSucceededAt = new Date('2026-10-28T10:01:00.000Z');
    const page2ReadTime = new Date('2026-10-28T10:06:00.000Z');

    const connRow = {
      id: 'con_gmail',
      accountId: 'acc_1',
      provider: 'google',
      status: 'active',
      services: ['mail'],
      email: 'you@example.com',
    };
    const backfillCursorRow = {
      connectionId: 'con_gmail',
      cursor: {
        kind: 'gmail',
        historyId: '500',
        backfill: { pageToken: 'page_2', afterSeconds: 1761645500, sinceMs: activation.getTime() },
      } satisfies MailProviderCursor,
      since: activation,
      succeededAt: priorSucceededAt,
      problemCode: null,
      problem: null,
      readFailures: null,
    };

    let selectCall = 0;
    const committed: { name: string; input: Record<string, unknown> }[] = [];
    const services = {
      schemaAccess: 'read-write',
      clock: () => page2ReadTime,
      db: {
        select: () => ({
          from: () => ({
            where: async () => {
              selectCall += 1;
              return selectCall === 1 ? [connRow] : [backfillCursorRow];
            },
          }),
        }),
      },
      google: { tokens: { accessFor: vi.fn(async () => 'tok') } },
      files: { maxBytes: 10 * 1024 * 1024, store: { stage: vi.fn(), discard: vi.fn() } },
      pipeline: {
        commit: vi.fn(async (cmd: { name: string }, input: Record<string, unknown>) => {
          committed.push({ name: cmd.name, input });
          return { status: 'ok', result: { created: false, rowId: null } };
        }),
      },
      log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
      background: { run: vi.fn() },
      housekeeping: { add: vi.fn() },
      automations: { nudge: vi.fn() },
      newerAutomations: { ready: async () => true },
    } as unknown as Services;

    vi.mocked(providerWorkspace).mockReturnValue({
      mailChanges: vi.fn(async () => ({
        cursor: { kind: 'gmail', historyId: '500' },
        headers: [],
      })),
    } as unknown as ReturnType<typeof providerWorkspace>);

    const svc = new MailTriggerService(services);
    await svc.syncConnection('con_gmail', makeMailbox('con_gmail'));

    const cursorCommit = committed.find((c) => c.name === setMailCursor.name);
    expect(cursorCommit?.input).toMatchObject({
      connectionId: 'con_gmail',
      succeeded: true,
      succeededAt: priorSucceededAt.toISOString(),
    });
  });
});
