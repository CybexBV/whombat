/**
 * Restore tests of Proxmox machines (docs/decisions/backup-trust.md), migration 0044: the person's switch per server
 * (`restore_test_servers`) and one row per test (`restore_tests`), which the restore test job moves step by step so a
 * test survives a restart of the runtime. Written only through the commit pipeline (`backup-trust/commands.ts`).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { ts } from './common';
import { burrows } from './tenancy';

/** Whether a Proxmox server's machines are tested, and which (empty: every one that can be). */
export const restoreTestServers = pgTable(
  'restore_test_servers',
  {
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** The hosts service's server id, as it gives it. */
    serverId: text('server_id').notNull(),
    on: boolean('on').notNull().default(false),
    /** The hosts service's guest ids chosen (`pve:101`); empty: all. */
    guests: jsonb('guests').$type<string[]>().notNull().default([]),
    changedAt: ts('changed_at').notNull(),
  },
  (t) => [primaryKey({ name: 'restore_test_servers_pk', columns: [t.burrowId, t.serverId] })],
);

/**
 * Where a test is: `pick` it waits to choose a backup and a place; `restoring` Proxmox restores the copy; `configuring`
 * Whombat pulls the copy's network cables and names it; `starting` it was asked to start; `booting` it runs and Whombat
 * waits for it to finish starting; `cleaning` the outcome is known and the copy is stopped and deleted; `done`.
 */
export type RestoreTestStep =
  | 'pick'
  | 'restoring'
  | 'configuring'
  | 'starting'
  | 'booting'
  | 'cleaning'
  | 'done';

export const restoreTests = pgTable(
  'restore_tests',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    serverId: text('server_id').notNull(),
    /** The machine whose backup is tested (`pve:101`), and its name then. */
    guestId: text('guest_id').notNull(),
    guestName: text('guest_name').notNull(),
    kind: text('kind').$type<'vm' | 'container'>().notNull(),
    step: text('step').$type<RestoreTestStep>().notNull(),
    /** Set once it is known; the copy may still be being removed (`cleaning`). */
    outcome: text('outcome').$type<'worked' | 'failed' | 'skipped'>(),
    reason: text('reason'),
    /** The backup restored, when it was made, and the storage the copy went to. */
    volume: text('volume'),
    backupAt: ts('backup_at'),
    storage: text('storage'),
    /** The copy's Proxmox id, chosen and written down before Proxmox is asked to restore it. */
    copyId: integer('copy_id'),
    copyName: text('copy_name'),
    /** The Proxmox task Whombat waits on (the restore, a stop, a delete). */
    task: text('task'),
    /** The real machine's guest agent answered, so the copy's should too. */
    agentExpected: boolean('agent_expected').notNull().default(false),
    booted: boolean('booted'),
    /** Started by the person's *Test one now* rather than the weekly turn. */
    manual: boolean('manual').notNull().default(false),
    /** How many times the current step's call was made (a call cut off by a restart is made again, twice at most). */
    tries: integer('tries').notNull().default(0),
    startedAt: ts('started_at').notNull(),
    stepAt: ts('step_at').notNull(),
    runningAt: ts('running_at'),
    durationS: integer('duration_s'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    // One test at a time on a server.
    uniqueIndex('restore_tests_active').on(t.burrowId, t.serverId).where(sql`${t.finishedAt} IS NULL`),
    index('restore_tests_guest').on(t.burrowId, t.serverId, t.guestId, t.startedAt),
    check(
      'restore_tests_step',
      sql`${t.step} IN ('pick', 'restoring', 'configuring', 'starting', 'booting', 'cleaning', 'done')`,
    ),
    check(
      'restore_tests_outcome',
      sql`${t.outcome} IS NULL OR ${t.outcome} IN ('worked', 'failed', 'skipped')`,
    ),
  ],
);

/** What a connection's own backups are, as the health pass last read them (`catalog_connections.protection`). */
export interface StoredProtection {
  state: 'copied' | 'local' | 'none';
  lastAt: string | null;
  where: string | null;
  failedAt?: string | null;
  /** `none` though a plan or task covers it: none of its backups has worked yet. */
  planned?: boolean;
}
