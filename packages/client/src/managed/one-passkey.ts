import type { PasskeySummary } from '@whombat/protocol/session';
import { OperationError, sessionOps } from '../session/managed-ops';
import type { ApplianceSession, ConnectionState } from '../session/types';
import type { ControlApi } from './control';
import { verifyPasskeyBackups } from './kit-passkey';
import {
  operationReason,
  PasskeyCancelled,
  PasskeyError,
  type PasskeyPlatform,
  type PasskeySetupStep,
  passkeyRegister,
} from './passkeys';
import type { ManagedWhombats } from './switcher';

export const ONE_PASSKEY_TEXT = {
  action: 'Finish setup',
  intro:
    'Use the same passkey for your account, every Whombat and your backups. Each Whombat checks access and its saved backups.',
  checking: 'Checking your passkey…',
  cancelled:
    'The check stopped. Choose “Finish setup” to continue with the same passkey. Your existing access has been kept.',
  ready: 'Your passkey is ready on all your Whombats.',
  removed: (names: string[]) =>
    `Retired: ${names.map((name) => `“${name}”`).join(', ')}. You can delete their old items from your password manager. Keep the shared passkey you just used.`,
  kept: 'Keep your older passkeys for now. Some still protect saved backup details or open a Whombat that hasn’t been checked.',
  pending: 'Your passkey is saved. Still to check:',
} as const;

/** Visible before every provider request, shared by the web and phone. */
export function passkeySetupWords(step: PasskeySetupStep): string {
  switch (step) {
    case 'create':
      return 'Save your passkey in your password manager.';
    case 'unlock':
      return 'Touch your passkey to prepare access.';
    case 'link':
      return 'Touch your passkey to check access.';
    case 'link-and-verify':
      return 'Touch your passkey to check access and saved backups.';
    case 'verify':
      return 'Touch your passkey to check the saved backup details.';
  }
}

export interface OnePasskeyResult {
  credentialId: string;
  checked: string[];
  backupsChecked: string[];
  pending: { name: string; reason: 'offline' | 'setup' | 'backups' | 'failed' }[];
  retired: string[];
  kept: string[];
}

type Control = Pick<
  ControlApi,
  | 'session'
  | 'appliances'
  | 'passkeys'
  | 'putPasskeyOwner'
  | 'passkeyRegisterOptions'
  | 'passkeyRegisterVerify'
  | 'kitEnvelopes'
  | 'retirePasskey'
>;

interface Input {
  session: ApplianceSession;
  platform: PasskeyPlatform;
  control: Control;
  appliance: string;
  me: string | null;
  name: string;
  whombats?: Pick<ManagedWhombats, 'known' | 'connect'>;
  /** A bounded connection wait; tests inject a short deadline. */
  connectTimeoutMs?: number;
  onProgress?: (note: string) => void;
}

/** Wait for an enrolled, pinned application session, without leaving an offline Whombat reconnecting forever. */
async function opened(session: ApplianceSession, appliance: string, timeoutMs: number): Promise<string> {
  const account = (state: ConnectionState) => {
    if (state.status === 'open' && state.info.appliance.id === appliance && state.info.channel === 'app')
      return state.info.account?.id ?? null;
    return null;
  };
  const now = account(session.state());
  if (now) return now;
  return new Promise((resolve, reject) => {
    let settled = false;
    let off = () => {};
    const timer = setTimeout(() => finish(), timeoutMs);
    const finish = (id?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      if (id) resolve(id);
      else reject(new PasskeyError('unreachable'));
    };
    const check = (state: ConnectionState) => {
      const id = account(state);
      if (id) finish(id);
      else if (state.status === 'closed' || state.status === 'reconnecting') finish();
    };
    off = session.onState(check);
    if (settled) off();
    check(session.state());
    if (!settled) session.connect();
  });
}

interface Checked {
  session: ApplianceSession;
  me: string;
  passkeys: PasskeySummary[];
}

/**
 * One explicit action links the same credential on every reachable Whombat this device already trusts. Each link
 * uses its own session-bound assertion; recovery is proved for that exact credential before old access is removed.
 * Cloud-only identities never create pins or authorize links. Unchecked access and all old recovery envelopes stay.
 */
