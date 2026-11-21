/**
 * The tables of the removed check servers (docs/decisions/fast-testing.md). Nothing reads or writes them; they stay
 * until a later migration drops them.
 */
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { principals } from './principals';
import { burrows } from './tenancy';
import { vaultSshServers } from './vault';

export const checkServers = pgTable(
  'check_servers',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    mode: text('mode').notNull(),
    state: text('state').notNull(),
    /** Why it is broken, in plain words. */
    problem: text('problem'),
    /** The Vault server it runs on; an adopted command may have none. A Vault server in use can't be removed. */
    serverId: text('server_id').references(() => vaultSshServers.id, { onDelete: 'restrict' }),
    /** The plan the person said yes to (runner). */
    plan: jsonb('plan'),
    limits: jsonb('limits'),
    /** `whombat-check`, or the adopted command with `{{revision}}`. */
    command: text('command').notNull(),
    /** The GitHub check that answers an adopted command which only queues. */
    resultCheck: text('result_check'),
    needsPush: boolean('needs_push').notNull().default(false),
    runnerVersion: integer('runner_version'),
    /** The installer's receipt: every step it took, which removal undoes in reverse. */
    receipt: jsonb('receipt').$type<string[]>(),
    proof: jsonb('proof'),
    /** The repository the proof runs a real full check of. */
    proveWith: jsonb('prove_with').$type<{ place: string; repo: string }>(),
    /** The label of its own GitHub runners (`whombat-thetitan`), fixed when its first repository is assigned. */
    label: text('label'),
    /**
     * Unused: an older version kept a runner pool's move here. Left in the database so older versions still read it;
     * nothing reads or writes it now.
     */
    takeOver: jsonb('take_over').$type<unknown>(),
    /** Why GitHub Actions jobs can't start there now (the watch's, in plain words); null when they can. */
    ciProblem: text('ci_problem'),
    /**
     * The isolation proof inside a job's VM: when, whether it passed, and what failed. Null:
     * it never ran, so VM runs aren't proven there.
     */
    vmProof: jsonb('vm_proof').$type<{ at: string; ok: boolean; words: string }>(),
    createdById: text('created_by_id').references(() => principals.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('check_servers_burrow_idx').on(t.burrowId)],
);
export type CheckServerRow = typeof checkServers.$inferSelect;

/** A development server that can start checks on a check server, with its own key (the private half never leaves it). */
export const checkServerClients = pgTable(
  'check_server_clients',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    checkServerId: text('check_server_id')
      .notNull()
      .references(() => checkServers.id, { onDelete: 'cascade' }),
    serverId: text('server_id')
      .notNull()
      .references(() => vaultSshServers.id, { onDelete: 'restrict' }),
    /** The folder name of the client's settings on that machine (`~/.config/whombat-check/<slug>`). */
    slug: text('slug').notNull(),
    /** The key's fingerprint (`SHA256:…`); empty for an adopted command, which uses no key of Whombat's. */
    fingerprint: text('fingerprint'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('check_server_clients_unique').on(t.checkServerId, t.serverId)],
);
export type CheckServerClientRow = typeof checkServerClients.$inferSelect;

/**
 * A computer the person set up by hand to send checks and jobs to a check server: a laptop
 * with Claude Code or Codex, which isn't a Vault server. It waits for the line its command printed; then its key is on
 * the check server behind the gate, tagged with its id like a development server's.
 */
export const checkServerComputers = pgTable(
  'check_server_computers',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    checkServerId: text('check_server_id')
      .notNull()
      .references(() => checkServers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The folder of the server's settings on that computer, which its pasted line names (`johns-laptop`). */
    slug: text('slug').notNull(),
    /** Its public key (`ssh-ed25519 …`) and fingerprint once its line was pasted; null while it waits. */
    publicKey: text('public_key'),
    fingerprint: text('fingerprint'),
    createdById: text('created_by_id').references(() => principals.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull(),
    /** When its key went on the server; null while it waits. */
    addedAt: ts('added_at'),
  },
  (t) => [
    index('check_server_computers_server_idx').on(t.checkServerId),
    uniqueIndex('check_server_computers_name_idx').on(t.checkServerId, sql`lower(${t.name})`),
    uniqueIndex('check_server_computers_slug_idx').on(t.checkServerId, t.slug),
  ],
);
export type CheckServerComputerRow = typeof checkServerComputers.$inferSelect;

/**
 * What a read-only look at one of the person's servers found that can host runners (check-server.md CKS-28): kept so a
 * repository's page can say which server hosts its runners without signing in to every server on each read.
 */
export const serverRunnerFacts = pgTable(
  'server_runner_facts',
  {
    serverId: text('server_id')
      .primaryKey()
      .references(() => vaultSshServers.id, { onDelete: 'cascade' }),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    facts: jsonb('facts'),
    /** Why the look didn't work, in plain words. */
    problem: text('problem'),
    readAt: ts('read_at').notNull(),
  },
  (t) => [index('server_runner_facts_burrow_idx').on(t.burrowId)],
);

/**
 * A question to the assistant about setting one server up for a repository's full checks, asked from that repository's
 * “Which server” (check-server.md CKS-43): the picker shows how it goes until that server is set up, and the turn that
 * answers it is kept to Whombat's own steps.
 */
export const checkServerAsks = pgTable(
  'check_server_asks',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** The Vault server it is about. */
    serverId: text('server_id')
      .notNull()
      .references(() => vaultSshServers.id, { onDelete: 'cascade' }),
    /** The repository it is for, when one was named. */
    placeId: text('place_id'),
    repo: text('repo'),
    /** The chat thread's first message: the person's question. */
    messageId: text('message_id').notNull(),
    createdById: text('created_by_id').references(() => principals.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    index('check_server_asks_burrow_idx').on(t.burrowId, t.serverId),
    uniqueIndex('check_server_asks_message_idx').on(t.messageId),
  ],
);
/**
 * A repository whose GitHub Actions run on a check server: its lane (jobs at once, runners kept
 * ready, sizes) and the labels its runners register with. One server per repository.
 */
export const checkServerActions = pgTable(
  'check_server_actions',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    checkServerId: text('check_server_id')
      .notNull()
      .references(() => checkServers.id, { onDelete: 'cascade' }),
    /** The GitHub repository, `owner/name` as GitHub spells it. */
    repo: text('repo').notNull(),
    /** Its key on the server (`actions/<key>.json`, its VMs' names). */
    key: text('key').notNull(),
    labels: jsonb('labels').$type<string[]>().notNull(),
    lane: jsonb('lane').notNull(),
    /**
     * Unused: an older version named the runner pool a repository came from here. Left in the database so older
     * versions still read it; nothing reads or writes it now.
     */
    fromPool: text('from_pool'),
    createdById: text('created_by_id').references(() => principals.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    index('check_server_actions_server_idx').on(t.checkServerId),
    // A repository runs on one server at a time; GitHub's names don't care about case.
    uniqueIndex('check_server_actions_repo_idx').on(t.burrowId, sql`lower(${t.repo})`),
    // Its files and VMs on the server are named by its key: one repository per key there.
    uniqueIndex('check_server_actions_key_idx').on(t.checkServerId, t.key),
  ],
);
export type CheckServerActionsRow = typeof checkServerActions.$inferSelect;
