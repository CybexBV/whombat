/**
 * What's protected (Whombat docs/decisions/backup-trust.md): every thing that holds data — this Whombat, each server,
 * each Proxmox, Incus and QEMU/KVM machine, and the connections that keep data — in three plain groups: copied to
 * another machine, only on the same machine, and not backed up that Whombat can see. “Nothing backs it up” is said only
 * where Whombat sees that nothing does; where it simply can't read the backups it says so.
 *
 * Restore tests of Proxmox machines: once a week in the quiet hours Whombat restores the newest backup of one chosen
 * machine as a temporary copy with its network cables pulled, starts it, waits until it runs (and, with the guest agent,
 * until it booted), then stops and deletes it. The result is a fact on the machine's page and its row here.
 *
 * Pure: the shapes and the words the apps, the server and the assistant share.
 */
import { z } from 'zod';
import { coreTranslator } from '../i18n/catalog.js';
import { daysAgo, formatAgo, formatDate, formatWeekday } from '../text/time.js';
import { Timestamp } from './common.js';

const Id = z.string().min(1).max(200);
const Name = z.string().min(1).max(160);

/* Groups and states ------------------------------------------------------------------------------------------- */

/**
 * Where a thing's data is kept: `copied` a copy is on another machine or place, `local` a copy is only on the machine
 * itself (its own disks), `none` Whombat sees that nothing backs it up, `unseen` Whombat can't see whether anything
 * does (it reads no backup facts for it).
 */
export const PROTECTED_STATES = ['copied', 'local', 'none', 'unseen'] as const;
export const ProtectedState = z.enum(PROTECTED_STATES);
export type ProtectedState = z.infer<typeof ProtectedState>;

/** The page's three groups, in order; `none` holds both what nothing backs up and what Whombat can't see. */
export const PROTECTED_GROUPS = ['copied', 'local', 'none'] as const;
export type ProtectedGroup = (typeof PROTECTED_GROUPS)[number];

/** The group a state is shown in. */
export function protectedGroupOf(state: ProtectedState): ProtectedGroup {
  return state === 'unseen' ? 'none' : state;
}

/** What a row is: this Whombat, a server, a machine on a server, or a connected service. */
export const ProtectedKind = z.enum(['whombat', 'server', 'vm', 'container', 'service']);
export type ProtectedKind = z.infer<typeof ProtectedKind>;

/* Restore tests ----------------------------------------------------------------------------------------------- */

export const RestoreTestOutcome = z.enum(['worked', 'failed', 'skipped']);
export type RestoreTestOutcome = z.infer<typeof RestoreTestOutcome>;

/**
 * Why a test failed or couldn't run. Failed: the restore itself failed, the copy didn't start, it stopped by itself,
 * it started but never finished booting (its guest agent never answered), or it took too long. Skipped (nothing is
 * wrong with the backup): no backup to test, not enough free space or memory, it uses parts of the server itself (a passed-through
 * device, a host folder, a hook script), Proxmox wouldn't disconnect its network, Manage is off, the server isn't
 * reachable, the machine is on another node, a guest id for the copy wasn't free, Proxmox refused something else, or
 * Whombat couldn't prove the machine at the copy's number was its copy (then it left that machine alone).
 */
export const RESTORE_TEST_REASONS = [
  'restore_failed',
  'start_failed',
  'stopped_by_itself',
  'no_boot',
  'too_long',
  'no_backup',
  'no_space',
  'no_memory',
  'host_parts',
  'network_kept',
  'manage_off',
  'unreachable',
  'other_node',
  'no_id',
  'refused',
  'not_ours',
] as const;
export const RestoreTestReason = z.enum(RESTORE_TEST_REASONS);
export type RestoreTestReason = z.infer<typeof RestoreTestReason>;

/** The reasons that mean the backup didn't come back: they raise a problem; the others only say why no test ran. */
export const RESTORE_TEST_FAILURES: ReadonlySet<RestoreTestReason> = new Set([
  'restore_failed',
  'start_failed',
  'stopped_by_itself',
  'no_boot',
  'too_long',
]);