export async function setUpOnePasskey(input: Input): Promise<OnePasskeyResult> {
  if (!input.control.putPasskeyOwner || !input.me) throw new PasskeyError('unsupported');
  const cloud = await input.control.session();
  if (!cloud) throw new PasskeyError('invalid');
  const directory = (await Promise.all(cloud.orgs.map((org) => input.control.appliances(org.orgId))))
    .flat()
    .filter((a) => a.state !== 'retired');
  const seen = new Set<string>();
  const targets = directory.filter((a) => {
    if (seen.has(a.contentPeerId)) return false;
    seen.add(a.contentPeerId);
    return true;
  });
  // The currently open pinned session is authoritative even while its directory report is catching up.
  const current = targets.find((a) => a.contentPeerId === input.appliance);
  if (!current)
    targets.unshift({
      device: '',
      orgId: null,
      contentPeerId: input.appliance,
      name: 'This Whombat',
      state: 'claimed',
      lastSeenAt: null,
      revocationsPending: 0,
    });
  else targets.sort((a, b) => Number(b === current) - Number(a === current));
  const checked = new Map<string, Checked>();
  const temporary: ApplianceSession[] = [];
  const result: OnePasskeyResult = {
    credentialId: '',
    checked: [],
    backupsChecked: [],
    pending: [],
    retired: [],
    kept: [],
  };
  try {
    for (const target of targets) {
      const progress = (step: PasskeySetupStep) =>
        input.onProgress?.(
          `${target.name ?? 'This Whombat'} · Whombat ${targets.indexOf(target) + 1} of ${targets.length}. ${passkeySetupWords(step)}`,
        );
      const here = target.contentPeerId === input.appliance;
      let session: ApplianceSession | null = here ? input.session : null;
      const known = input.whombats?.known(target.device);
      // A directory update cannot silently switch the identity this device trusts.
      if (!here && known?.enrolled && known.peerId === target.contentPeerId) {
        session = input.whombats?.connect?.(target.device) ?? null;
        if (session) temporary.push(session);
      }
      if (!session) {
        result.pending.push({ name: target.name ?? 'Another Whombat', reason: 'setup' });
        continue;
      }
      try {
        const me = here
          ? input.me
          : await opened(session, target.contentPeerId, input.connectTimeoutMs ?? 8_000);
        const list = await sessionOps.passkeysList(session);
        const added = await passkeyRegister({
          ...input,
          session,
          appliance: target.contentPeerId,
          verifyBackups: true,
          onPrompt: progress,
          ...(result.credentialId && { credentialId: result.credentialId }),
        });
        result.credentialId = added.id;
        if (!added.ownerHandle || added.backups !== 'armed') throw new PasskeyError('unsupported');
        const status = await sessionOps.backupStatus(session);
        if (!status.status && status.summary.bringBack?.state !== 'none')
          throw new PasskeyError('unreachable');
        if (status.status?.destination.configured && status.status.destination.kind !== 'local') {
          if (!added.backupsVerified)
            await verifyPasskeyBackups(
              { ...input, session, appliance: target.contentPeerId, onPrompt: progress },
              added.id,
            );
          result.backupsChecked.push(target.contentPeerId);
        }
        checked.set(target.contentPeerId, { session, me, passkeys: list.passkeys });
        result.checked.push(target.contentPeerId);
      } catch (error) {
        // A dismissed ceremony must never proceed to retiring credentials.
        if (error instanceof PasskeyCancelled) throw error;
        if (here && !result.credentialId) throw error;
        result.pending.push({
          name: target.name ?? 'Another Whombat',
          reason:
            error instanceof OperationError && operationReason(error) === 'backup_passkey_saving'
              ? 'backups'
              : error instanceof PasskeyError && error.code === 'unreachable'
                ? 'offline'
                : 'failed',
        });
      }
    }
    if (!result.credentialId) throw new PasskeyError('failed');
    // Re-read after linking: concurrent changes and recovery writes must be considered before retiring anything.
    const [passkeys, envelopes] = await Promise.all([input.control.passkeys(), input.control.kitEnvelopes()]);
    for (const old of passkeys) {
      if (old.id === result.credentialId) continue;
      const peers = old.owner?.appliances ?? (old.appliance ? [old.appliance] : []);
      if (
        !input.control.retirePasskey ||
        !checked.has(input.appliance) ||
        peers.some((peer) => !checked.has(peer)) ||
        envelopes.some((kit) => kit.credentialId === old.id)
      ) {
        result.kept.push(old.name);
        continue;
      }
      try {
        for (const box of checked.values()) {
          const local = box.passkeys.find((p) => p.id === old.id);
          if (local?.accountId === box.me) await sessionOps.passkeyRemove(box.session, old.id);
        }
        // A recovery write or a link on another device can race our snapshot. Control rechecks under its account
        // lock; never use ordinary deletion here, which deliberately revokes and deletes recovery material too.
        await input.control.retirePasskey(old.id, {
          replacementId: result.credentialId,
          expectedRevision: old.owner?.revision ?? null,
          checkedAppliances: result.checked,
        });
        result.retired.push(old.name);
        // Advisory only: a password manager may still require the person to delete its old vault item.
        await input.platform.forget?.(old.id).catch(() => {});
      } catch {
        result.kept.push(old.name);
      }
    }
    return result;
  } finally {
    for (const session of temporary) session.close();
  }
}

export function onePasskeyWords(result: OnePasskeyResult): string {
  const pending = result.pending.map(
    ({ name, reason }) =>
      `${name} (${
        reason === 'setup'
          ? 'set up this device there first'
          : reason === 'backups'
            ? 'backup details are being saved; try again in a moment'
            : reason === 'offline'
              ? 'bring it online, then try again'
              : 'the check didn’t finish; try again'
      })`,
  );
  return [
    pending.length ? `${ONE_PASSKEY_TEXT.pending} ${pending.join(', ')}.` : ONE_PASSKEY_TEXT.ready,
    result.backupsChecked.length > 0
      ? pending.length
        ? 'Backups on the Whombats checked are unlocked by this passkey.'
        : 'Your backups have been checked with this passkey.'
      : '',
    result.kept.length
      ? ONE_PASSKEY_TEXT.kept
      : result.retired.length
        ? ONE_PASSKEY_TEXT.removed(result.retired)
        : '',
  ]
    .filter(Boolean)
    .join(' ');
}
