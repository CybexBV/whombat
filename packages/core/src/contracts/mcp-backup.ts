/**
 * This Whombat's own backups for its assistant (Whombat first-day.md). Spread into `MCP_TOOLS` (`./mcp`); `personal:
 * true` (only in a turn for the person, acting for them) and no key: the person's yes on the Needs you proposal (“Back
 * up this Whombat to nas-01?”) is what asks for it.
 *
 * - Without `set`: whether this Whombat is backed up and where to, and the public key it signs in to an SFTP server
 *   with (to add to that server's `authorized_keys` first).
 * - With `set`: where the backups go, only while nothing does or while they go only to this Whombat's own disk —
 *   moving them elsewhere stays the person's (Settings → This Whombat). `place`: a NAS or server Whombat sets up to keep
 *   them (backup-places.md); `sftp`: a folder on a server this Whombat reaches over SSH; `disk`: the disk labelled
 *   WHOMBAT-BACKUP plugged into it.
 */
import { z } from 'zod';
import type { McpTool } from './mcp.js';

export const WHOMBAT_BACKUP_FAILURES = [
  /** This Whombat has no backup service (a development box). */
  'unavailable',
  /** Backups go somewhere already: the person moves them. */
  'already_set',
  /** Not in a turn for the person. */
  'not_here',
  /** The backup service refused the destination (`message` says why, in its words). */
  'refused',
  /** No such place, or it isn't ready (`message` says what it needs). */
  'place_not_ready',
] as const;
export const WhombatBackupFailure = z.enum(WHOMBAT_BACKUP_FAILURES);

export const WhombatBackupInput = z
  .object({
    set: z
      .enum(['place', 'sftp', 'disk'])
      .optional()
      .describe(
        'Leave out to read the state, the places on the network and this Whombat’s SSH key. place: a NAS or server Whombat sets up to keep the backups (the best choice); sftp: a folder on a server over SSH; disk: the disk labelled WHOMBAT-BACKUP plugged into this Whombat',
      ),
    place: z
      .string()
      .trim()
      .min(3)
      .max(300)
      .optional()
      .describe('place: the place’s id from places (server:<id> or connection:<id>)'),
    location: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'place: where on it (a location id from places); leave out for the recommended one, or when the person named none',
      ),
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[A-Za-z0-9.:-]+$/)
      .optional()
      .describe('sftp: the server’s address or name (192.168.1.40, nas-01.lan)'),
    port: z.number().int().min(1).max(65535).optional().describe('sftp: its SSH port when it isn’t 22'),
    user: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z_][a-z0-9_.-]*$/i)
      .optional()
      .describe('sftp: the user this Whombat signs in as (its key in that user’s authorized_keys)'),
    path: z
      .string()
      .trim()
      .min(2)
      .max(200)
      .regex(/^\/[^\s@]*$/)
      .optional()
      .describe('sftp: the folder, a full path like /srv/whombat-backup'),
  })
  .superRefine((i, ctx) => {
    if (i.set === 'place' && i.place === undefined)
      ctx.addIssue({ code: 'custom', message: 'place needs place.', path: ['place'] });
    if (i.set !== 'sftp') return;
    for (const field of ['host', 'user', 'path'] as const)
      if (i[field] === undefined)
        ctx.addIssue({ code: 'custom', message: `sftp needs ${field}.`, path: [field] });
  });
export type WhombatBackupInput = z.input<typeof WhombatBackupInput>;

export const WhombatBackupOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    /** `unprotected` until a destination is set; then `pending` until the first backup, `protected`, `stale`, `failing`. */
    state: z.enum(['unprotected', 'pending', 'protected', 'stale', 'failing']),
    /** Where backups go (host or bucket, no secrets), when set. */
    destination: z.string().nullable(),
    /** One authorized_keys line: the key this Whombat signs in to an SFTP server with. */
    publicKey: z.string().nullable(),
    /** NAS and servers that could keep the backups, and whether they can now (`ready`) or what they need. */
    places: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          state: z.string(),
          reason: z.string().nullable(),
          locations: z
            .array(
              z.object({
                id: z.string(),
                name: z.string(),
                recommended: z.boolean(),
                note: z.string().nullable(),
              }),
            )
            .optional(),
        }),
      )
      .optional(),
    /**
     * The copy somewhere else (Whombat offsite-copy.md): the second place where the backups are copied after each one,
     * a bucket the person owns; null when there is none. `state`: `first` the first copy hasn't finished, `copying` now,
     * `ok` the newest backup is in it, `behind` newer ones wait for the next copy, `failing` the last tries failed
     * (`problem` says why, in plain words). Setting it up or changing it is the person's, in Settings → This Whombat →
     * Backups (it needs the bucket's key).
     */
    offsite: z
      .object({
        place: z.string(),
        state: z.enum(['first', 'copying', 'ok', 'behind', 'failing']),
        lastCopyAt: z.string().nullable(),
        newestInCopyAt: z.string().nullable(),
        problem: z.string().nullable(),
      })
      .nullable()
      .optional(),
  }),
  z.object({
    status: z.literal('set'),
    kind: z.enum(['place', 'sftp', 'disk']),
    /** Where backups go, as people read it (a name, never an address or path). */
    destination: z.string(),
    /**
     * What to tell the person, in one or two plain sentences (where, and whether the first backup is running). Whombat
     * tells them in the same thread when the first backup is done or didn't work, so the agent needn't check back.
     */
    say: z.string().optional(),
    /** SFTP: the server's host key fingerprint now trusted (`SHA256:…`). */
    hostKeyFingerprint: z.string().nullable(),
  }),
  z.object({ status: z.literal('failed'), reason: WhombatBackupFailure, message: z.string() }),
]);
export type WhombatBackupOutput = z.infer<typeof WhombatBackupOutput>;

