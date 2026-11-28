/**
 * Restore tests, the signed commands (docs/decisions/backup-trust.md):
 *
 * - **`restoreTests.set`** (the person): turns a Proxmox server's weekly restore tests on or off and chooses its
 *   machines. Asking Whombat's assistant to do it goes through the person's approval card first.
 * - **`restoreTest.begin`** (the restore test job as the agent, or the person's *Test one now*): writes down a test of
 *   one machine before anything is asked of Proxmox, so a restart of the runtime finds it and carries on.
 * - **`restoreTest.step`** (the job): moves a test on: the backup and the copy's number chosen (written down before the
 *   restore is asked for, so the copy can always be found and deleted), the task followed, the outcome, the end.
 *
 * Events carry ids and the machine's name only.
 */
import { randomUUID } from 'node:crypto';
import { RestoreTestOutcome, RestoreTestReason, SetRestoreTestsBody } from '@whombat/core';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { restoreTestServers, restoreTests } from '../db/schema/index';
import { conflict, forbidden, notFound } from '../lib/errors';

const Id = z.string().min(1).max(200);

export const setRestoreTests = defineCommand({
  name: 'restoreTests.set',
  schema: SetRestoreTestsBody.extend({ serverId: Id, serverName: z.string().min(1).max(160) }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can turn restore tests on or off.');
    const guests = [...new Set(input.guests ?? [])];
    await tx
      .insert(restoreTestServers)
      .values({ burrowId: ctx.burrow.id, serverId: input.serverId, on: input.on, guests, changedAt: ctx.now })
      .onConflictDoUpdate({
        target: [restoreTestServers.burrowId, restoreTestServers.serverId],
        set: { on: input.on, guests, changedAt: ctx.now },
      });
    await ctx.emit({
      type: 'restore_tests.set',
      kind: 'System',
      text: input.on
        ? `Turned on weekly restore tests for ${input.serverName}`
        : `Turned off restore tests for ${input.serverName}`,
      where: null,
      payload: { serverId: input.serverId, on: input.on, guests: guests.length },
    });
    return { serverId: input.serverId, on: input.on };
  },
});

export const beginRestoreTest = defineCommand({
  name: 'restoreTest.begin',
  schema: z.object({
    serverId: Id,
    guestId: Id,
    guestName: z.string().min(1).max(160),
    kind: z.enum(['vm', 'container']),
    manual: z.boolean(),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent' && ctx.actor.kind !== 'person')
      throw forbidden('Only you or Whombat start a restore test.');
    const [running] = await tx
      .select({ id: restoreTests.id })
      .from(restoreTests)
      .where(
        and(
          eq(restoreTests.burrowId, ctx.burrow.id),
          eq(restoreTests.serverId, input.serverId),
          isNull(restoreTests.finishedAt),
        ),
      );
    if (running) throw conflict('A restore test is already running on this server.');
    const id = `rst_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    await tx.insert(restoreTests).values({
      id,
      burrowId: ctx.burrow.id,
      serverId: input.serverId,
      guestId: input.guestId,
      guestName: input.guestName,
      kind: input.kind,
      step: 'pick',
      manual: input.manual,
      startedAt: ctx.now,
      stepAt: ctx.now,
    });
    await ctx.emit({
      type: 'restore_test.started',
      kind: 'System',
      text: `Started a restore test of ${input.guestName}`,
      where: null,
      payload: { testId: id, serverId: input.serverId, guestId: input.guestId, manual: input.manual },
    });
    return { id };
  },
});

const Step = z.enum(['pick', 'restoring', 'configuring', 'starting', 'booting', 'cleaning', 'done']);

export const stepRestoreTest = defineCommand({
  name: 'restoreTest.step',
  schema: z.object({
    id: Id,
    step: Step.optional(),
    outcome: RestoreTestOutcome.optional(),
    reason: RestoreTestReason.optional(),
    volume: z.string().max(500).optional(),
    backupAt: z.string().datetime().nullable().optional(),
    storage: z.string().max(100).optional(),
    copyId: z.number().int().optional(),
    copyName: z.string().max(100).optional(),
    task: z.string().max(500).nullable().optional(),
    agentExpected: z.boolean().optional(),
    booted: z.boolean().optional(),
    tries: z.number().int().min(0).max(100).optional(),
    runningAt: z.string().datetime().nullable().optional(),
    durationS: z.number().int().min(0).max(86_400).optional(),
    finished: z.boolean().optional(),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only Whombat moves a restore test on.');
    const [row] = await tx
      .select()
      .from(restoreTests)
      .where(and(eq(restoreTests.id, input.id), eq(restoreTests.burrowId, ctx.burrow.id)));
    if (!row) throw notFound('Restore test');
    if (row.finishedAt) return { id: row.id, finished: true };
    const { id, finished, backupAt, runningAt, ...rest } = input;
    const stepChanged = input.step !== undefined && input.step !== row.step;
    await tx
      .update(restoreTests)
      .set({
        ...rest,
        ...(backupAt !== undefined ? { backupAt: backupAt ? new Date(backupAt) : null } : {}),
        ...(runningAt !== undefined ? { runningAt: runningAt ? new Date(runningAt) : null } : {}),
        ...(stepChanged ? { stepAt: ctx.now, tries: input.tries ?? 0 } : {}),
        ...(finished ? { step: 'done' as const, finishedAt: ctx.now } : {}),
      })
      .where(eq(restoreTests.id, id));
    // The outcome is told once, when it is first known.
    if (input.outcome && !row.outcome)
      await ctx.emit({
        type: 'restore_test.result',
        kind: 'System',
        text:
          input.outcome === 'worked'
            ? `The restore test of ${row.guestName} worked`
            : input.outcome === 'failed'
              ? `The restore test of ${row.guestName} didn’t work`
              : `The restore test of ${row.guestName} couldn’t run`,
        where: null,
        payload: {
          testId: row.id,
          serverId: row.serverId,
          guestId: row.guestId,
          outcome: input.outcome,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      });
    return { id, finished: !!finished };
  },
});
