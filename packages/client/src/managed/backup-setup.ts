/**
 * Setting up a backup destination (AP-260, updates.md UP-F1; contracts 0.22 CT-142): the kinds the person chooses from,
 * the fields each needs, the restic repository they make and the words of setting one up in Settings. Pure and
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
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { BACKUP_SETUP_WORDS } from '../i18n/messages/backupSetup';
import { type BackupDestinationInput, OperationError } from '../session/managed-ops';
import { accountsText } from './status-copy';

export type BackupKind = 's3' | 'sftp' | 'rest' | 'disk';

/** Every kind, in the order the step offers them. */
export const BACKUP_KINDS: readonly BackupKind[] = ['s3', 'sftp', 'rest', 'disk'];

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

/** Setting up a backup destination, in a locale (English when none is given). */
export function backupSetupText(locale?: string | null) {
  const w = clientTree(locale, BACKUP_SETUP_WORDS);
  return {
    ...w,
    kinds: w.kinds satisfies Record<BackupKind, { title: string; meta: string }>,
    sftpKeyFingerprint: (fp: string) => interpolate(w.sftpKeyFingerprint, { fp }),
    hostKeyPinned: (fp: string) => interpolate(w.hostKeyPinned, { fp }),
  };
}

export const BACKUP_SETUP_TEXT = backupSetupText('en');

type Check =
  | { ok: true; input: BackupDestinationInput }
  | { ok: false; field: keyof BackupForm; error: string };

const HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])$/;
const BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/;
const HOST_KEY =
  /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]{16,}(?: .*)?$/;

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
export function destinationInput(form: BackupForm, locale?: string | null): Check {
  const E = backupSetupText(locale).errors;
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
export function backupErrorText(error: unknown, locale?: string | null): string {
  const errors = accountsText(locale).errors;
  if (!(error instanceof OperationError)) return errors.failed ?? '';
  const sentence = error.message.trim();
  if (DESTINATION_REFUSALS.has(error.code) && sentence && sentence !== 'Failed.') return sentence;
  return errors[error.code] ?? errors.failed ?? '';
}
