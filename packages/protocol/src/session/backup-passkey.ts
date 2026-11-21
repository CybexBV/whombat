/**
 * The person's passkey as the key to the backups (Whombat docs/decisions/backup-passkey.md). A passkey touch on a device
 * (a sign-in, adding a passkey, or “Use my passkey for backups”) asks for the WebAuthn PRF output for the constant salt
 * (`KIT_PRF_SALT_V2`, `@whombat/core/backup`), derives this Whombat's backup key from it (`kitKeyFromPrf`, bound to the
 * Whombat's PeerId) and hands the box only that key (`backup.passkeyKey.set`). The box locks its backup details with it
 * after every backup and every move and keeps the envelopes at Whombat's servers and next to the backups; they open
 * only with the person's passkey. Every op here is the person's on an enrolled device, never the assistant's.
 */
import { Timestamp } from '@whombat/core/domain';
import { z } from 'zod';

const b64url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);

/**
 * Where “Use my passkey” goes (the Inbox's ask, Whombat backup-passkey.md): This Whombat's backups, where the app asks
 * the passkey for this Whombat's backup key in one touch. An app that knows it does the touch right away.
 */
export const BACKUP_PASSKEY_HREF = '/settings?tab=appliance&section=backups&passkey=use';

/** Whether a link is “Touch my passkey” for the backups. */
export function isBackupPasskeyHref(href: string | null | undefined): boolean {
  return !!href && href.startsWith('/settings?') && /[?&]passkey=use(?:&|$)/.test(href);
}

/** A passkey's credential id (base64url), as `passkeys.list` names it. */
export const BackupPasskeyCredentialId = b64url(1, 512);
/** 32 bytes as base64url without padding. */
export const BackupKeyBytes = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * Where bringing this Whombat back stands: `ready` (a passkey holds its backup key and the current details are locked
 * with it at Whombat's servers), `needs_passkey` (it has backups, but no passkey holds its key yet, or the locked copy
 * isn't stored yet), `paper_only` (no passkey, but a paper copy of the current backup details was saved), `none` (no
 * backups to bring back). “Can be brought back” is `ready`, or `paper_only`.
 */
export const BackupBringBackState = z.enum(['ready', 'needs_passkey', 'paper_only', 'none']);
export type BackupBringBackState = z.infer<typeof BackupBringBackState>;

export const BackupBringBack = z.object({
  state: BackupBringBackState,
  /** Current envelopes that have been independently opened with a fresh passkey evaluation. */
  verifiedAt: Timestamp.nullable().optional(),
  /** Saving and verification are separate from a successful passkey touch. */
  setup: z.enum(['none', 'saving', 'verify', 'verified']).optional(),
  /** How many of the person's passkeys hold this Whombat's backup key. */
  passkeys: z.number().int().min(0).max(1_000),
  /** When the current backup details were last locked and stored at Whombat's servers; null: not yet. */
  lockedAt: Timestamp.nullable(),
  /** When the locked copy was last written next to the backups (the place's kit user); null: not there. */
  nasCopyAt: Timestamp.nullable(),
  /** When a paper copy of the current backup details was saved; null: none, or one of details since changed. */
  paperAt: Timestamp.nullable(),
});
export type BackupBringBack = z.infer<typeof BackupBringBack>;

/**
 * `backup.passkeyKey.set`: this Whombat's backup key from one of the person's passkeys of this Whombat. `salt` is the
 * PRF input the device used (base64url; `KIT_PRF_SALT_V2` for every new one), `key` the 32-byte `kitKeyFromPrf` of its
 * output for this Whombat. Secret: never in a receipt. The box stores it sealed and locks its backup details with it
 * right away. Refused (`backup_passkey_unknown`) unless `credentialId` is a live passkey of the caller's account here.
 */
export const BackupPasskeyKeySetInput = z.strictObject({
  credentialId: BackupPasskeyCredentialId,
  salt: b64url(1, 64),
  key: BackupKeyBytes,
});
/** `backup.passkeyKey.remove`: that passkey no longer holds the key (also done when the passkey itself is removed). */
export const BackupPasskeyKeyRemoveInput = z.strictObject({ credentialId: BackupPasskeyCredentialId });
export const BackupPasskeyKeyOutput = z.object({ bringBack: BackupBringBack });
export type BackupPasskeyKeyOutput = z.infer<typeof BackupPasskeyKeyOutput>;

/**
 * `backup.paperCopy.confirm`: the person printed or saved the paper copy of the backup details read from
 * `backup.recoveryMaterial` at `generation` of `repositoryId`. Refused (`backup_paper_stale`) when the details changed
 * since: print it again.
 */
export const BackupPaperCopyConfirmInput = z.strictObject({
  /** The repository's id as `backup.recoveryMaterial` names it (no import of `backup.ts`: `enrollment.ts` reads this file). */
  repositoryId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_.:-]+$/),
  generation: z.number().int().min(0).max(1_000_000),
});
export const BackupPaperCopyConfirmOutput = BackupPasskeyKeyOutput;

/** One envelope found next to backups on the network (a place's kit user), as `backup.findKits` answers it. */
export const BackupFoundKit = z.object({
  /** The Whombat whose backup details it locks (its content PeerId). */
  appliance: z.string().regex(/^12D3KooW[1-9A-HJ-NP-Za-km-z]{44}$/),
  applianceName: z.string().max(80).nullable(),
  /** The passkey that opens it, and the PRF input to ask it for (base64url). */
  credentialId: BackupPasskeyCredentialId,
  salt: b64url(1, 64),
  envelope: z
    .string()
    .min(1)
    .max(60_000)
    .regex(/^wbkit1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  generation: z.number().int().min(0).max(1_000_000),
  createdAt: Timestamp,
  /** The backup app it was found at (`192.168.1.40:8747`), for the screen to name the place. */
  at: z.string().min(1).max(80),
});
export type BackupFoundKit = z.infer<typeof BackupFoundKit>;

/**
 * `backup.findKits`: on a new Whombat, the envelopes kept next to backups on this network (the backup apps of the hosts
 * the network scan found, ports 8747–8766), the newest per Whombat and passkey. The fallback when the person's account
 * has none at Whombat's servers. It may take a minute (a first scan of the network).
 */
export const BackupFindKitsInput = z.strictObject({});
export const BackupFindKitsOutput = z.object({
  kits: z.array(BackupFoundKit).max(64),
  /** How many backup apps answered (0: none found on this network). */
  places: z.number().int().min(0).max(1_000),
});
export type BackupFindKitsOutput = z.infer<typeof BackupFindKitsOutput>;

/** Opens the actual stored envelope and an independent encrypted, one-use verification challenge. */
export const BackupPasskeyVerifyBeginInput = z.strictObject({ credentialId: BackupPasskeyCredentialId });
export const BackupPasskeyVerifyBeginOutput = z.object({
  salt: b64url(1, 64),
  envelope: z.string().min(1).max(60000),
  challenge: z.string().min(1).max(1024),
});
export const BackupPasskeyVerifyConfirmInput = z.strictObject({ proof: BackupKeyBytes });