/* Getting one thing back (Whombat backup-look.md) ------------------------------------------------------------------- */

export const BACKUP_BRING_BACK_FAILURES = [
  /** Not in a turn for the person. */
  'not_here',
  /** This Whombat has no backup service, or its backup service can't open a backup for reading yet. */
  'unavailable',
  /** No backup from before then (or none at all). */
  'no_backup',
  /** Opening the backup was refused: not enough room, or another one is open (`message` says which). */
  'refused',
  /** `bring` without a backup open (find it again first), or with ids it doesn't have. */
  'not_open',
] as const;
export const BackupBringBackFailure = z.enum(BACKUP_BRING_BACK_FAILURES);

export const BackupBringBackInput = z
  .object({
    find: z
      .string()
      .trim()
      .min(2)
      .max(200)
      .optional()
      .describe(
        'Words of what to find: in a chat’s title or its messages (“roof”, “invoice Acme”); every word must be in it',
      ),
    before: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        'find: the newest backup from before this time is opened — for “yesterday’s chat” the start of today in the person’s time zone; leave out for the newest backup',
      ),
    category: z
      .enum(['messages', 'files', 'automations', 'connections', 'vault', 'memories', 'skills'])
      .optional()
      .describe('find: what kind of thing (messages: chats and their threads, the default)'),
    bring: z
      .array(z.string().min(4).max(120))
      .min(1)
      .max(20)
      .optional()
      .describe(
        'Ids from the last find’s items, once the person said which: asks them on a card, then brings them back',
      ),
  })
  .superRefine((i, ctx) => {
    if (!i.find && !i.bring) ctx.addIssue({ code: 'custom', message: 'Give find or bring.', path: ['find'] });
  });
export type BackupBringBackInput = z.input<typeof BackupBringBackInput>;

export const BackupBringBackOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('found'),
    /** Which backup was opened, as people say it (“yesterday at 06:00”). */
    backup: z.string(),
    items: z.array(
      z.object({
        /** For `bring`. */
        id: z.string(),
        title: z.string(),
        /** When it last changed, as people say it. */
        when: z.string().nullable(),
        /** Where it was (“In Chat · 4 replies”), or what it is. */
        about: z.string().nullable(),
        /** It is still here: nothing to bring back. */
        here: z.boolean().nullable(),
      }),
    ),
    /** What to tell the person, before asking which. */
    say: z.string(),
  }),
  /** The backup is still opening: call find again in a minute. */
  z.object({ status: z.literal('opening'), say: z.string() }),
  /** The person was asked on a card; their yes brings them back and you hear how it went. */
  z.object({ status: z.literal('pending_approval'), approvalId: z.string(), message: z.string() }),
  /** Brought back (the person had said yes already): tell them `say`. */
  z.object({ status: z.literal('done'), say: z.string() }),
  z.object({ status: z.literal('blocked'), message: z.string() }),
  z.object({ status: z.literal('failed'), reason: BackupBringBackFailure, message: z.string() }),
]);
export type BackupBringBackOutput = z.infer<typeof BackupBringBackOutput>;

export const BACKUP_MCP_TOOLS = {
  whombat_backup: {
    name: 'whombat_backup',
    title: 'This Whombat’s own backups',
    description:
      'This Whombat’s own backups (its chats, settings and connections), every 6 hours unless the person chose otherwise, the first one as soon as a place is set. Without set: whether it is backed up, where to, the copy somewhere else (offsite: a bucket the person owns, copied after each backup; only the person sets it up, in Settings → This Whombat → Backups), the places on the network that could keep them, and its SSH public key. With set (only while nothing backs it up or it backs up only to its own disk; any other move is the person’s, in Settings → This Whombat): place — a ready place from places: Whombat installs a small backup app there and points the backups at it, nothing else to do; a place that needs connecting or Manage first: tell the person that one thing. sftp — on a server you look after, make a user and folder for it and add the key to that user’s ~/.ssh/authorized_keys first (server_command), then call with host, user and path; on a NAS, ask the person to turn on SFTP and do the same there. disk — the disk labelled WHOMBAT-BACKUP plugged into this Whombat. Then tell the person `say` from the answer, in your words but no longer, without addresses, ports or paths.',
    input: WhombatBackupInput,
    output: WhombatBackupOutput,
    requiredKey: null,
    readOnly: false,
    personal: true,
  } satisfies McpTool<typeof WhombatBackupInput, typeof WhombatBackupOutput> & { personal: true },
  backup_bring_back: {
    name: 'backup_bring_back',
    title: 'Bring something back from a backup',
    description:
      'Gets back something the person lost or deleted — a chat, a file, an automation, a connection, a Vault entry — from this Whombat’s own backups. It only adds: nothing here is changed or overwritten. find: opens the newest backup from before `before` (the person’s time hint) and lists what matches the words, newest first; tell the person what you found in plain words and ask which (no ids). bring: the ids they chose; Whombat asks them on a card and brings them back on their yes, and you hear how it went. Opening a backup takes a moment: on `opening`, call find again in a minute.',
    input: BackupBringBackInput,
    output: BackupBringBackOutput,
    requiredKey: null,
    readOnly: false,
    personal: true,
  } satisfies McpTool<typeof BackupBringBackInput, typeof BackupBringBackOutput> & { personal: true },
} as const;