/** One finished restore test of a machine. */
export const RestoreTestResult = z.object({
  serverId: Id,
  /** The hosts service's guest id (`pve:101`). */
  guestId: Id,
  guestName: z.string().max(160),
  /** When it ended. */
  at: Timestamp,
  outcome: RestoreTestOutcome,
  reason: RestoreTestReason.optional(),
  /** How long the restore, the start and the clean-up took, in seconds. */
  durationS: z.number().int().min(0).max(86_400).optional(),
  /** The guest agent answered inside the copy: it booted, not only started. */
  booted: z.boolean().optional(),
  /** When the backup it restored was made. */
  backupAt: Timestamp.nullable().optional(),
});
export type RestoreTestResult = z.infer<typeof RestoreTestResult>;

/** A test going on now. */
export const RestoreTestRunning = z.object({
  guestId: Id,
  guestName: z.string().max(160),
  startedAt: Timestamp,
});
export type RestoreTestRunning = z.infer<typeof RestoreTestRunning>;

/** Why a server's tests can't run now (the switch says so beside it). */
export const RestoreTestBlock = z.enum(['manage_off', 'offline', 'no_guests']);
export type RestoreTestBlock = z.infer<typeof RestoreTestBlock>;

/** Restore tests on one Proxmox server: whether they are on, which machines, the last result and the one running. */
export const RestoreTestServer = z.object({
  serverId: Id,
  serverName: Name,
  on: z.boolean(),
  /** The machines chosen; empty is every machine that can be tested. */
  guests: z.array(Id).max(200),
  /** The machines that can be tested (Proxmox VMs and containers, no templates or temporary machines). */
  eligible: z
    .array(z.object({ id: Id, name: z.string().max(160), kind: z.enum(['vm', 'container']) }))
    .max(200),
  /** Why tests can't run now; absent when they can. */
  blocked: RestoreTestBlock.optional(),
  last: RestoreTestResult.nullable(),
  running: RestoreTestRunning.nullable(),
  /** When the next test starts (the next quiet hours of its week); null when off. */
  next: Timestamp.nullable(),
});
export type RestoreTestServer = z.infer<typeof RestoreTestServer>;

/* Rows ------------------------------------------------------------------------------------------------------ */

/** One thing that holds data, and where its data is kept. */
export const ProtectedRow = z.object({
  /** Stable: `whombat`, `server:pve-01`, `guest:pve-01:pve:101`, `connection:con_…`. */
  key: z.string().min(1).max(300),
  kind: ProtectedKind,
  name: Name,
  /** The connection's kind (`homeassistant`), for its logo. */
  catalogId: z.string().max(80).optional(),
  /** The server a machine is on (“pve-01”). */
  on: z.string().max(160).optional(),
  /** Its page (`/things/server%3Apve-01?guest=pve%3A101`); null when it has none. */
  href: z.string().max(500).nullable(),
  state: ProtectedState,
  /** The newest backup or copy Whombat knows of. */
  lastAt: Timestamp.nullable(),
  /** Where that copy is, in words (“pbs-01”, “Home Assistant Cloud”, “nas-01”); null when unknown. */
  where: z.string().max(160).nullable(),
  /** The last attempt failed (when); `lastAt` is then the newest that worked. */
  failedAt: Timestamp.nullable().optional(),
  /** Its facts are the machine's it runs on (“pve-02 · CT 131”): a service without backup facts of its own. */
  via: z.string().max(160).nullable().optional(),
  /**
   * A second copy somewhere else (this Whombat's off-site copy): the storage's name, the last copy the bucket's own list
   * confirmed (null: none yet), and when copying there last failed while it is failing.
   */
  offsite: z
    .object({ name: z.string().max(160), lastAt: Timestamp.nullable(), failedAt: Timestamp.optional() })
    .nullable()
    .optional(),
  /** The newest restore test of this machine. */
  restoreTest: RestoreTestResult.nullable().optional(),
  /** The server and machine, for a machine's row (restore tests, asking about it). */
  serverId: Id.optional(),
  guestId: Id.optional(),
});
export type ProtectedRow = z.infer<typeof ProtectedRow>;

