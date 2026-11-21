/**
 * Setting up a backup destination (AP-260, updates.md UP-F1; contracts 0.22 CT-142): the kinds the person chooses from,
 * the fields each needs, the restic repository they make and the words of the “Protect your Whombat” step. Pure and
 * shared by the web and the phone; the secrets typed here only ever travel in the `secret` op
 * `backup.configureDestination` (no digest in its receipt) and are never shown again.
 *
 * - an S3-compatible bucket: `s3:<endpoint>/<bucket>[/<folder>]` with an access key, a secret key and a region;
 * - an SFTP server or NAS: `sftp:<host>:<path>` (`sftp://<host>:<port>/<path>` with a port) and a user; the box's own
 *   key (`backup.sshPublicKey`) goes into the server's `authorized_keys`, and the server's host key is pinned (pasted,
 *   or trusted on first use and shown to compare);
 * - a restic REST server: the repository as typed, with an optional user and password;
 * - a disk labelled `WHOMBAT-BACKUP` attached to the box: `disk:`.
 *
 * Runtimes before contracts 0.22 (without the `backup.destinations` feature) take the REST server only.
 */
import { type BackupDestinationInput, OperationError } from '../session/managed-ops';
import { claimStepKicker } from './claim-steps';
import { ACCOUNTS_TEXT } from './status-copy';

export type BackupKind = 's3' | 'sftp' | 'rest' | 'disk';

/** Every kind, in the order the step offers them. */
export const BACKUP_KINDS: readonly BackupKind[] = ['s3', 'sftp', 'rest', 'disk'];

/**
 * The claim's backup step offers what is there first (Whombat first-day.md): a NAS the network scan found (the assistant
 * sets it up with the person once the AI is connected: its proposal in Needs you names the same place), then a USB disk
 * in one tap; a bucket, SFTP and a restic REST server stay under “Other places”.
 */
export const PROTECT_OTHER_KINDS: readonly BackupKind[] = ['s3', 'sftp', 'rest'];

/**
 * NAS boxes the scan finds, in the order the assistant proposes them (the scan's own order, desk-found.md DF-03); the
 * scan's answer is by address, so the first of an entry is its lowest address, as the proposal's.
 */
const NAS_IDS = ['unraid', 'truenas', 'synology', 'qnap'];
const NAS_SAID: Record<string, string> = {
  synology: 'The Synology NAS',
  qnap: 'The QNAP NAS',
  truenas: 'The TrueNAS server',
  unraid: 'The Unraid server',
};

/** A NAS the scan found that isn't hidden or added as a server: what the step offers first, or null. */
export function protectFoundPlace(
  found: readonly { catalogId: string; host: string; hidden?: boolean; serverIds?: readonly string[] }[],
): { title: string; host: string } | null {
  for (const id of NAS_IDS) {
    const f = found.find((x) => x.catalogId === id && !x.hidden && !x.serverIds?.length);
    if (f) return { title: `${NAS_SAID[id]} at ${f.host}`, host: f.host };
  }
  return null;
}

export interface BackupForm {
  kind: BackupKind;
  s3Endpoint: string;
  s3Bucket: string;
  s3Folder: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3Region: string;
  sftpHost: string;
  sftpPort: string;
  sftpPath: string;
  sftpUser: string;
  sftpHostKey: string;
  restRepository: string;
  restUser: string;
  restPassword: string;
  /** Joining the backups of a Whombat this one replaces: the repository password from its recovery kit. */
  adoptPassword: string;
}

export function emptyBackupForm(kind: BackupKind = 's3'): BackupForm {
  return {
    kind,
    s3Endpoint: '',
    s3Bucket: '',
    s3Folder: '',
    s3AccessKeyId: '',
    s3SecretAccessKey: '',
    s3Region: '',
    sftpHost: '',
    sftpPort: '',
    sftpPath: '',
    sftpUser: '',
    sftpHostKey: '',
    restRepository: '',
    restUser: '',
    restPassword: '',
    adoptPassword: '',
  };
}

