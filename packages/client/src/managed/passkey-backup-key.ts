/**
 * The passkey as the key to a Whombat's backups, on the device (Whombat docs/decisions/backup-passkey.md; the app's
 * decisions AP-6865…). Every passkey touch asks for WebAuthn's PRF output for the one constant salt
 * (`KIT_PRF_SALT_V2`): a sign-in in the same touch (it doesn't know the Whombat before the passkey names it), adding a
 * passkey where the platform answers PRF at creation, and “Use my passkey” (`armBackupKey`). The output never leaves
 * this device: it is read out of the platform's answer, which loses it before the answer goes to control or the
 * Whombat (`withoutPrfResults`), and turned into the Whombat's own backup key (`kitKeyFromPrf`, bound to its PeerId),
 * the only thing `backup.passkeyKey.set` hands the Whombat.
 *
 * A sign-in has no app session yet: its key waits in memory (`holdBackupKey`, never in storage) until the app opens that
 * Whombat (`deliverBackupKey`).
 */
import {
  fromBase64url,
  KIT_PRF_SALT_V2_B64,
  kitKeyFromPrf,
  openKitWithKey,
  toBase64url,
} from '@whombat/core/backup';
import { type BackupPasskeyKeyOutput, kitMaterialOf } from '@whombat/protocol/session';
import { OperationError, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';

/** What `backup.passkeyKey.set` takes. */
export interface BackupKeyInput {
  credentialId: string;
  salt: string;
  key: string;
}

/** What adding a passkey did for the backups: armed in the same touch, the next touch will, it can't, or it failed. */
export type BackupArming = 'armed' | 'touch' | 'unsupported' | 'failed';

/** A stored envelope and a fresh challenge for one exact credential on this session. */
export type PasskeyBackupCheck = Awaited<ReturnType<typeof sessionOps.backupPasskeyVerifyBegin>>;

/** No saved key yet is expected during setup. Other failures must not silently trigger another ceremony. */
export async function preparePasskeyBackupCheck(
  session: ApplianceSession,
  credentialId: string,
): Promise<PasskeyBackupCheck | null> {
  try {
    return await sessionOps.backupPasskeyVerifyBegin(session, credentialId);
  } catch (error) {
    if (
      error instanceof OperationError &&
      (error.details as { code?: unknown } | undefined)?.code === 'backup_passkey_saving'
    )
      return null;
    throw error;
  }
}

/** The caller owns and wipes the fresh PRF output, checked against previously saved owner or recovery material. */
export async function confirmPasskeyBackupCheck(
  input: { session: ApplianceSession; appliance: string },
  begin: PasskeyBackupCheck,
  output: Uint8Array,
): Promise<BackupPasskeyKeyOutput['bringBack'] | null> {
  const key = kitKeyFromPrf(output, input.appliance);
  try {
    const kit = openKitWithKey(begin.envelope, key, input.appliance);
    const proof = openKitWithKey(begin.challenge, key, `verification:${input.appliance}`);
    if (!kit || !kitMaterialOf(kit) || !proof) return null;
    return (await sessionOps.backupPasskeyVerifyConfirm(input.session, proof)).bringBack;
  } finally {
    key.fill(0);
  }
}

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

/** WebAuthn options with the PRF extension asking for the backup key's salt (base64url, as WebAuthn's JSON has it). */
export function withBackupPrf<T extends { extensions?: Record<string, unknown> }>(options: T): T {
  return {
    ...options,
    extensions: { ...(options.extensions ?? {}), prf: { eval: { first: KIT_PRF_SALT_V2_B64 } } },
  };
}

/** Extension outputs without the PRF's: what may go to control and to the Whombat. */
export function withoutPrfResults(extensions: Loose): Loose {
  if (!isObject(extensions.prf)) return extensions;
  const { results: _secret, ...prf } = extensions.prf;
  return { ...extensions, prf };
}

/** The PRF output in a platform's answer (`clientExtensionResults.prf.results.first`, base64url); null without one. */
export function prfOutputOf(raw: unknown): Uint8Array | null {
  const r = isObject(raw) ? raw : {};
  const ext = isObject(r.clientExtensionResults) ? r.clientExtensionResults : {};
  const prf = isObject(ext.prf) ? ext.prf : {};
  const results = isObject(prf.results) ? prf.results : {};
  const first = typeof results.first === 'string' ? fromBase64url(results.first) : null;
  return first && first.length === 32 ? first : null;
}

/** Whether a created passkey said it can't answer PRF (`prf.enabled: false`). */
export function prfRefused(raw: unknown): boolean {
  const r = isObject(raw) ? raw : {};
  const ext = isObject(r.clientExtensionResults) ? r.clientExtensionResults : {};
  return isObject(ext.prf) && ext.prf.enabled === false;
}

/** The Whombat's backup key from a passkey's PRF output (the output is wiped once used). */
export function backupKeyInput(
  credentialId: string,
  prfOutput: Uint8Array,
  appliance: string,
): BackupKeyInput {
  const key = kitKeyFromPrf(prfOutput, appliance);
  const input = { credentialId, salt: KIT_PRF_SALT_V2_B64, key: toBase64url(key) };
  key.fill(0);
  prfOutput.fill(0);
  return input;
}

/* A sign-in's key until the app opens the Whombat ------------------------------------------------------------------- */

const held = new Map<string, BackupKeyInput>();

/** Keeps a sign-in's key for the Whombat `device` until its app session opens (memory only). */
export function holdBackupKey(device: string, input: BackupKeyInput): void {
  held.set(device, input);
}

/** Hands the Whombat the key a sign-in held for it, once; quiet when there is none or it is refused. */
export async function deliverBackupKey(
  session: ApplianceSession,
  device: string,
): Promise<BackupPasskeyKeyOutput | null> {
  const input = held.get(device);
  if (!input) return null;
  held.delete(device);
  try {
    return await sessionOps.backupPasskeyKeySet(session, input);
  } catch {
    // An older Whombat, no backup service, a passkey it doesn't know: the next touch asks again.
    return null;
  }
}

/** Tests: whether a key waits for `device`. */
export function heldBackupKey(device: string): boolean {
  return held.has(device);
}

/** Some password managers return an array instead of BufferSource. Accept exactly 32 bytes, never coerce values. */
export function passkeyPrfBytes(value: unknown): Uint8Array | null {
  let bytes: Uint8Array;
  if (typeof value === 'string')
    return prfOutputOf({ clientExtensionResults: { prf: { results: { first: value } } } });
  if (Array.isArray(value)) {
    if (value.length !== 32 || !value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null;
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value))
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else if (Object.prototype.toString.call(value) === '[object ArrayBuffer]')
    bytes = new Uint8Array(value as ArrayBuffer);
  else return null;
  return bytes.length === 32 ? new Uint8Array(bytes) : null;
}