/** `protected.get`: every row, the restore tests, and what couldn't be read this time. */
export const ProtectedView = z.object({
  rows: z.array(ProtectedRow).max(1000),
  restoreTests: z.array(RestoreTestServer).max(100),
  /** Things Whombat couldn't read just now (a server offline, a connection not answering), by name. */
  unread: z.array(z.string().max(160)).max(100),
  at: Timestamp,
});
export type ProtectedView = z.infer<typeof ProtectedView>;

/* Restore test copies ----------------------------------------------------------------------------------------- */

/** The guest ids restore test copies use: a range nobody picks, so a copy left by a crash is found and removed. */
export const RESTORE_TEST_FIRST_ID = 990_000;
export const RESTORE_TEST_LAST_ID = 990_999;
/** The Proxmox tag every copy carries. */
export const RESTORE_TEST_TAG = 'whombat-restore-test';

/** Whether a Proxmox guest id (`101`, `pve:990003`) is in the restore tests' range. */
export function isRestoreTestId(id: string | number): boolean {
  const n = typeof id === 'number' ? id : Number(String(id).replace(/^pve:/, ''));
  return Number.isInteger(n) && n >= RESTORE_TEST_FIRST_ID && n <= RESTORE_TEST_LAST_ID;
}

/** The name a copy gets (`whombat-test-of-plex`): plain, a DNS name Proxmox takes, saying what it is. */
export function restoreTestName(guestName: string): string {
  const plain = guestName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `whombat-test-of-${plain || 'machine'}`;
}

/** Whether a guest is a restore test copy: in the range and named or tagged as one. */
export function isRestoreTestCopy(g: { id: string; name: string; tags?: readonly string[] | null }): boolean {
  if (!isRestoreTestId(g.id)) return false;
  return g.name.startsWith('whombat-test-of-') || !!g.tags?.includes(RESTORE_TEST_TAG);
}

/* Words ------------------------------------------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

/** A group's title and what it means. */
export function protectedGroupWords(
  group: ProtectedGroup,
  locale?: string | null,
): { title: string; note: string } {
  const tr = coreTranslator(locale);
  return {
    title: tr.t(`protected.group.${group}`),
    note: tr.t(`protected.groupNote.${group}`),
  };
}

/** “today”, “yesterday” or “tomorrow”, “on Sunday” (within a week either way), else “on 3 Nov”. */
export function restoreTestWhen(at: string, now: Date, timeZone: string, locale?: string | null): string {
  const tr = coreTranslator(locale);
  const diff = daysAgo(at, now, timeZone);
  if (diff === 0) return tr.t('time.todayLower');
  if (diff === 1) return tr.t('time.yesterdayLower');
  if (diff === -1) return tr.t('time.tomorrowLower');
  if (Math.abs(diff) < 7) return tr.t('protected.when.on', { day: formatWeekday(at, timeZone, locale) });
  return tr.t('protected.when.on', { day: formatDate(at, timeZone, { now }, locale) });
}

/** Why a test failed or couldn't run, in words (“there wasn’t enough free space”). */
export function restoreTestReasonWords(reason: RestoreTestReason, locale?: string | null): string {
  return coreTranslator(locale).t(`protected.reason.${reason}`);
}

/** A restore test's verdict: “worked on Sunday (took 4 min)”, “didn’t work on Sunday: the copy didn’t start”. */
export function restoreTestVerdict(
  result: Pick<RestoreTestResult, 'at' | 'outcome' | 'reason' | 'durationS' | 'booted'>,
  now: Date,
  timeZone: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const when = restoreTestWhen(result.at, now, timeZone, locale);
  if (result.outcome === 'worked') {
    const minutes = Math.max(1, Math.round((result.durationS ?? 60) / 60));
    return tr.tp(result.booted === false ? 'protected.test.started' : 'protected.test.worked', minutes, {
      when,
    });
  }
  if (result.outcome === 'failed')
    return tr.t('protected.test.failed', {
      when,
      why: restoreTestReasonWords(result.reason ?? 'start_failed', locale),
    });
  return tr.t('protected.test.skipped', {
    when,
    why: restoreTestReasonWords(result.reason ?? 'refused', locale),
  });
}

