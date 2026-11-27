/**
 * The recovery kit (MA-04 §4, AP-21): a recovery key generated here (the contracts' Ed25519 keypair helper), its
 * public half registered on the appliance (`recovery.kit.register`), the kit saved by the person as a file (naming the
 * Whombat's identity, AP-65), and confirmed by signing the appliance's challenge with the key from the kit
 * (`recovery.kit.confirm`). The secret never leaves this device except inside the file the person saves. Shared by the web and the
 * phone apps.
 */
import { canonicalJson, generateKeypair, sha256Hex, signBytes, utf8ToBytes } from '@whombat/core/audit';
import { AccountId } from '@whombat/core/ids';
import {
  RECOVERY_ENROLL_PURPOSE,
  RECOVERY_KIT_CONFIRM_PURPOSE,
  RECOVERY_ROTATE_PURPOSE,
  RecoveryEnrollInput,
  signRecoveryStatement,
} from '@whombat/protocol/session';
import type { z } from 'zod';
import { NeedsNewerAppError } from '../http/errors';
import { clientTree } from '../i18n/catalog';
import { KIT_BACKUP_WORDS } from '../i18n/messages/recovery';
import { type KitBackup, OperationError, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import { isPeerId } from './pin';

export interface RecoveryKit {
  applianceName: string;
  device: string;
  appliancePeerId: string;
  /** Groups of four, what the owner types back. */
  recoveryKey: string;
  secretKeyHex: string;
  publicKeyHex: string;
  createdAt: string;
}

export function newRecoveryKit(input: {
  applianceName: string;
  device: string;
  appliancePeerId: string;
}): RecoveryKit {
  const pair = generateKeypair();
  return {
    ...input,
    secretKeyHex: pair.secretKey,
    publicKeyHex: pair.publicKey,
    recoveryKey:
      pair.secretKey
        .toUpperCase()
        .match(/.{1,4}/g)
        ?.join('-') ?? pair.secretKey,
    createdAt: new Date().toISOString(),
  };
}

/** The kit's backup section (`backup.recoveryMaterial` read strictly, `KitMaterial`, AP-265). */
export type { KitBackup };

/**
 * A destination exists but its section can't go into the kit: this app doesn't know a member of it (`newer_app`), it
 * lacks what its kind needs to reach the repository from another machine (`incomplete`, the appliance's own rule), or
 * it couldn't be fetched (`unreachable`). The kit then says so instead of carrying part of it, and so does the screen.
 */
export interface KitBackupGap {
  gap: 'newer_app' | 'incomplete' | 'unreachable';
}

/** The kit's own words: always English, whatever the screen speaks, so every kit reads the same. */
export const KIT_BACKUP_TEXT = KIT_BACKUP_WORDS.tree;

/** Why the kit left its backup section out, for the screen, in a locale (English when none is given). */
export function kitBackupText(locale?: string | null): Record<KitBackupGap['gap'], string> {
  return clientTree(locale, KIT_BACKUP_WORDS);
}

/** What each kind needs to reach the repository without the appliance (appliance `kit.Material.Validate`). */
export function kitBackupComplete(b: KitBackup): boolean {
  if (b.repository.startsWith('s3:')) return !!b.s3AccessKeyId && !!b.s3SecretAccessKey;
  if (b.repository.startsWith('sftp:')) return !!b.sftpUser && !!b.sftpPrivateKey && !!b.sftpHostKey;
  return true;
}

/**
 * The kit's backup section from the appliance: the material, null when no destination is set up, or the gap. A
 * member this app doesn't know, or a kind's missing credential, is a gap — never a kit that carries only part.
 */
export async function loadKitBackup(session: ApplianceSession): Promise<KitBackup | KitBackupGap | null> {
  try {
    const b = await sessionOps.backupRecoveryMaterial(session);
    return kitBackupComplete(b) ? b : { gap: 'incomplete' };
  } catch (error) {
    if (error instanceof OperationError)
      return error.code === 'backup_unprotected' || error.code === 'unknown_op' || error.code === 'not_found'
        ? null
        : { gap: 'unreachable' };
    return error instanceof NeedsNewerAppError ? { gap: 'newer_app' } : { gap: 'unreachable' };
  }
}

export function isKitBackupGap(b: KitBackup | KitBackupGap | null | undefined): b is KitBackupGap {
  return !!b && 'gap' in b;
}

/** The lines of the backup section (kit version 3): every credential its kind needs, then the section as JSON. */
export function backupSection(backup: KitBackup | KitBackupGap | null | undefined): string[] {
  if (!backup)
    return ['', 'Backups: none set up when this kit was made. Save a new kit after setting them up.'];
  if (isKitBackupGap(backup)) return ['', `Backups: not in this kit. ${KIT_BACKUP_TEXT[backup.gap]}`];
  const b = backup;
  const pem = b.sftpPrivateKey ? b.sftpPrivateKey.replace(/\r\n/g, '\n').trim().split('\n') : [];
  return [
    '',
    'Backups (needed to restore this Whombat onto a replacement):',
    `Destination: ${b.repository}`,
    ...(b.restUser ? [`Destination user: ${b.restUser}`] : []),
    ...(b.restPassword ? [`Destination password: ${b.restPassword}`] : []),
    ...(b.s3AccessKeyId ? [`S3 access key: ${b.s3AccessKeyId}`] : []),
    ...(b.s3SecretAccessKey ? [`S3 secret key: ${b.s3SecretAccessKey}`] : []),
    ...(b.s3Region ? [`S3 region: ${b.s3Region}`] : []),
    ...(b.sftpUser ? [`SFTP user: ${b.sftpUser}`] : []),
    ...(b.sftpHostKey ? [`SFTP host key: ${b.sftpHostKey}`] : []),
    ...(pem.length ? ['SFTP private key:', ...pem] : []),
    `Repository password: ${b.repositoryPassword}`,
    `Repository: ${b.repositoryId} · generation ${b.generation}`,
    `Manifest key: ${b.manifestKey}`,
    '',
    // What `whombat-backup destination adopt -kit` reads (restore.md): the section itself, one line of JSON.
    'Backup section for whombat-backup (save the next line as kit.json):',
    JSON.stringify(b),
  ];
}

/**
 * The kit file, version 3 (AP-65, AP-265): plain text people can print and read back. It names the Whombat's identity
 * (`Appliance identity: <PeerId>`, the pin of the device that saves it), so a device that never knew the Whombat can
 * pin it from the kit instead of trusting the directory. The backup section carries everything its kind needs to reach
 * the repository from another machine (REST user and password, S3 keys and region, the SFTP user, host key and private
 * key) and the section as JSON for `whombat-backup`. The last line is a checksum over everything above it
 * (`kitChecksum`): it catches a damaged or edited file, not a forged one — whoever can write the file can recompute
 * it.
 *
 * `ownerAccountId`: the account the kit recovers into (the person's; `recovery.enroll` names it, CT-45). The file's
 * line keeps its name (“Owner account”) so a kit saved before reads the same.
 * Written into the file so a brand-new device can use the kit (AP-41).
 */
export function kitText(
  kit: RecoveryKit,
  backup?: KitBackup | KitBackupGap | null,
  ownerAccountId?: string | null,
): string {
  const body = [
    'WHOMBAT RECOVERY KIT',
    `Kit version: ${KIT_VERSION}`,
    '',
    `Whombat: ${kit.applianceName}`,
    `Appliance: ${kit.device}`,
    `Appliance identity: ${kit.appliancePeerId}`,
    ...(ownerAccountId ? [`Owner account: ${ownerAccountId}`] : []),
    `Made: ${kit.createdAt.slice(0, 10)}`,
    '',
    'Recovery key:',
    kit.recoveryKey,
    '',
    'Keep this somewhere safe and offline. With it you can let a new device in when every signed-in device is',
    'lost. Anyone who has it can do the same, so don’t share it. Whombat can’t make you a new one without it.',
    ...backupSection(backup),
    '',
  ];
  return [...body, `Checksum: ${kitChecksum(body)}`, ''].join('\n');
}

/** 3: the backup section carries S3 and SFTP credentials and itself as JSON (AP-265). */
export const KIT_VERSION = 3;

/**
 * The kit's checksum: the first 16 hex characters of sha256 over its lines above the checksum line, each trimmed,
 * without trailing empty lines, joined with `\n` (so a copy with Windows line ends or trailing spaces still reads).
 */
export function kitChecksum(lines: readonly string[]): string {
  const trimmed = lines.map((l) => l.trim());
  while (trimmed.length > 0 && trimmed.at(-1) === '') trimmed.pop();
  return sha256Hex(trimmed.join('\n')).slice(0, 16);
}

/** Signature over the appliance's challenge with the recovery key (`RecoveryKitConfirmation`, canonical JSON). */
export function confirmationSignature(kit: RecoveryKit, kitId: string, challenge: string): string {
  const confirmation = {
    purpose: RECOVERY_KIT_CONFIRM_PURPOSE,
    appliance: kit.appliancePeerId,
    kitId,
    challenge,
  };
  return signBytes(utf8ToBytes(canonicalJson(confirmation)), kit.secretKeyHex);
}

/**
 * The secret key in a recovery key as the owner types it from a saved kit (`5DB6-…`, any case, with or without
 * dashes or spaces); null when it isn't one.
 */
export function recoverySecretFromKey(typed: string): string | null {
  const hex = typed.replace(/[\s-]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/**
 * Replacing the recovery key (CT-45): the current key (from the saved kit) signs the new public key for this
 * appliance (`RecoveryRotation`, canonical JSON) — `recovery.kit.rotate {newRecoveryPublicKey, currentKeySignature}`.
 */
export function rotationSignature(input: {
  currentSecretKeyHex: string;
  appliancePeerId: string;
  newRecoveryPublicKey: string;
}): string {
  return signRecoveryStatement(
    {
      purpose: RECOVERY_ROTATE_PURPOSE,
      appliance: input.appliancePeerId,
      newRecoveryPublicKey: input.newRecoveryPublicKey,
    } as never,
    input.currentSecretKeyHex,
  );
}

/** What a saved kit file tells a device that wants back in (AP-41, AP-65). */
export interface SavedKit {
  /** The recovery key's secret (64 hex). */
  secretKeyHex: string;
  /** The appliance code the kit was made for (`Appliance: …`), if the file says. */
  device: string | null;
  /** The owner account it recovers into (`Owner account: …`; kits made before AP-41 don't say). */
  accountId: string | null;
  /**
   * The Whombat's identity (`Appliance identity: …`, kit version 2 and later). Null for a version 1 kit, which works
   * only on a device that already pinned that Whombat (AP-65).
   */
  appliancePeerId: string | null;
  /** 1: before AP-65; 2: names the identity, checksummed; 3: the backup section's S3/SFTP credentials (AP-265). */
  version: 1 | 2 | 3;
}

export type KitRead =
  | { ok: true; kit: SavedKit }
  /** `not_a_kit`: no recovery key in it; `damaged`: a version 2 kit whose checksum or identity line doesn't hold. */
  | { ok: false; reason: 'not_a_kit' | 'damaged' };

/** Reads a saved kit file (as `kitText` writes it, or a version 1 kit from before AP-65). */
export function readKitFile(text: string): KitRead {
  const raw = text.split(/\r?\n/);
  const lines = raw.map((l) => l.trim());
  const at = lines.indexOf('Recovery key:');
  const secretKeyHex = at >= 0 ? recoverySecretFromKey(lines[at + 1] ?? '') : null;
  if (!secretKeyHex) return { ok: false, reason: 'not_a_kit' };
  const field = (name: string) => {
    const line = lines.find((l) => l.startsWith(`${name}: `));
    return line ? line.slice(name.length + 2).trim() || null : null;
  };
  const accountId = field('Owner account');
  const identity = field('Appliance identity');
  const checksumAt = lines.findIndex((l) => l.startsWith('Checksum: '));
  const v2 = field('Kit version') !== null || identity !== null || checksumAt >= 0;
  if (v2) {
    // A version 2 kit counts only whole: its checksum over everything above it, and a well-formed identity.
    if (checksumAt < 0 || field('Checksum') !== kitChecksum(raw.slice(0, checksumAt)))
      return { ok: false, reason: 'damaged' };
    if (!isPeerId(identity)) return { ok: false, reason: 'damaged' };
  }
  return {
    ok: true,
    kit: {
      secretKeyHex,
      device: field('Appliance'),
      accountId: accountId && AccountId.safeParse(accountId).success ? accountId : null,
      appliancePeerId: v2 ? identity : null,
      version: !v2 ? 1 : Number(field('Kit version')) >= 3 ? 3 : 2,
    },
  };
}

export type RecoveryEnrollRequest = z.input<typeof RecoveryEnrollInput>;

/**
 * The recovery ceremony's request (MA-04 §4, CT-45): the kit's key signs a `RecoveryStatement` binding this
 * appliance, this device's new key (the session's own identity), the owner account, the time and a fresh nonce;
 * `recovery.enroll` then lets this device in as that owner. Validated with the contract's schema.
 */
export function recoveryEnrollRequest(input: {
  secretKeyHex: string;
  appliancePeerId: string;
  endpointPeerId: string;
  accountId: string;
  endpoint: { label: string; platform: 'web' | 'android' | 'ios' | 'desktop' | 'cli' };
  now?: Date;
  /** 32 hex characters (128 bits); random by default. */
  nonce?: string;
}): RecoveryEnrollRequest {
  const statement = {
    purpose: RECOVERY_ENROLL_PURPOSE,
    appliance: input.appliancePeerId,
    endpoint: input.endpointPeerId,
    accountId: input.accountId,
    issuedAt: (input.now ?? new Date()).toISOString(),
    nonce: input.nonce ?? randomNonce(),
  } as const;
  return RecoveryEnrollInput.parse({
    statement,
    signature: signRecoveryStatement(statement as never, input.secretKeyHex),
    endpoint: input.endpoint,
  });
}

function randomNonce(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Words for a refused recovery (`COPY.recover.errors` keys). */
export type RecoveryErrorKey =
  | 'recovery_not_kit_owner'
  | 'recovery_kit_unverified'
  | 'recovery_signature_invalid'
  | 'recovery_statement_expired'
  | 'recovery_key_missing'
  | 'rate_limited'
  | 'failed';

export function recoveryErrorKey(error: unknown): RecoveryErrorKey {
  if (!(error instanceof OperationError)) return 'failed';
  switch (error.code) {
    case 'recovery_not_kit_owner':
    case 'recovery_kit_unverified':
    case 'recovery_signature_invalid':
    case 'recovery_statement_expired':
    case 'recovery_key_missing':
    case 'rate_limited':
      return error.code;
    default:
      return 'failed';
  }
}

/** The account an open session acts as (the person's), else null. */
export function accountOf(session: Pick<ApplianceSession, 'state'>): string | null {
  const s = session.state();
  return s.status === 'open' ? (s.info.account?.id ?? null) : null;
}
