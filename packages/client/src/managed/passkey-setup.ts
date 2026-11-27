import type { BackupBringBack } from '@whombat/protocol/session';
import { clientTree } from '../i18n/catalog';
import { PASSKEY_SETUP_WORDS } from '../i18n/messages/passkeySetup';
import { sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import type { ControlApi } from './control';
import { PasskeyError } from './passkeys';

/** The one passkey's setup words in a locale (English when none is given). */
export function passkeySetupText(locale?: string | null) {
  const { detailsMetaNone, detailsMeta, ...w } = clientTree(locale, PASSKEY_SETUP_WORDS);
  return {
    ...w,
    /** Under it: what it opens, the passkeys once there are any (it holds which kinds count before then too). */
    detailsMeta: (n: number) => (n === 0 ? detailsMetaNone : detailsMeta(n)),
  };
}

export const PASSKEY_SETUP_TEXT = passkeySetupText('en');

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
  locale?: string | null;
}): PasskeySetupView {
  const T = passkeySetupText(input.locale);
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
  locale?: string | null;
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
    locale: input.locale,
  });
}