/** “Restore test”, a fact's name on a machine's page. */
export function restoreTestLabel(locale?: string | null): string {
  return coreTranslator(locale).t('protected.test.label');
}

/**
 * A restore test as one line: “Restore test: worked on Sunday (took 4 min)”, “Restore test: didn’t work on Sunday: the
 * copy didn’t start”, “Restore test: couldn’t run on Sunday: there wasn’t enough free space”.
 */
export function restoreTestLine(
  result: Pick<RestoreTestResult, 'at' | 'outcome' | 'reason' | 'durationS' | 'booted'>,
  now: Date,
  timeZone: string,
  locale?: string | null,
): string {
  return coreTranslator(locale).t('protected.test.line', {
    verdict: restoreTestVerdict(result, now, timeZone, locale),
  });
}

/** The problem a failed test opens: “The backup of plex didn’t start when Whombat tried it”. */
export function restoreTestProblem(
  guestName: string,
  reason: RestoreTestReason | undefined,
  locale?: string | null,
): { title: string; detail: string } {
  const tr = coreTranslator(locale);
  return {
    title: tr.t(
      reason === 'restore_failed' ? 'protected.problem.restoreTitle' : 'protected.problem.startTitle',
      { name: guestName },
    ),
    detail: tr.t('protected.problem.detail', {
      why: restoreTestReasonWords(reason ?? 'start_failed', locale),
    }),
  };
}

/**
 * A row's line: “Last copy 3 hours ago · on pbs-01”, “Last backup 2 days ago · on its own disks”, “Last backup failed
 * 1 day ago · the one before is from 3 days ago”, “Nothing backs it up”, “Whombat can’t see its backups”; with the
 * machine it runs on first for a service (“With pve-02 · CT 131 · …”).
 */
export function protectedRowLine(
  row: Pick<ProtectedRow, 'state' | 'lastAt' | 'where' | 'failedAt' | 'via' | 'kind'>,
  now: Date,
  timeZone: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const ago = (at: string) => formatAgo(at, now, timeZone, locale);
  const parts: string[] = [];
  if (row.via) parts.push(tr.t('protected.line.via', { machine: row.via }));
  if (row.failedAt) {
    parts.push(tr.t('protected.line.failed', { ago: ago(row.failedAt) }));
    if (row.lastAt) parts.push(tr.t('protected.line.before', { ago: ago(row.lastAt) }));
    else parts.push(tr.t('protected.line.noneWorked'));
    return parts.join(' · ');
  }
  switch (row.state) {
    case 'copied':
    case 'local': {
      const key = row.state === 'copied' ? 'protected.line.copy' : 'protected.line.backup';
      parts.push(row.lastAt ? tr.t(key, { ago: ago(row.lastAt) }) : tr.t('protected.line.planned'));
      if (row.where) parts.push(tr.t('protected.line.where', { where: row.where }));
      else if (row.state === 'local') parts.push(tr.t('protected.line.ownDisks'));
      break;
    }
    case 'none':
      parts.push(tr.t('protected.line.nothing'));
      break;
    case 'unseen':
      parts.push(tr.t(row.kind === 'server' ? 'protected.line.unseenServer' : 'protected.line.unseen'));
      break;
  }
  return parts.join(' · ');
}

/** A row's copy is old for a backup that runs at least daily: over a week (amber on the page). */
export function protectedRowOld(row: Pick<ProtectedRow, 'lastAt' | 'state'>, now: Date): boolean {
  return (
    (row.state === 'copied' || row.state === 'local') &&
    !!row.lastAt &&
    now.getTime() - Date.parse(row.lastAt) > 8 * DAY_MS
  );
}

/**
 * The off-site line on this Whombat's row: “Off-site (Backblaze B2) · last copy 03:10 today”, or that copying there
 * failed (amber on the page).
 */
