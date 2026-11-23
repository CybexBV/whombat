/**
 * The box's page at its old address, for the 30 days it still works after a change (Whombat own-address.md): “Your
 * Whombat moved to home.whombat.app. This address stops working on 23 December.” with **Go to the new address**, which
 * makes a device link for this account (`enroll.link.create`; it opens at the new address) and opens it, so this
 * browser joins there in one step. There it is asked to add a passkey for the new address (the passkeys section). A
 * full-width line in the shell's notice slot, like Link's; nothing anywhere else.
 */
import {
  OWN_NAME_TEXT,
  ownAddressMovedView,
  ownAddressMoveTarget,
  readOwnAddress,
} from '@whombat/client/managed';
import { type ApplianceSession, type OwnAddressSummary, sessionOps } from '@whombat/client/session';
import { useEffect, useState } from 'react';
import { useAppServices } from '../app/providers';
import styles from '../app/shell/ShellLayout.module.css';
import { Button } from '../components/Button';
import { StatusDot } from '../components/StatusDot';
import { useOwnAddressChanges } from './ownAddressEvents';

/** Asked again now and then: a change made on another device shows here too. */
const OWN_POLL_MS = 10 * 60_000;

export function MovedBanner() {
  const { managed } = useAppServices();
  const host = managed?.page?.host ?? null;
  if (!managed || !host) return null;
  return <MovedLine host={host} />;
}

function MovedLine({ host }: { host: string }) {
  const { session } = useAppServices();
  const [own, setOwn] = useState<OwnAddressSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const changes = useOwnAddressChanges();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `changes` only asks again
  useEffect(() => {
    let live = true;
    const ask = () =>
      readOwnAddress(session).then(
        (a) => live && setOwn(a),
        () => {},
      );
    void ask();
    const timer = setInterval(() => void ask(), OWN_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [session, changes]);
  const view = ownAddressMovedView(own, host);
  if (!view || !own) return null;
  const go = () => {
    setBusy(true);
    void goToNewAddress(session, own);
  };
  return (
    <div className={styles.notice} role="status" data-testid="own-address-moved">
      <StatusDot tone="warn" size={7} label={null} />
      <span className={styles.noticeText}>{view.text}</span>
      <Button variant="secondary" size="sm" disabled={busy} onClick={go}>
        {busy ? OWN_NAME_TEXT.going : OWN_NAME_TEXT.go}
      </Button>
    </div>
  );
}

/**
 * Opens the box's new address with a device link for this account, so this browser joins there in one step. Without a
 * link (the box refused one) the new address still opens; this browser joins there another way.
 */
export async function goToNewAddress(session: ApplianceSession, own: Pick<OwnAddressSummary, 'url'>) {
  const link = await sessionOps.linkCreate(session).then(
    (l) => l.link,
    () => null,
  );
  window.location.assign(ownAddressMoveTarget(link, own));
}
