/**
 * Backup places (Whombat backup-places.md): a NAS or server that keeps this Whombat's backups. Whombat installs a small
 * backup app on it (a restic REST server that only adds) and points the box's backups at it. Pure: the shapes the
 * session ops carry, the place ids, the order the Inbox proposes them in and the words people see.
 */
import { z } from 'zod';
import { type CoreMessageKey, coreTranslator } from '../i18n/catalog.js';
import type { MessageVars } from '../i18n/engine.js';
import { formatLocaleNumber } from '../i18n/format.js';

/** What runs the place: Whombat's agent on Unraid or another Linux server, or a NAS reached through its own API. */
export const BACKUP_PLACE_KINDS = ['unraid', 'linux', 'truenas', 'synology', 'qnap'] as const;
export const BackupPlaceKind = z.enum(BACKUP_PLACE_KINDS);
export type BackupPlaceKind = z.infer<typeof BackupPlaceKind>;

/**
 * - `in_use`: it keeps this Whombat's backups now;
 * - `ready`: Whombat can set it up now;
 * - `connect_first`: a NAS the network scan found that isn't connected yet;
 * - `manage_first`: connected or added with Look only;
 * - `unsupported`: it can't keep backups (`reason` says why).
 */
export const BACKUP_PLACE_STATES = [
  'in_use',
  'ready',
  'connect_first',
  'manage_first',
  'unsupported',
] as const;
export const BackupPlaceState = z.enum(BACKUP_PLACE_STATES);
export type BackupPlaceState = z.infer<typeof BackupPlaceState>;

/** What a place keeps for this Whombat. */
export const BackupPlaceKept = z.object({
  usedBytes: z.number().int().min(0).nullable(),
  freeBytes: z.number().int().min(0).nullable(),
  cleanup: z.object({
    /** The NAS clears backups older than `keepDays` once a week. */
    on: z.boolean(),
    keepDays: z.number().int().min(1).max(3650),
    lastAt: z.string().max(40).nullable(),
    ok: z.boolean().nullable(),
  }),
  /** Set up by hand (the person pasted the app): Whombat can't change it. */
  byHand: z.boolean(),
});
export type BackupPlaceKept = z.infer<typeof BackupPlaceKept>;

/**
 * Where on a place the backups are kept (backup-places.md BPL-13): an Unraid share, a TrueNAS pool, a Synology or QNAP
 * shared folder. One is `recommended` (a share or folder only Whombat uses); `note` says what to know about the others
 * in one plain sentence (“Shared on your network: anyone who can open it could delete the backups.”).
 */
export const BackupPlaceLocation = z.object({
  /** The driver's own id (`whombat-backups`, `tank`, `docker`). */
  id: z.string().min(1).max(200),
  /** As the NAS's own page calls it. */
  name: z.string().min(1).max(200),
  freeBytes: z.number().int().min(0).nullable(),
  /** Whombat makes it when it is chosen (a new share only it uses). */
  isNew: z.boolean(),
  recommended: z.boolean(),
  note: z.string().max(300).nullable(),
});
export type BackupPlaceLocation = z.infer<typeof BackupPlaceLocation>;

export const BackupPlace = z.object({
  /** `server:<serverId>`, `connection:<connectionId>` or `found:<host>`. */
  id: z.string().min(3).max(300),
  kind: BackupPlaceKind,
  /** As people call it: `BlackBox`. */
  name: z.string().min(1).max(200),
  address: z.string().max(253).nullable(),
  state: BackupPlaceState,
  /** One plain sentence for `connect_first`, `manage_first` and `unsupported`. */
  reason: z.string().max(500).nullable(),
  /** “Set it up by hand” is offered. */
  byHand: z.boolean(),
  /** What it keeps for this Whombat, once it does. */
  kept: BackupPlaceKept.nullable(),
  /** Where on it the backups can be kept; empty when there is no choice (the person isn't asked). */
  locations: z.array(BackupPlaceLocation).max(50).default([]),
  /** Where they are kept now (in use), else null. */
  location: z.string().max(200).nullable().default(null),
});
export type BackupPlace = z.infer<typeof BackupPlace>;

export type BackupPlaceRef =
  | { type: 'server'; id: string }
  | { type: 'connection'; id: string }
  | { type: 'found'; host: string };

export function backupPlaceId(ref: BackupPlaceRef): string {
  return ref.type === 'found' ? `found:${ref.host}` : `${ref.type}:${ref.id}`;
}