export function protectedOffsiteLine(
  offsite: NonNullable<ProtectedRow['offsite']>,
  now: Date,
  timeZone: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  if (offsite.failedAt)
    return tr.t('protected.line.offsiteFailed', {
      name: offsite.name,
      ago: formatAgo(offsite.failedAt, now, timeZone, locale),
    });
  return offsite.lastAt
    ? tr.t('protected.line.offsite', {
        name: offsite.name,
        ago: formatAgo(offsite.lastAt, now, timeZone, locale),
      })
    : tr.t('protected.line.offsiteNone', { name: offsite.name });
}

/**
 * The question “Ask {assistant} to set up backups” starts with, in the thing's own thread: what it is and what Whombat
 * sees, so the assistant reads its backups and proposes them with the care plans and backup places it has.
 */
export function protectedAskText(
  row: Pick<ProtectedRow, 'name' | 'state' | 'kind' | 'on'>,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const name = row.on ? tr.t('protected.ask.on', { name: row.name, on: row.on }) : row.name;
  return tr.t(row.state === 'local' ? 'protected.ask.local' : 'protected.ask.none', { name });
}

/** The page's title and the words around it. */
export function protectedPageWords(locale?: string | null) {
  const tr = coreTranslator(locale);
  return {
    title: tr.t('protected.title'),
    intro: tr.t('protected.intro'),
    ask: (assistant: string) => tr.t('protected.askButton', { assistant }),
    empty: tr.t('protected.empty'),
    loading: tr.t('protected.loading'),
    loadFailed: tr.t('protected.loadFailed'),
    failed: tr.t('protected.failed'),
    unread: (names: string) => tr.t('protected.unread', { names }),
    tests: tr.t('protected.tests.title'),
    testsIntro: tr.t('protected.tests.intro'),
    testsSwitch: tr.t('protected.tests.switch'),
    testsAll: tr.t('protected.tests.all'),
    testsSome: (count: number) => tr.tp('protected.tests.some', count),
    testsChoose: tr.t('protected.tests.choose'),
    testsRun: tr.t('protected.tests.run'),
    testsRunning: (name: string) => tr.t('protected.tests.running', { name }),
    testsNext: (when: string) => tr.t('protected.tests.next', { when }),
    testsNone: tr.t('protected.tests.none'),
    blocked: (why: RestoreTestBlock) => tr.t(`protected.tests.blocked.${why}`),
    link: tr.t('protected.link'),
    linkHint: tr.t('protected.linkHint'),
    counts: (copied: number, local: number, none: number) =>
      [
        copied ? tr.tp('protected.count.copied', copied) : null,
        local ? tr.tp('protected.count.local', local) : null,
        none ? tr.tp('protected.count.none', none) : null,
      ]
        .filter(Boolean)
        .join(' · '),
  };
}

/** The rows of a group, in the page's order: the worst first within it (failed, then oldest), then by name. */
export function protectedRowsOf(rows: readonly ProtectedRow[], group: ProtectedGroup): ProtectedRow[] {
  const rank = (r: ProtectedRow) => (r.failedAt ? 0 : r.kind === 'whombat' ? 1 : 2);
  return rows
    .filter((r) => protectedGroupOf(r.state) === group)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * The thread *Ask {assistant} to set up backups* goes into: the server's (for a server or one of its machines) or the
 * connection's, so the question lands where that thing is talked about; null for this Whombat (the person's chat).
 */
export function protectedAskSubject(
  row: Pick<ProtectedRow, 'key' | 'kind' | 'name' | 'serverId' | 'on'>,
): { kind: 'server' | 'connection'; id: string; name: string } | null {
  if (row.kind === 'service') {
    const id = row.key.startsWith('connection:') ? row.key.slice('connection:'.length) : '';
    return id ? { kind: 'connection', id, name: row.name.slice(0, 120) } : null;
  }
  if (row.kind === 'whombat' || !row.serverId) return null;
  return {
    kind: 'server',
    id: row.serverId,
    name: (row.kind === 'server' ? row.name : (row.on ?? row.serverId)).slice(0, 120),
  };
}
