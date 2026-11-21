/**
 * The passkey notices of a managed Whombat, as full-width lines above the screen in the shell's notice slot (under
 * “You haven’t signed in to Claude…”, never over it; the shell's `.notice` language, the actions in its link style):
 *
 * - PK-09 (AP-795): “New device signed in with a passkey: Pixel 9 · Android app” with Review (Settings · Devices,
 *   where it has Remove) and OK, once per new device;
 * - One passkey setup, with Not now, once per device key and Whombat after this browser was let in another way.
 *
 * Hidden on Settings (Devices shows both there). Nothing outside a managed Whombat or on a runtime without passkeys.
 */
import { Link } from '@tanstack/react-router';
import { createSeenDevices, PASSKEY_COPY, passkeyEnrolledDevices } from '@whombat/client/managed';
import { type ApplianceSession, sessionOps } from '@whombat/client/session';
import { useEffect, useState } from 'react';
import { useAppServices } from '../app/providers';
import type { ManagedContext } from '../app/services';
import styles from '../app/shell/ShellLayout.module.css';
import { cx } from '../components/cx';
import { StatusDot } from '../components/StatusDot';
import { useBackupPasskeyTap, useDeliverBackupKey } from './backupPasskey';
import { PASSKEY_NUDGE, PASSKEYS } from './passkeyEnv';

const SEEN_DEVICES = createSeenDevices(() => window.localStorage);

export function PasskeyNotices({ onSettings }: { onSettings: boolean }) {
  const { session, managed } = useAppServices();
  if (!managed) return null;
  return (
    <>
      <BackupKeyDelivery session={session} device={managed.applianceId} />
      {onSettings ? null : (
        <>
          <PasskeyNewDevice session={session} device={managed.applianceId} />
          <PasskeyNudge session={session} managed={managed} />
        </>
      )}
    </>
  );
}

/** A passkey sign-in's backup key, handed to the Whombat now its app is open (backup-passkey.md). */
function BackupKeyDelivery({ session, device }: { session: ApplianceSession; device: string }) {
  useDeliverBackupKey(session, device);
  return null;
}

/** The account this session acts as on the Whombat. */
function accountOf(session: ApplianceSession): string | null {
  const s = session.state();
  return s.status === 'open' ? (s.info.account?.id ?? null) : null;
}

function PasskeyNewDevice({ session, device }: { session: ApplianceSession; device: string }) {
  const [fresh, setFresh] = useState<{ endpointId: string; label: string } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([sessionOps.endpointsList(session), sessionOps.passkeysList(session)]).then(
      ([e, p]) => {
        if (!live) return;
        const found = passkeyEnrolledDevices(e.endpoints, p.passkeys);
        const next = e.endpoints.find(
          (d) => found.has(d.endpointId) && !SEEN_DEVICES.seen(device, d.endpointId),
        );
        setFresh(next ? { endpointId: next.endpointId, label: next.label } : null);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [session, device]);
  if (!fresh) return null;
  const seen = () => {
    SEEN_DEVICES.see(device, fresh.endpointId);
    setFresh(null);
  };
  return (
    <div className={styles.notice} role="status" data-testid="passkey-new-device">
      <StatusDot tone="warn" size={7} label={null} />
      <span className={styles.noticeText}>{PASSKEY_COPY.newDevice(fresh.label)}</span>
      <Link
        to="/settings"
        search={{ tab: 'appliance', section: 'devices' }}
        className={styles.noticeLink}
        onClick={seen}
      >
        {PASSKEY_COPY.review}
      </Link>
      <button type="button" className={cx(styles.noticeButton, styles.noticeQuiet)} onClick={seen}>
        {PASSKEY_COPY.seen}
      </button>
    </div>
  );
}

function PasskeyNudge({ session, managed }: { session: ApplianceSession; managed: ManagedContext }) {
  const device = managed.applianceId;
  const endpoint = managed.devicePeerId ?? '';
  const due = !!endpoint && !!managed.control && PASSKEY_NUDGE.shows(device, endpoint);
  const [shown, setShown] = useState(false);
  const tap = useBackupPasskeyTap();
  const busy = tap?.busy ?? false;
  const said = tap?.note;
  useEffect(() => {
    if (!due) return;
    let live = true;
    void (async () => {
      if (!(await PASSKEYS.isAvailable())) return;
      const list = await sessionOps.passkeysList(session).catch(() => null);
      if (!live || !list) return;
      // Already has one for this Whombat (made on another device, synced here): nothing to offer.
      const me = accountOf(session);
      if (list.passkeys.some((p) => p.accountId === me)) return PASSKEY_NUDGE.done(device, endpoint);
      setShown(true);
    })();
    return () => {
      live = false;
    };
  }, [due, session, device, endpoint]);
  const phase = tap?.view?.phase;
  const checking = tap?.busy ?? false;
  useEffect(() => {
    if (phase !== 'ready' || checking) return;
    PASSKEY_NUDGE.done(device, endpoint);
    setShown(false);
  }, [phase, checking, device, endpoint]);
  if (!shown || !managed.control || !tap) return null;
  const add = async () => {
    const result = await tap();
    if (result.complete) {
      PASSKEY_NUDGE.done(device, endpoint);
      setShown(false);
    }
  };
  return (
    <div className={styles.notice} role="status" data-testid="passkey-nudge">
      <StatusDot tone="mut" size={7} label={null} />
      <span className={styles.noticeText}>{said ?? tap.view?.meta ?? PASSKEY_COPY.nudge}</span>
      <button
        type="button"
        className={cx(styles.noticeButton, styles.noticeLink)}
        disabled={busy || (!tap.view && !tap.loadError)}
        onClick={() => void add()}
      >
        {tap.label}
      </button>
      <button
        type="button"
        className={cx(styles.noticeButton, styles.noticeQuiet)}
        disabled={busy || (!tap.view && !tap.loadError)}
        onClick={() => {
          PASSKEY_NUDGE.done(device, endpoint);
          setShown(false);
        }}
      >
        {PASSKEY_COPY.nudgeLater}
      </button>
    </div>
  );
}
