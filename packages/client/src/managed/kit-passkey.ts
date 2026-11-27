/**
 * The backup details locked with the person's passkey (Whombat docs/decisions/backup-options.md, backup-passkey.md):
 * sealed with a key from the passkey's WebAuthn PRF output, by the Whombat itself with the key a passkey touch gave it
 * (`armBackupKey`), or on this device (`lockKitWithPasskey`); only envelopes go to control and next to the backups, and
 * nothing there can open them. On a new Whombat the same passkey opens one again (any device that has the passkey) and
 * its backup section joins the old Whombat's backups: from the account (control), else from the network
 * (`kitsToBringBackFrom`). The paper copy holds only the backup part (`paperCopyText`), so it can be printed any time.
 * Shared by web and phone.
 */

import type { KitEnvelope } from '@whombat/control-contracts';
import {
  fromBase64url,
  KIT_PRF_SALT_V2,
  newKitPrfSalt,
  openKit,
  sealKit,
  toBase64url,
} from '@whombat/core/backup';
import {
  type BackupFoundKit,
  type BackupPasskeyKeyOutput,
  type BackupRecoveryMaterial,
  kitMaterialOf,
  parsePasskeyUserHandle,
} from '@whombat/protocol/session';
import type { z } from 'zod';
import { clientTree } from '../i18n/catalog';
import { BACKUP_PASSKEY_WORDS } from '../i18n/messages/hostManaged/backupPasskey';
import { OperationError, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import type { ControlApi } from './control';
import { backupKeyInput, confirmPasskeyBackupCheck, preparePasskeyBackupCheck } from './passkey-backup-key';
import {
  operationReason,
  PasskeyCancelled,
  PasskeyError,
  type PasskeyPlatform,
  type PasskeyRegisterControl,
  type PasskeySetupStep,
  passkeyErrorText,
  passkeyRegister,
} from './passkeys';

export interface LockKitInput {
  platform: Pick<PasskeyPlatform, 'prf'>;
  control: Pick<ControlApi, 'putKitEnvelope'>;
  /** The Whombat's content PeerId. */
  appliance: string;
  /** This Whombat's passkeys of this account (credential ids, base64url): the platform picks the one it has. */
  credentialIds: readonly string[];
  kitText: string;
  /** The backup service's `kitGeneration`. */
  generation: number;
}

/**
 * Locks the kit with whichever of the Whombat's passkeys this device has and keeps the envelope at the account.
 * `PasskeyError('unsupported')` when the passkey or its manager has no PRF (the person prints or saves the kit
 * instead); `PasskeyCancelled` when they dismissed the prompt.
 */
export async function lockKitWithPasskey(input: LockKitInput): Promise<{ id: string; credentialId: string }> {
  if (!input.platform.prf || input.credentialIds.length === 0) throw new PasskeyError('unsupported');
  const salt = newKitPrfSalt();
  const got = await input.platform.prf({ credentialIds: input.credentialIds, salt });
  if (got?.output?.length !== 32 || !input.credentialIds.includes(got.credentialId)) {
    got?.output?.fill(0);
    throw new PasskeyError('unsupported');
  }
  const envelope = sealKit(input.kitText, got.output, input.appliance);
  got.output.fill(0);
  const { id } = await input.control.putKitEnvelope({
    appliance: input.appliance,
    credentialId: got.credentialId,
    salt: toBase64url(salt),
    envelope,
    generation: input.generation,
  });
  return { id, credentialId: got.credentialId };
}

/** The envelopes a new Whombat can bring back from: newest first, one per old Whombat (the newest of each). */
export function kitsToBringBack<K extends Pick<KitEnvelope, 'appliance' | 'createdAt'>>(
  envelopes: readonly K[],
  thisAppliance: string | null,
): K[] {
  const seen = new Set<string>();
  const out: K[] = [];
  for (const e of [...envelopes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (e.appliance === thisAppliance || seen.has(e.appliance)) continue;
    seen.add(e.appliance);
    out.push(e);
  }
  return out;
}

/** An envelope a new Whombat can open with the passkey: from the account, or found next to backups on the network. */
export type BringBackKit = Pick<
  KitEnvelope,
  'appliance' | 'credentialId' | 'salt' | 'envelope' | 'generation' | 'createdAt' | 'whombatName'
> & {
  from: 'account' | 'network';
  /** Control's id of an account envelope. */
  id?: string;
};

/** A found envelope as `unlockKitWithPasskey` takes it. */
export function foundKit(k: BackupFoundKit): BringBackKit {
  return {
    appliance: k.appliance,
    credentialId: k.credentialId,
    salt: k.salt,
    envelope: k.envelope,
    generation: k.generation,
    createdAt: k.createdAt,
    whombatName: k.applianceName,
    from: 'network',
  };
}

/**
 * Kits whose passkey the account still has (control's live passkeys, `live`): a passkey removed (a lost phone) no longer
 * offers its kit. `prefer` keeps the others too, but only for a Whombat no live passkey's kit opens: a kit found on the
 * network may be another account's passkey, which this account doesn't list. `live` null (control didn't answer): all.
 */
export function withLivePasskeys<K extends Pick<KitEnvelope, 'appliance' | 'credentialId'>>(
  kits: readonly K[],
  live: ReadonlySet<string> | null,
  options: { prefer?: boolean } = {},
): K[] {
  if (!live) return [...kits];
  const kept = kits.filter((k) => live.has(k.credentialId));
  if (!options.prefer) return kept;
  const opened = new Set(kept.map((k) => k.appliance));
  return kits.filter((k) => live.has(k.credentialId) || !opened.has(k.appliance));
}

/** The account's live passkeys at control (their credential ids), or null when control doesn't say. */
export async function livePasskeys(
  control: Partial<Pick<ControlApi, 'passkeys'>> | null,
): Promise<Set<string> | null> {
  if (!control?.passkeys) return null;
  const list = await control.passkeys().catch(() => null);
  return list ? new Set(list.map((p) => p.id)) : null;
}

/**
 * The account's kits a new Whombat can bring back from, newest first, one per old Whombat, only those a passkey the
 * account still has opens.
 */
export async function accountKitsToBringBack(
  control: (Pick<ControlApi, 'kitEnvelopes'> & Partial<Pick<ControlApi, 'passkeys'>>) | null,
  thisAppliance: string | null,
): Promise<BringBackKit[]> {
  if (!control) return [];
  const [envelopes, live] = await Promise.all([
    control.kitEnvelopes().catch(() => [] as KitEnvelope[]),
    livePasskeys(control),
  ]);
  return kitsToBringBack(
    withLivePasskeys(envelopes, live).map((e): BringBackKit => ({ ...e, from: 'account' })),
    thisAppliance,
  );
}

/**
 * What a new Whombat can bring back from, newest first, one per old Whombat: the account's envelopes at control; when
 * there are none (or control doesn't answer), the ones next to backups on this network (`backup.findKits`, which may
 * take a minute on a Whombat that hasn't looked at its network yet).
 */
export async function kitsToBringBackFrom(input: {
  control: (Pick<ControlApi, 'kitEnvelopes'> & Partial<Pick<ControlApi, 'passkeys'>>) | null;
  session: ApplianceSession;
  thisAppliance: string | null;
}): Promise<BringBackKit[]> {
  const fromAccount = await accountKitsToBringBack(input.control, input.thisAppliance);
  if (fromAccount.length > 0) return fromAccount;
  return kitsFromNetwork(input.session, input.thisAppliance, input.control);
}

/**
 * The envelopes next to backups on this network, one per old Whombat (none when nothing answers). With the account's
 * control, a kit of a passkey it removed is offered only for a Whombat none of its live passkeys opens.
 */
export async function kitsFromNetwork(
  session: ApplianceSession,
  thisAppliance: string | null,
  control?: Partial<Pick<ControlApi, 'passkeys'>> | null,
): Promise<BringBackKit[]> {
  const [found, live] = await Promise.all([
    sessionOps.backupFindKits(session, { deadlineMs: 150_000 }).catch(() => null),
    livePasskeys(control ?? null),
  ]);
  return kitsToBringBack(
    withLivePasskeys((found?.kits ?? []).map(foundKit), live, { prefer: true }),
    thisAppliance,
  );
}

/* Arming: the Whombat's backup key from one touch -------------------------------------------------------------------- */

export type ArmBackupKeyResult =
  | { kind: 'armed'; bringBack: BackupPasskeyKeyOutput['bringBack'] }
  /** The person has no passkey for this Whombat yet: add one (that touch may arm it too, `passkeyRegister`). */
  | { kind: 'no_passkey' }
  | { kind: 'upgrade' };

/**
 * “Use my passkey for backups”: one touch of any of the person's passkeys of this Whombat gives it its backup key
 * (`backup.passkeyKey.set`). `PasskeyError('unsupported')` where the passkey or its manager has no PRF;
 * `PasskeyCancelled` when the prompt was dismissed.
 */
export async function armBackupKey(input: {
  session: ApplianceSession;
  platform: Pick<PasskeyPlatform, 'prf'>;
  /** The Whombat's content PeerId. */
  appliance: string;
  /** The caller's account on the Whombat (its passkeys are the ones that may hold the key). */
  me: string | null;
  /** Prefer the account's shared credential, including when it still needs linking on this Whombat. */
  credentialId?: string;
  onPrompt?: (step: PasskeySetupStep) => void;
}): Promise<ArmBackupKeyResult> {
  if (!input.platform.prf) throw new PasskeyError('unsupported');
  const list = await sessionOps.passkeysList(input.session);
  const mine = list.passkeys.filter((p) => !input.me || p.accountId === input.me);
  const shared = mine.filter((p) => p.ownerHandle).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // An older sign-in-only credential must not keep winning the password manager's picker after an upgrade.
  const ids = (
    input.credentialId
      ? mine.filter((p) => p.id === input.credentialId)
      : shared.length
        ? shared.slice(0, 1)
        : mine
  ).map((p) => p.id);
  if (ids.length === 0) return { kind: 'no_passkey' };
  const check =
    ids.length === 1 && shared.some((p) => p.id === ids[0])
      ? await preparePasskeyBackupCheck(input.session, ids[0] as string)
      : null;
  const salt = check ? fromBase64url(check.salt) : KIT_PRF_SALT_V2;
  if (!salt) throw new PasskeyError('failed');
  input.onPrompt?.(check ? 'verify' : 'unlock');
  const got = await input.platform.prf({ credentialIds: ids, salt });
  if (!got) throw new PasskeyError('unsupported');
  if (!ids.includes(got.credentialId)) {
    got.output?.fill(0);
    throw new PasskeyError('invalid');
  }
  if (got.output?.length !== 32) {
    got.output?.fill(0);
    if (list.passkeys.find((p) => p.id === got.credentialId)?.ownerHandle)
      throw new PasskeyError('unsupported');
    return { kind: 'upgrade' };
  }
  // A passkey made for another Whombat (one this one was brought back from) can't open this one: a new one is needed.
  const selected = list.passkeys.find((p) => p.id === got.credentialId);
  if (
    got.userHandle &&
    (selected?.ownerHandle
      ? got.userHandle !== selected.ownerHandle
      : parsePasskeyUserHandle(got.userHandle) !== input.appliance)
  ) {
    got.output.fill(0);
    return { kind: 'no_passkey' };
  }
  try {
    if (check) {
      const bringBack = await confirmPasskeyBackupCheck(input, check, got.output);
      if (!bringBack) throw new PasskeyError('invalid');
      return { kind: 'armed', bringBack };
    }
    const out = await sessionOps.backupPasskeyKeySet(
      input.session,
      backupKeyInput(got.credentialId, got.output, input.appliance),
    );
    if (
      out.bringBack.setup === 'verify' ||
      (out.bringBack.state === 'ready' && out.bringBack.setup !== 'saving')
    )
      return { kind: 'armed', bringBack: await verifyPasskeyBackups(input, got.credentialId) };
    return { kind: 'armed', bringBack: out.bringBack };
  } finally {
    got.output.fill(0);
  }
}

/** Opens an envelope with the passkey; null when this passkey's output doesn't open it. */
export async function unlockKitWithPasskey(
  platform: Pick<PasskeyPlatform, 'prf'>,
  envelope: Pick<KitEnvelope, 'credentialId' | 'salt' | 'envelope' | 'appliance'>,
): Promise<string | null> {
  if (!platform.prf) throw new PasskeyError('unsupported');
  const salt = fromBase64url(envelope.salt);
  if (!salt) return null;
  const got = await platform.prf({ credentialIds: [envelope.credentialId], salt });
  if (!got?.output || got.credentialId !== envelope.credentialId) {
    got?.output?.fill(0);
    throw new PasskeyError('unsupported');
  }
  try {
    return openKit(envelope.envelope, got.output, envelope.appliance);
  } finally {
    got.output.fill(0);
  }
}

/* The printed kit's QR code ---------------------------------------------------------------------------------- */

export const KIT_QR_PREFIX = 'wbkit-qr1:';

/**
 * What the printed kit's QR code holds: the kit's backup section (what joining the backups takes) as one JSON line.
 * The recovery key stays in the printed text only (a new Whombat brought back doesn't need it to open the backups).
 */
export function kitQrPayload(kitText: string): string | null {
  const material = kitMaterialOf(kitText);
  return material ? `${KIT_QR_PREFIX}${JSON.stringify(material)}` : null;
}

/**
 * Feedback for compatibility callers, in the person's language; app entry points use the shared setup action.
 * `unsupported` is most often a passkey kept by a password manager that can't do this on this device (Google's on an
 * iPhone).
 */
export function backupPasskeyText(locale?: string | null) {
  return clientTree(locale, BACKUP_PASSKEY_WORDS);
}

export type BackupPasskeyText = ReturnType<typeof backupPasskeyText>;

export const BACKUP_PASSKEY_TEXT: BackupPasskeyText = backupPasskeyText('en');

/**
 * Compatibility helper for older callers; app setup uses `setUpOnePasskey`. A touch of one of the person's passkeys
 * gives the Whombat its backup key;
 * with none yet, a passkey is added and that touch arms it where the platform allows (else the next tap does). Answers
 * what to say; null when the person dismissed the prompt.
 */
export async function tapPasskeyForBackups(input: {
  session: ApplianceSession;
  platform: PasskeyPlatform;
  control: PasskeyRegisterControl | null;
  appliance: string;
  me: string | null;
  /** The new passkey's name (this device's label). */
  name: string;
  upgrade?: boolean;
  onPrompt?: (step: PasskeySetupStep) => void;
  /** The language of what it answers; English when left out. */
  locale?: string | null;
}): Promise<string | null> {
  const T = backupPasskeyText(input.locale);
  try {
    const shared = (await input.control?.passkeys?.())
      ?.filter((p) => p.owner)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const armed = input.upgrade
      ? { kind: 'no_passkey' as const }
      : await armBackupKey({
          ...input,
          ...(shared && { credentialId: shared.id }),
        });
    if (armed.kind === 'upgrade') return T.upgrade;
    if (armed.kind === 'armed') return recoveryWords(armed.bringBack, T);
    if (!input.control) return T.unsupported;
    const added = await passkeyRegister({
      session: input.session,
      control: input.control,
      platform: input.platform,
      appliance: input.appliance,
      name: input.name,
      ...(shared && { credentialId: shared.id }),
      verifyBackups: true,
      onPrompt: input.onPrompt,
    });
    if (added.backups === 'armed')
      return added.backupsVerified ? T.armed : recoveryWords(await verifyPasskeyBackups(input, added.id), T);
    return added.backups === 'unsupported' ? T.unsupported : T.again;
  } catch (error) {
    if (error instanceof PasskeyCancelled) return null;
    if (error instanceof OperationError && operationReason(error) === 'backup_passkey_saving')
      return T.saving;
    if (error instanceof OperationError && operationReason(error) === 'backup_passkey_key_changed')
      return T.wrongKey;
    if (error instanceof PasskeyError && error.code === 'unsupported') return T.unsupported;
    if (error instanceof PasskeyError && error.code === 'invalid') return T.wrongKey;
    return passkeyErrorText(error, input.locale) ?? T.failed;
  }
}

/* The paper copy: the backup part only ------------------------------------------------------------------------------ */

type Material = z.output<typeof BackupRecoveryMaterial>;

/**
 * The paper copy's text (Whombat backup-passkey.md): only what opens the backups (the backup section and its JSON line,
 * which `backup.adopt` and a scan read), never the recovery key, so the owner can print it whenever they like without
 * the old kit. Bring back finds the backups on the network by their repository, so a new address doesn't make it stale.
 */
export function paperCopyText(input: {
  applianceName: string;
  appliancePeerId: string;
  material: Material;
  /** The day it is printed (`YYYY-MM-DD`). */
  made?: string;
}): string {
  return [
    'WHOMBAT BACKUP DETAILS',
    '',
    `Whombat: ${input.applianceName}`,
    `Appliance identity: ${input.appliancePeerId}`,
    `Made: ${input.made ?? new Date().toISOString().slice(0, 10)}`,
    '',
    'These open your Whombat’s backups on a new Whombat. Keep them somewhere safe and offline: anyone who has them',
    'can read your backups.',
    ...paperSection(input.material),
    '',
  ].join('\n');
}

/**
 * The backup part in plain words (no repository or password jargon: the person reads it), then the line a new Whombat
 * reads (`backup.adopt`, a scan of the QR code, the recovery tool's `kit.json`).
 */
function paperSection(m: Material): string[] {
  const pem = m.sftpPrivateKey ? m.sftpPrivateKey.replace(/\r\n/g, '\n').trim().split('\n') : [];
  return [
    '',
    `Where the backups are: ${m.repository}`,
    ...(m.restUser ? [`User at that place: ${m.restUser}`] : []),
    ...(m.restPassword ? [`Password at that place: ${m.restPassword}`] : []),
    ...(m.s3AccessKeyId ? [`Storage access key: ${m.s3AccessKeyId}`] : []),
    ...(m.s3SecretAccessKey ? [`Storage secret key: ${m.s3SecretAccessKey}`] : []),
    ...(m.s3Region ? [`Storage region: ${m.s3Region}`] : []),
    ...(m.sftpUser ? [`SFTP user: ${m.sftpUser}`] : []),
    ...(m.sftpHostKey ? [`SFTP host key: ${m.sftpHostKey}`] : []),
    ...(pem.length ? ['SFTP private key:', ...pem] : []),
    `Backup key: ${m.repositoryPassword}`,
    `Backups: ${m.repositoryId} · version ${m.generation}`,
    `Signature key: ${m.manifestKey}`,
    '',
    'For a new Whombat (the QR code holds the same; save this line as kit.json for the recovery tool):',
    JSON.stringify(m),
  ];
}

/** Tells the Whombat the paper copy of these details was printed or saved (it then counts as a way back). */
export function confirmPaperCopy(
  session: ApplianceSession,
  material: Pick<Material, 'repositoryId' | 'generation'>,
): Promise<BackupPasskeyKeyOutput> {
  return sessionOps.backupPaperCopyConfirm(session, {
    repositoryId: material.repositoryId,
    generation: material.generation,
  });
}

/** A scanned QR code, a pasted kit or a kit file's text: what `backup.adopt` takes, or null when it isn't a kit. */
export function kitFromScan(text: string): string | null {
  const t = text.trim();
  const body = t.startsWith(KIT_QR_PREFIX) ? t.slice(KIT_QR_PREFIX.length) : t;
  return kitMaterialOf(body) ? body : null;
}

function recoveryWords(
  bringBack: BackupPasskeyKeyOutput['bringBack'] | undefined,
  T: BackupPasskeyText,
): string {
  if (bringBack?.setup === 'verified' && bringBack.state === 'ready') return T.armed;
  return bringBack?.setup === 'saving' ? T.saving : T.verify;
}

export async function verifyPasskeyBackups(
  input: {
    session: ApplianceSession;
    appliance: string;
    platform: Pick<PasskeyPlatform, 'prf'>;
    onPrompt?: (step: PasskeySetupStep) => void;
  },
  credentialId: string,
): Promise<BackupPasskeyKeyOutput['bringBack']> {
  const begin = await sessionOps.backupPasskeyVerifyBegin(input.session, credentialId);
  const salt = fromBase64url(begin.salt);
  if (!salt) throw new PasskeyError('failed');
  input.onPrompt?.('verify');
  const got = await input.platform.prf?.({ credentialIds: [credentialId], salt });
  if (!got?.output || got.credentialId !== credentialId) {
    got?.output?.fill(0);
    throw new PasskeyError('unsupported');
  }
  try {
    const bringBack = await confirmPasskeyBackupCheck(input, begin, got.output);
    if (!bringBack) throw new PasskeyError('invalid');
    return bringBack;
  } finally {
    got.output.fill(0);
  }
}
