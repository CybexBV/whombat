import type { BackupBringBack } from '@whombat/protocol/session';
import { sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import type { ControlApi } from './control';
import { PasskeyError } from './passkeys';

export const PASSKEY_SETUP_TEXT = {
  empty: 'Set up your passkey',
  incomplete: 'Finish setting up your passkey',
  ready: 'Passkey ready',
  intro: 'One passkey to sign in, open all your Whombats and unlock your backups.',
  setup: 'Set up my passkey',
  finish: 'Finish setup',
  check: 'Check my passkey',
  checking: 'Checking your passkey…',
  settingUp: 'Setting up your passkey',
  loading: 'Loading your passkey…',
  loadError: 'Couldn’t check your passkey. Try again.',
  unsupported:
    'Your browser or passkey provider couldn’t finish setting up backup access. Update both, then finish setup with the same passkey.',
  details: 'Passkey details',
  /** Under it: what it opens, the passkeys once there are any (it holds which kinds count before then too). */
  detailsMeta: (n: number) =>
    n === 0
      ? 'Which passkeys this Whombat accepts'
      : `${n === 1 ? 'Your passkey' : `Your ${n} passkeys`} and which ones this Whombat accepts`,
  saving: 'Your backup details are being saved. Finish setup in a moment.',
  readyMeta: 'Your passkey signs you in, opens your Whombats and unlocks your backups.',
  noBackups:
    'Your passkey signs you in and opens your Whombats. It will protect your backups when you set them up.',
} as const;

export interface PasskeySetupView {
  phase: 'empty' | 'incomplete' | 'ready';
  title: string;
  meta: string;
  action: string | null;
}

/** Display facts only. Access and recovery are checked by the setup ceremony, never by this status. */
export function passkeySetupView(input: {
  hasPasskey: boolean;
  linked: boolean;
  allLinked: boolean;
  bringBack: BackupBringBack | null | undefined;
}): PasskeySetupView {
  const T = PASSKEY_SETUP_TEXT;
  if (!input.hasPasskey) return { phase: 'empty', title: T.empty, meta: T.intro, action: T.setup };
  const b = input.bringBack;
  const backupsReady =
    !b || b.state === 'none' || (b.state === 'ready' && b.passkeys > 0 && b.setup === 'verified');
  if (!input.linked || !input.allLinked || !backupsReady)
    return {
      phase: 'incomplete',
      title: T.incomplete,
      meta: b?.setup === 'saving' ? T.saving : T.intro,
      action: T.finish,
    };
  return {
    phase: 'ready',
    title: T.ready,
    meta: b?.state === 'ready' ? T.readyMeta : T.noBackups,
    action: null,
  };
}

/** Read both account and appliance: unlinking here does not delete the account's passkey. */
export async function readPasskeySetup(input: {
  session: ApplianceSession;
  control: Pick<ControlApi, 'session' | 'passkeys' | 'appliances'>;
  appliance: string;
  me: string | null;
}): Promise<PasskeySetupView> {
  if (!input.me) throw new PasskeyError('invalid');
  const [local, cloud, account, backup] = await Promise.all([
    sessionOps.passkeysList(input.session),
    input.control.passkeys(),
    input.control.session(),
    sessionOps.backupStatus(input.session),
  ]);
  if (!account) throw new PasskeyError('invalid');
  if (!backup.status && backup.summary.bringBack?.state !== 'none') throw new PasskeyError('unreachable');
  const appliances = (await Promise.all(account.orgs.map((org) => input.control.appliances(org.orgId))))
    .flat()
    .filter((box) => box.state !== 'retired');
  const mine = local.passkeys.filter((key) => key.accountId === input.me);
  const shared = cloud.filter((key) => key.owner).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const linked =
    !!shared &&
    mine.some(
      (key) => key.id === shared.id && !!key.ownerHandle && key.ownerHandle === shared.owner?.userHandle,
    );
  return passkeySetupView({
    hasPasskey: mine.length > 0 || cloud.length > 0,
    linked,
    allLinked:
      !!shared &&
      [input.appliance, ...appliances.map((box) => box.contentPeerId)].every((peer) =>
        shared.owner?.appliances.includes(peer),
      ),
    bringBack: backup.summary.bringBack,
  });
}