export function parseBackupPlaceId(id: string): BackupPlaceRef | null {
  const m = /^(server|connection|found):(.+)$/.exec(id);
  if (!m?.[2]) return null;
  if (m[1] === 'found') return { type: 'found', host: m[2] };
  return { type: m[1] as 'server' | 'connection', id: m[2] };
}

/**
 * A place as people read it when it has no name: the host and port of the address the backup service shows
 * (`rest:http://10.0.2.2:8747/rehearsal/` → `10.0.2.2:8747`), else what it shows; null when it shows nothing.
 */
export function placeOfDisplay(display: string | null | undefined): string | null {
  const shown = display?.trim();
  if (!shown) return null;
  // `scheme://[user@]host[:port]/…`, behind restic's own `rest:` / `s3:` / `sftp:` prefix.
  const host = /^(?:(?:rest|sftp|s3):)?[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#]+)/i.exec(shown)?.[1];
  return host || shown;
}

/** The place kind of a NAS connection's catalog id, or null when that catalog entry can't keep backups. */
export function placeKindOfCatalog(catalogId: string): BackupPlaceKind | null {
  return catalogId === 'truenas' || catalogId === 'synology' || catalogId === 'qnap' ? catalogId : null;
}

/** The place kind of a server Whombat's agent runs on. */
export function placeKindOfServer(platform: string | null | undefined): BackupPlaceKind {
  return platform === 'unraid' ? 'unraid' : 'linux';
}

/** A server named like it keeps files. */
const STORAGE_NAME = /nas|backup|storage|files?\b|data/i;
const NAS_KINDS: readonly BackupPlaceKind[] = ['unraid', 'truenas', 'synology', 'qnap'];

/**
 * The place the Inbox proposes (BPL-07): one that is ready — a NAS or a server named like storage first, then the
 * one with most free space — else a NAS the scan found that isn't connected yet; null when there is none (the
 * proposal then suggests a USB disk).
 */
export function bestBackupPlace(places: readonly BackupPlace[]): BackupPlace | null {
  const free = (p: BackupPlace) => p.kept?.freeBytes ?? 0;
  const ready = places.filter((p) => p.state === 'ready');
  const storage = ready.filter((p) => NAS_KINDS.includes(p.kind) || STORAGE_NAME.test(p.name));
  const pick = (list: BackupPlace[]) => [...list].sort((a, b) => free(b) - free(a))[0] ?? null;
  return pick(storage) ?? pick(ready) ?? places.find((p) => p.state === 'connect_first') ?? null;
}

/** How long the NAS keeps old backups (BPL-02). */
export const BACKUP_PLACE_KEEP_DAYS = 90;

const KIND_SAID: Record<BackupPlaceKind, string> = {
  unraid: 'Unraid',
  linux: 'Server',
  truenas: 'TrueNAS',
  synology: 'Synology',
  qnap: 'QNAP',
};

/** The words people see (web, phone, the assistant's proposal). */
export const BACKUP_PLACE_TEXT = {
  heading: 'On your network',
  kind: (k: BackupPlaceKind) => KIND_SAID[k],
  state: {
    in_use: 'Keeps your backups',
    ready: 'Ready',
    connect_first: 'Connect it first',
    manage_first: 'Turn on Manage first',
    unsupported: 'Can’t keep backups',
  } satisfies Record<BackupPlaceState, string>,
  use: 'Back up here',
  byHand: 'Set it up by hand',
  check: 'Check it',
  moveTitle: (name: string) => `Back up to ${name} instead?`,
  moveBody: (from: string) => `Backups made so far stay on ${from}. New backups go here from now on.`,
  appendOnly: 'Deleting is blocked',
  cleanup: (days: number) => `Backups older than ${days} days are cleared`,
  noCleanup: 'Old backups aren’t cleared on their own here',
  keptHere: 'Backups kept here',
  reasons: {
    connect: (said: string) => `Connect ${said} with Manage, then Whombat can keep its backups there.`,
    manage: 'Whombat can only look at it now. Turn on Manage so it can set up a place for backups.',
    noDocker: 'It needs Docker to keep backups, and Docker isn’t running there.',
    arrayStopped: 'Its array is stopped. Start it, then try again.',
    self: 'This Whombat runs on it, so its backups would be lost with it.',
    synologyOld: 'It needs DSM 7.2 or later with Container Manager. Update DSM, then try again.',
    synologyNoContainerManager:
      'Container Manager isn’t installed on it. Install it from Package Center, then try again.',
    trueNasOld: 'It needs TrueNAS 24.10 or later. Update TrueNAS, then try again.',
    trueNasNoPool: 'Apps aren’t set up on it yet. Choose a pool for apps in TrueNAS, then try again.',
    trueNasAppsStopped: 'Apps aren’t running on it. Start them in TrueNAS, then try again.',
    qnapNoContainerStation:
      'It needs Container Station 3. Install or update it from the App Center and open it once, then try again.',
    dockerDown: 'Docker is stopped there. Start it, then try again.',
    nfsOff: 'NFS is off on it. Turn it on in its settings, then try again.',
    helperOld: 'Whombat’s helper on it needs an update first.',
    notYet: 'Whombat can’t set it up on its own yet. You can set it up by hand.',
    other: 'It can’t keep backups right now.',
    noAddress: (place: string) => `${place} has no address on your home network that Whombat can use.`,
  },
  /** Why a place can't be used or removed now. */
  refused: {
    gone: 'That place isn’t on your network any more.',
    move: (from: string) =>
      `Backups go to ${from} now. Moving them is yours to decide, in Settings → This Whombat → Backups.`,
    inUse: (place: string) => `${place} keeps your backups now, so Whombat leaves it as it is.`,
    byHandOnly: 'Whombat can only set this place up by hand.',
    checkExpired: 'That setup is more than a day old. Set it up by hand again to get a new one.',
    /** The backup service didn't say where backups go: nothing that could delete or replace them is done. */
    unknown:
      'Whombat can’t tell where your backups go right now, so it leaves them as they are. Try again in a minute.',
  },
  ownDisk: (place: string) => `Your backups are on this Whombat’s own disk. Keep them on ${place} instead?`,
  /** What a failed step of setting a place up says (BPL-05): which step, in one sentence. */
  failed: {
    install: (place: string) => `Whombat couldn’t set up the backup app on ${place}.`,
    destination: (place: string) =>
      `The backup app on ${place} runs, but this Whombat couldn’t start backing up to it.`,
    cleanup: (place: string) => `Backups go to ${place} now, but clearing old ones there isn’t set up yet.`,
  },
  /** Where on a place the backups are kept (BPL-13). */
  location: {
    /** A location in a sentence (“the share whombat-backups”, “the pool tank”, “the shared folder docker”). */
    said: (kind: BackupPlaceKind, name: string) =>
      kind === 'truenas'
        ? `the pool ${name}`
        : kind === 'synology' || kind === 'qnap'
          ? `the shared folder ${name}`
          : `the share ${name}`,
    shared: 'Shared on your network: anyone who can open it could delete the backups.',
    holdsOther: 'Unraid keeps other things in it (apps, virtual machines or disk images).',
    onPool: (pool: string) => `Kept on the ${pool} pool, not on the array.`,
    gone: 'That place on it isn’t there any more. Choose another.',
    /** A NAS can't move backups (BPL-14): a new location starts new ones. */
    newBackups: (from: string) => `Backups made so far stay in ${from}; new ones start in the new place.`,
  },
  /** What Whombat tells the person once a place keeps its backups (BPL-16). */
  setSay: (place: string, where: string | null, running: boolean) =>
    `This Whombat now backs up to ${place}${where ? `, in ${where}` : ''}. ${
      running ? 'The first backup is running now.' : 'The first backup starts within the next 15 minutes.'
    }`,
  /** The two lines Whombat can watch about a place (both off at the start). */
  watch: {
    cleanupName: 'Old backups not being cleared',
    cleanupTitle: (place: string) => `Old backups aren’t being cleared on ${place}`,
    cleanupDetail: 'Whombat can set the clearing up again.',
    spaceName: 'Room for backups running low',
    spaceTitle: (place: string) => `${place} is running out of space for backups`,
    spaceDetail: (freeGb: number) => `${freeGb} GB left.`,
  },
} as const;

/** `BACKUP_PLACE_TEXT`'s shape with plain strings, as `backupPlaceText` gives it in any locale. */
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Widen<R>
    : { readonly [K in keyof T]: Widen<T[K]> };
export type BackupPlaceWords = Widen<typeof BACKUP_PLACE_TEXT>;

/** `BACKUP_PLACE_TEXT` in a locale: the words people see, in their language (English when none is given). */
export function backupPlaceText(locale?: string | null): BackupPlaceWords {
  const tr = coreTranslator(locale);
  const t = (key: string, vars?: MessageVars) => tr.t(`backupPlace.${key}` as CoreMessageKey, vars);
  const english = tr.language === 'en';
  return {
    heading: t('heading'),
    kind: (k: BackupPlaceKind) => t(`kind.${k}`),
    state: {
      in_use: t('state.in_use'),
      ready: t('state.ready'),
      connect_first: t('state.connect_first'),
      manage_first: t('state.manage_first'),
      unsupported: t('state.unsupported'),
    },
    use: t('use'),
    byHand: t('byHand'),
    check: t('check'),
    moveTitle: (name: string) => t('moveTitle', { name }),
    moveBody: (from: string) => t('moveBody', { from }),
    appendOnly: t('appendOnly'),
    cleanup: (days: number) => t('cleanup', { days }),
    noCleanup: t('noCleanup'),
    keptHere: t('keptHere'),
    reasons: {
      connect: (said: string) => t('reasons.connect', { said }),
      manage: t('reasons.manage'),
      noDocker: t('reasons.noDocker'),
      arrayStopped: t('reasons.arrayStopped'),
      self: t('reasons.self'),
      synologyOld: t('reasons.synologyOld'),
      synologyNoContainerManager: t('reasons.synologyNoContainerManager'),
      trueNasOld: t('reasons.trueNasOld'),
      trueNasNoPool: t('reasons.trueNasNoPool'),
      trueNasAppsStopped: t('reasons.trueNasAppsStopped'),
      qnapNoContainerStation: t('reasons.qnapNoContainerStation'),
      dockerDown: t('reasons.dockerDown'),
      nfsOff: t('reasons.nfsOff'),
      helperOld: t('reasons.helperOld'),
      notYet: t('reasons.notYet'),
      other: t('reasons.other'),
      noAddress: (place: string) => t('reasons.noAddress', { place }),
    },
    refused: {
      gone: t('refused.gone'),
      move: (from: string) => t('refused.move', { from }),
      inUse: (place: string) => t('refused.inUse', { place }),
      byHandOnly: t('refused.byHandOnly'),
      checkExpired: t('refused.checkExpired'),
      unknown: t('refused.unknown'),
    },
    ownDisk: (place: string) => t('ownDisk', { place }),
    failed: {
      install: (place: string) => t('failed.install', { place }),
      destination: (place: string) => t('failed.destination', { place }),
      cleanup: (place: string) => t('failed.cleanup', { place }),
    },
    location: {
      said: (kind: BackupPlaceKind, name: string) =>
        t(
          kind === 'truenas'
            ? 'location.pool'
            : kind === 'synology' || kind === 'qnap'
              ? 'location.sharedFolder'
              : 'location.share',
          { name },
        ),
      shared: t('location.shared'),
      holdsOther: t('location.holdsOther'),
      onPool: (pool: string) => t('location.onPool', { pool }),
      gone: t('location.gone'),
      newBackups: (from: string) => t('location.newBackups', { from }),
    },
    setSay: (place: string, where: string | null, running: boolean) =>
      t('setSay', {
        place,
        where: where ? t('setSay.where', { where }) : '',
        first: t(running ? 'setSay.running' : 'setSay.soon'),
      }),
    watch: {
      cleanupName: t('watch.cleanupName'),
      cleanupTitle: (place: string) => t('watch.cleanupTitle', { place }),
      cleanupDetail: t('watch.cleanupDetail'),
      spaceName: t('watch.spaceName'),
      spaceTitle: (place: string) => t('watch.spaceTitle', { place }),
      // English says the number as it is; other languages with their own decimal separator.
      spaceDetail: (freeGb: number) =>
        t('watch.spaceDetail', { freeGb: english ? String(freeGb) : formatLocaleNumber(freeGb, locale) }),
    },
  };
}

/**
 * The client name a Whombat's backups go under on a place (BPL-01): `whombat-<name>-<id>`, lowercase letters, digits
 * and dashes, 3 to 63 characters, from the Whombat's name and a short id of the box.
 */
export function backupPlaceClient(whombatName: string, shortId: string): string {
  const slug = (text: string, max: number) =>
    text
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '');
  const id = slug(shortId, 16) || 'box';
  const name = slug(whombatName, 62 - 'whombat--'.length - id.length);
  return name ? `whombat-${name}-${id}` : `whombat-${id}`;
}
