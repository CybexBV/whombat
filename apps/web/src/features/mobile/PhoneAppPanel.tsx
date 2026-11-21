/**
 * Settings → Phone app (`/settings?tab=phone`; docs/decisions/settings-phone-link.md SPL-23): signing a phone in by its
 * code and getting the app, inside the app like every Settings page — the sidebar beside it, Back to Settings above its
 * title. The same body as `/mobile`, which keeps the sign-in frame only where no Whombat is open.
 */
import { createLink } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useAppServices } from '../../app/providers';
import { ButtonLink } from '../../components/Button';
import { MOBILE_TEXT } from './copy';
import { type DownloadLoader, useAndroidDownload } from './DownloadCard';
import { PhoneAppBody } from './MobilePage';
import styles from './mobile.module.css';
import { FIXTURE_DOWNLOAD, phoneSignInDeps, publicAndroidDownload } from './sources';
import type { PhoneSignInDeps } from './usePhoneSignIn';

const RouterButtonLink = createLink(ButtonLink);

/**
 * What the page needs from the open Whombat: signing a phone in to it (a box with control behind it; null where the app
 * signs in with email), its name, and where the Android download is asked.
 */
export function usePhoneAppSources(): {
  signIn: PhoneSignInDeps | null;
  whombatName: string | null;
  loadDownload: DownloadLoader;
} {
  const { managed, session, fixtures } = useAppServices();
  const control = managed?.control;
  const signIn = useMemo(
    () =>
      control && managed
        ? phoneSignInDeps(control, session, { device: managed.applianceId, peerId: managed.appliancePeerId })
        : null,
    [control, managed, session],
  );
  const loadDownload = useMemo<DownloadLoader>(
    () =>
      control
        ? () => control.androidDownload()
        : fixtures
          ? () => Promise.resolve(FIXTURE_DOWNLOAD)
          : publicAndroidDownload,
    [control, fixtures],
  );
  return { signIn, whombatName: managed?.applianceName ?? null, loadDownload };
}

/** Once a phone is in: Settings → Devices, where it is removed. */
export function SeeDevicesLink() {
  return (
    <RouterButtonLink variant="secondary" size="lg" to="/settings" search={{ part: 'devices' } as never}>
      {MOBILE_TEXT.signIn.seeDevices}
    </RouterButtonLink>
  );
}

/** The page's body under Settings' title and intro: the code card, Get the app, and the reassurance about signing in. */
export function PhoneAppPanel() {
  const { signIn, whombatName, loadDownload } = usePhoneAppSources();
  const download = useAndroidDownload(loadDownload);
  return (
    <div className={styles.inApp} data-phone-app="">
      <PhoneAppBody
        signIn={signIn}
        whombatName={whombatName}
        download={download}
        devices={<SeeDevicesLink />}
      >
        <p className={styles.inAppTip}>{signIn ? MOBILE_TEXT.tip : MOBILE_TEXT.tipSelfHosted}</p>
      </PhoneAppBody>
    </div>
  );
}