export const BACKUP_SETUP_TEXT = {
  kicker: claimStepKicker('protect'),
  title: 'Protect your Whombat',
  sub: 'Choose where its backups go. If this Whombat ever breaks, your passkey brings everything back from there.',
  tip: 'Backups are encrypted on your Whombat before they leave it. Whoever runs the place they go to can’t read them.',
  settingsLabel: 'Protect your Whombat',
  settingsMeta: 'Choose where backups go. Until then nothing is backed up.',
  kinds: {
    s3: {
      title: 'A storage bucket',
      meta: 'Amazon S3, Backblaze B2, Wasabi, MinIO or any S3-compatible service.',
    },
    sftp: { title: 'A NAS or server (SFTP)', meta: 'Any computer or NAS you can reach over SSH.' },
    rest: {
      title: 'A restic REST server',
      meta: 'A backup server running restic’s REST server, ideally append-only.',
    },
    disk: {
      title: 'A disk on this Whombat',
      meta: 'A disk labelled WHOMBAT-BACKUP, attached to its machine.',
    },
  } satisfies Record<BackupKind, { title: string; meta: string }>,
  kindLegend: 'Where backups go',
  s3Endpoint: 'Endpoint',
  s3EndpointPlaceholder: 'https://s3.eu-central-1.amazonaws.com',
  s3Bucket: 'Bucket',
  s3Folder: 'Folder (optional)',
  s3AccessKeyId: 'Access key',
  s3SecretAccessKey: 'Secret key',
  s3Region: 'Region (optional)',
  s3Hint:
    'Use a key that can only reach this bucket. Turn on versioning or object lock so old backups can’t be deleted.',
  sftpHost: 'Server',
  sftpHostPlaceholder: 'nas.example.com',
  sftpPort: 'Port (optional)',
  sftpPath: 'Folder on the server',
  sftpPathPlaceholder: '/srv/whombat-backups',
  sftpUser: 'User',
  sftpKeyLabel: 'THIS WHOMBAT’S KEY',
  sftpKeyHelp:
    'First add this line to ~/.ssh/authorized_keys of the user Whombat signs in as on the server. Then fill in the server below and save: Whombat checks it can sign in.',
  sftpKeyFingerprint: (fp: string) => `Fingerprint ${fp}`,
  sftpKeyLoading: 'Getting this Whombat’s key…',
  sftpKeyFailed: 'Couldn’t get this Whombat’s key.',
  copyKey: 'Copy the key',
  shareKey: 'Share the key',
  keyCopied: 'Key copied.',
  sftpHostKey: 'Server’s host key (optional)',
  sftpHostKeyHint:
    'Paste the server’s host key line (ssh-ed25519 AAAA…) to pin it. Without it, Whombat trusts the key it first sees and shows you its fingerprint to compare.',
  hostKeyPinned: (fp: string) =>
    `Compare this with your server’s host key fingerprint: ${fp}. If it differs, set it up again.`,
  restRepository: 'Server address',
  restRepositoryPlaceholder: 'rest:https://backup.example.com/whombat/',
  restHint:
    'A restic REST server address, like rest:https://backup.example.com/whombat/ — no password in it.',
  restUser: 'User (optional)',
  restPassword: 'Password (optional)',
  diskHelp:
    'Attach a disk labelled WHOMBAT-BACKUP to this Whombat’s machine (for a virtual machine: add a disk with that label). An empty disk is prepared the first time.',
  adopt: 'Joining the backups of a Whombat you had? The key from its paper copy',
  save: 'Save and check',
  saving: 'Checking…',
  skip: 'Skip for now',
  /** What is there, first (first-day.md). */
  places: {
    diskTitle: 'A USB disk',
    diskMeta:
      'Name a USB disk WHOMBAT-BACKUP and plug it into your Whombat. An empty disk is prepared the first time.',
    useDisk: 'Use the disk',
    usingDisk: 'Preparing the disk…',
    foundMeta: 'Found on your network',
    foundBody: (assistant: string) =>
      `${assistant} sets it up once your AI is connected and tells you when the first backup is done.`,
    /** After “Let {assistant} set it up”: the yes is kept. */
    letAssistantSaid: (assistant: string) => `${assistant} sets it up once your AI is connected.`,
    letAssistant: (assistant: string) => `Let ${assistant} set it up`.slice(0, 60),
    other: 'Other places',
    otherMeta: 'A storage bucket, a server over SFTP or a restic REST server.',
    later: (assistant: string) =>
      `Or skip: ${assistant} suggests a place once it has looked around your network.`,
  },
  skipped: 'You can set up backups later in Settings → This Whombat.',
  /** On into the Whombat: the claim has no kit step any more (BX-01, AP-3507). */
  continue: 'Continue',
  onlyRest: 'Update your Whombat to back up to a bucket, a NAS or a disk.',
  saved: 'Backups are set up.',
  errors: {
    s3Endpoint: 'Enter the service’s address, like https://s3.eu-central-1.amazonaws.com.',
    s3Bucket: 'Enter the bucket’s name.',
    s3Keys: 'Enter the access key and the secret key.',
    sftpHost: 'Enter the server’s name or address.',
    sftpPort: 'The port is a number, like 22.',
    sftpPath: 'Enter the folder as a full path, like /srv/whombat-backups.',
    sftpUser: 'Enter the user Whombat signs in as.',
    sftpHostKey: 'That isn’t a host key line. It looks like ssh-ed25519 AAAA…',
    restRepository: 'Enter the address, starting with rest:https://',
    credentials: 'Leave passwords out of the address; use the fields below it.',
  },
} as const;

type Check =
  | { ok: true; input: BackupDestinationInput }
  | { ok: false; field: keyof BackupForm; error: string };

const HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])$/;
const BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/;
const HOST_KEY =
  /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]{16,}(?: .*)?$/;
const E = BACKUP_SETUP_TEXT.errors;

