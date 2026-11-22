/**
 * MailTriggerService poll-loop isolation and recovery-boundary tests.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MailProviderCursor } from '../connectors/types';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import { MAIL_RECORDED_MAX_ATTACHMENTS, recordMailReceived, setMailCursor } from './commands';
import { mailItemScope } from './items';
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

  it('caps attachment metadata at 100, clips oversized fields, records omitted count, and advances the cursor', async () => {
    const activation = new Date('2026-10-28T10:00:00.000Z');
    const now = new Date('2026-10-28T10:05:00.000Z');
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
      succeededAt: activation,
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
      files: {
        maxBytes: 10 * 1024 * 1024,
        store: {
          stage: vi.fn(async () => ({
            token: '00000000-0000-4000-8000-000000000001',
            size: 16,
            sha256: 'a'.repeat(64),
          })),
          discard: vi.fn(async () => undefined),
        },
      },
      pipeline: {
        commit: vi.fn(
          async (
            cmd: { name: string; schema: { parse: (v: unknown) => unknown } },
            input: Record<string, unknown>,
          ) => {
            const parsed = cmd.schema.parse(input) as Record<string, unknown>;
            committed.push({ name: cmd.name, input: parsed });
            return { status: 'ok', result: { created: true, rowId: 'mti_many' } };
          },
        ),
      },
      log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
      background: { run: vi.fn() },
      housekeeping: { add: vi.fn() },
      automations: { nudge: vi.fn() },
    } as unknown as Services;

    const pdfBase64 = Buffer.from('%PDF-1.4\nhello\n%%EOF').toString('base64');
    const hugeAttachments = Array.from({ length: 105 }, (_, i) => ({
      id: `att_${i + 1}`,
      name: `${'x'.repeat(600)}-${i + 1}.pdf`,
      mimeType: `application/${'y'.repeat(250)}`,
      size: 20,
    }));
    const oversizedMessageId = `<${'m'.repeat(600)}@example.com>`;

    vi.mocked(providerWorkspace).mockReturnValue({
      mailChanges: vi.fn(async () => ({
        cursor: { kind: 'gmail', historyId: '506' },
        headers: [
          {
            id: 'm_many',
            threadId: 't_many',
            messageId: oversizedMessageId,
            from: 'billing@example.com',
            to: ['you@example.com'],
            subject: 's'.repeat(1500),
            snippet: 'n'.repeat(800),
            date: '2026-10-28T10:04:55.000Z',
            hasAttachments: true,
            attachments: [],
          },
        ],
      })),
      mailRead: vi.fn(async () => [
        {
          id: 'm_many',
          threadId: 't_many',
          from: `${'A'.repeat(600)} <billing@example.com>`,
          to: ['you@example.com'],
          cc: [],
          subject: 's'.repeat(1500),
          snippet: 'n'.repeat(800),
          body: 'b'.repeat(60_000),
          bodyTruncated: false,
          date: '2026-10-28T10:04:55.000Z',
          unread: true,
          labels: ['INBOX'],
          attachments: hugeAttachments,
        },
      ]),
      mailAttachment: vi.fn(async () => ({
        name: 'doc.pdf',
        mimeType: 'application/pdf',
        contentBase64: pdfBase64,
      })),
    } as unknown as ReturnType<typeof providerWorkspace>);

    const svc = new MailTriggerService(services);
    expect(await svc.syncConnection('con_gmail', makeMailbox('con_gmail'))).toBe(1);

    const received = committed.find((c) => c.name === recordMailReceived.name)?.input as {
      attachments: { name: string; missingReason?: string }[];
      omittedAttachmentCount: number;
      stagedAttachments: unknown[];
      messageId: string | null;
      bodyTruncated: boolean;
    };
    expect(received).toBeDefined();
    expect(received.attachments).toHaveLength(MAIL_RECORDED_MAX_ATTACHMENTS);
    expect(received.omittedAttachmentCount).toBe(5);
    expect(received.stagedAttachments).toHaveLength(10);
    expect(received.messageId?.length).toBeLessThanOrEqual(500);
    expect(received.bodyTruncated).toBe(true);

    // Cursor moved past the 105-attachment message cleanly.
    const cursorCommit = committed.find((c) => c.name === setMailCursor.name);
    expect(cursorCommit?.input).toMatchObject({
      connectionId: 'con_gmail',
      cursor: { kind: 'gmail', historyId: '506' },
      succeeded: true,
    });

    // Run scope and fenced prompt both reflect the 5 omitted attachments alongside the 90 capped records.
    const scope = mailItemScope({
      id: 'mti_many',
      burrowId: 'bur_test',
      connectionId: 'con_gmail',
      provider: 'google',
      mailbox: 'you@example.com',
      externalId: 'm_many',
      threadId: 't_many',
      fromHeader: 'billing@example.com',
      fromAddress: 'billing@example.com',
      subject: 'Many files',
      snippet: '',
      body: 'See files.',
      bodyTruncated: false,
      attachments: received.attachments.map((a) => ({
        name: a.name,
        mimeType: 'application/pdf',
        size: 20,
        ...(a.missingReason ? { missingReason: a.missingReason as 'too_many' } : {}),
      })),
      omittedAttachmentCount: received.omittedAttachmentCount,
      attachmentIds: Array.from({ length: 10 }, (_, i) => `att_${i + 1}`),
      receivedAt: now,
    });
    expect(scope.attachmentCount).toBe(105);
    expect((scope.missingAttachments as unknown[]).length).toBe(20);
    expect(scope.missingAttachmentsOmitted).toBe(75);
    expect(String(scope.text)).toContain('and 85 more');
    expect(String(scope.text)).toContain('and 75 more (attachment limit reached)');
  });

  it('routes commit validation failures through the 3-attempt bounded skip logic so one bad message never stalls a mailbox', async () => {
    const activation = new Date('2026-10-28T10:00:00.000Z');
    const now = new Date('2026-10-28T10:05:00.000Z');
    const connRow = {
      id: 'con_gmail',
      accountId: 'acc_1',
      provider: 'google',
      status: 'active',
      services: ['mail'],
      email: 'you@example.com',
    };
    const cursorRow: {
      connectionId: string;
      cursor: MailProviderCursor;
      since: Date;
      succeededAt: Date;
      problemCode: string | null;
      problem: string | null;
      readFailures: Record<string, number> | null;
    } = {
      connectionId: 'con_gmail',
      cursor: { kind: 'gmail', historyId: '600' },
      since: activation,
      succeededAt: activation,
      problemCode: null,
      problem: null,
      readFailures: null,
    };

    const discarded: unknown[] = [];
    const cursorCommits: Record<string, unknown>[] = [];
    let goodCommitted = 0;

    const makeSvc = () => {
      let selectCall = 0;
      const services = {
        schemaAccess: 'read-write',
        clock: () => now,
        db: {
          select: () => ({
            from: () => ({
              where: async () => {
                selectCall += 1;
                return selectCall % 2 === 1 ? [connRow] : [{ ...cursorRow }];
              },
            }),
          }),
        },
        google: { tokens: { accessFor: vi.fn(async () => 'tok') } },
        files: {
          maxBytes: 10 * 1024 * 1024,
          store: {
            stage: vi.fn(async () => ({
              token: '00000000-0000-4000-8000-000000000002',
              size: 16,
              sha256: 'b'.repeat(64),
            })),
            discard: vi.fn(async (s: unknown) => {
              discarded.push(s);
            }),
          },
        },
        pipeline: {
          commit: vi.fn(async (cmd: { name: string }, input: Record<string, unknown>) => {
            if (cmd.name === recordMailReceived.name) {
              if (input.externalId === 'm_bad') {
                throw new ApiError('validation_failed', 'Some fields are not valid.');
              }
              goodCommitted += 1;
              return { status: 'ok', result: { created: true, rowId: 'mti_good' } };
            }
            if (cmd.name === setMailCursor.name) {
              cursorCommits.push(input);
              if (input.cursor) cursorRow.cursor = input.cursor as MailProviderCursor;
              if ('readFailures' in input) {
                cursorRow.readFailures = (input.readFailures as Record<string, number> | null) ?? null;
              }
              if ('problemCode' in input)
                cursorRow.problemCode = (input.problemCode as string | null) ?? null;
              if ('problem' in input) cursorRow.problem = (input.problem as string | null) ?? null;
            }
            return { status: 'ok', result: { connectionId: 'con_gmail', cleared: false } };
          }),
        },
        log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
        background: { run: vi.fn() },
        housekeeping: { add: vi.fn() },
        automations: { nudge: vi.fn() },
      } as unknown as Services;
      return new MailTriggerService(services);
    };

    const pdfBase64 = Buffer.from('%PDF-1.4\nhello\n%%EOF').toString('base64');
    vi.mocked(providerWorkspace).mockReturnValue({
      mailChanges: vi.fn(async () => ({
        cursor: { kind: 'gmail', historyId: '605' },
        headers: [
          {
            id: 'm_bad',
            threadId: 't_bad',
            messageId: '<bad@example.com>',
            from: 'billing@example.com',
            to: ['you@example.com'],
            subject: 'Bad message',
            snippet: '',
            date: '2026-10-28T10:04:55.000Z',
            hasAttachments: true,
            attachments: [],
          },
          {
            id: 'm_good',
            threadId: 't_good',
            messageId: '<good@example.com>',
            from: 'billing@example.com',
            to: ['you@example.com'],
            subject: 'Good message',
            snippet: '',
            date: '2026-10-28T10:04:56.000Z',
            hasAttachments: false,
            attachments: [],
          },
        ],
      })),
      mailRead: vi.fn(async (_tok: string, q: { messageId?: string }) => [
        {
          id: q.messageId ?? 'm_bad',
          threadId: q.messageId === 'm_good' ? 't_good' : 't_bad',
          from: 'billing@example.com',
          to: ['you@example.com'],
          cc: [],
          subject: q.messageId === 'm_good' ? 'Good message' : 'Bad message',
          snippet: '',
          body: 'Body',
          bodyTruncated: false,
          date: '2026-10-28T10:04:55.000Z',
          unread: true,
          labels: ['INBOX'],
          attachments:
            q.messageId === 'm_bad'
              ? [{ id: 'a1', name: 'a.pdf', mimeType: 'application/pdf', size: 20 }]
              : [],
        },
      ]),
      mailAttachment: vi.fn(async () => ({
        name: 'a.pdf',
        mimeType: 'application/pdf',
        contentBase64: pdfBase64,
      })),
    } as unknown as ReturnType<typeof providerWorkspace>);

    const svc = makeSvc();
    // Attempts 1 and 2 hold the cursor back and increment readFailures while discarding staged files.
    expect(await svc.syncConnection('con_gmail', makeMailbox('con_gmail'))).toBe(0);
    expect(cursorRow.readFailures).toEqual({ m_bad: 1 });
    expect(cursorRow.cursor).toEqual({ kind: 'gmail', historyId: '600' });

    expect(await svc.syncConnection('con_gmail', makeMailbox('con_gmail'))).toBe(0);
    expect(cursorRow.readFailures).toEqual({ m_bad: 2 });
    expect(cursorRow.cursor).toEqual({ kind: 'gmail', historyId: '600' });

    // Attempt 3 skips m_bad, processes m_good, records the skipped-mail problem, and advances the cursor.
    expect(await svc.syncConnection('con_gmail', makeMailbox('con_gmail'))).toBe(1);
    expect(goodCommitted).toBe(1);
    expect(cursorRow.readFailures).toBeNull();
    expect(cursorRow.cursor).toEqual({ kind: 'gmail', historyId: '605' });
    expect(cursorRow.problemCode).toBe('read_failed');
    expect(discarded).toHaveLength(3);
  });
});