/** `https://host[:port][/path]` from what was typed (a bare host gets `https://`), or null. */
function endpointOf(value: string): string | null {
  const v = value.trim().replace(/\/+$/, '');
  if (!v) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || !u.hostname)
      return null;
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

const trimSlashes = (v: string) => v.trim().replace(/^\/+|\/+$/g, '');

/**
 * The `backup.configureDestination` input for a form, or the first field that isn't right (with its words). A new
 * repository is created (`allowInit`) unless the person joins one with its password (`adoptPassword`).
 */
export function destinationInput(form: BackupForm): Check {
  const join = form.adoptPassword ? { adoptPassword: form.adoptPassword } : { allowInit: true };
  switch (form.kind) {
    case 's3': {
      const endpoint = endpointOf(form.s3Endpoint);
      if (!endpoint) return { ok: false, field: 's3Endpoint', error: E.s3Endpoint };
      const bucket = form.s3Bucket.trim();
      if (!BUCKET.test(bucket)) return { ok: false, field: 's3Bucket', error: E.s3Bucket };
      if (!form.s3AccessKeyId.trim() || !form.s3SecretAccessKey)
        return {
          ok: false,
          field: form.s3AccessKeyId.trim() ? 's3SecretAccessKey' : 's3AccessKeyId',
          error: E.s3Keys,
        };
      const folder = trimSlashes(form.s3Folder);
      return {
        ok: true,
        input: {
          repository: `s3:${endpoint}/${bucket}${folder ? `/${folder}` : ''}`,
          s3AccessKeyId: form.s3AccessKeyId.trim(),
          s3SecretAccessKey: form.s3SecretAccessKey,
          ...(form.s3Region.trim() && { s3Region: form.s3Region.trim() }),
          ...join,
        },
      };
    }
    case 'sftp': {
      const host = form.sftpHost.trim();
      if (!HOST.test(host) || host.includes('@')) return { ok: false, field: 'sftpHost', error: E.sftpHost };
      const port = form.sftpPort.trim();
      if (port && !(/^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535))
        return { ok: false, field: 'sftpPort', error: E.sftpPort };
      const path = form.sftpPath.trim();
      if (!path.startsWith('/') || /\s/.test(path) || path.includes('@'))
        return { ok: false, field: 'sftpPath', error: E.sftpPath };
      const user = form.sftpUser.trim();
      if (!/^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/.test(user))
        return { ok: false, field: 'sftpUser', error: E.sftpUser };
      const hostKey = form.sftpHostKey.trim().replace(/\s+/g, ' ');
      // A known_hosts line may start with the host name: keep what follows it.
      const keyLine = hostKey && !HOST_KEY.test(hostKey) ? hostKey.split(' ').slice(1).join(' ') : hostKey;
      if (keyLine && !HOST_KEY.test(keyLine))
        return { ok: false, field: 'sftpHostKey', error: E.sftpHostKey };
      return {
        ok: true,
        input: {
          // restic's spelling (CT-142): `sftp:host:/path`, or the URL form for a port other than 22
          // (`sftp://host:2222//path`); the user is never in it.
          repository: port && Number(port) !== 22 ? `sftp://${host}:${port}/${path}` : `sftp:${host}:${path}`,
          sftpUser: user,
          ...(keyLine && { sftpHostKey: keyLine }),
          ...join,
        },
      };
    }
    case 'rest': {
      const repository = form.restRepository.trim();
      if (repository.includes('@')) return { ok: false, field: 'restRepository', error: E.credentials };
      if (!/^rest:https?:\/\/\S+$/.test(repository))
        return { ok: false, field: 'restRepository', error: E.restRepository };
      return {
        ok: true,
        input: {
          repository,
          ...(form.restUser && { restUser: form.restUser }),
          ...(form.restPassword && { restPassword: form.restPassword }),
          ...join,
        },
      };
    }
    case 'disk':
      return { ok: true, input: { repository: 'disk:', ...join } };
  }
}

/** Codes whose message is the backup service's sentence for the person (appliance BK-21, BK-25; Whombat MD-17). */
const DESTINATION_REFUSALS: ReadonlySet<string> = new Set([
  'backup_destination_failed',
  'destination_failed',
  'bad_request',
]);

/**
 * What a failed setup says: for a destination that failed (or input the service refused) the service's own sentence —
 * the bucket refused the key, the host key doesn't match, the disk isn't attached, … (BK-21), secrets redacted by the
 * service and the runtime — else the app's words for the code.
 */
export function backupErrorText(error: unknown): string {
  if (!(error instanceof OperationError)) return ACCOUNTS_TEXT.errors.failed ?? '';
  const sentence = error.message.trim();
  if (DESTINATION_REFUSALS.has(error.code) && sentence && sentence !== 'Failed.') return sentence;
  return ACCOUNTS_TEXT.errors[error.code] ?? ACCOUNTS_TEXT.errors.failed ?? '';
}
