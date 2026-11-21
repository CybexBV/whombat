import { PHONE_SIGNIN_PATH, type PhoneSignInLink, parsePhoneSignInLink } from '@whombat/client/managed';
import { useState } from 'react';
import { AuthLayout } from '../../app/auth/AuthLayout';
import { Button, ButtonLink } from '../../components/Button';
import { MOBILE_TEXT } from './copy';
import { DownloadCard, type DownloadLoader } from './DownloadCard';
import styles from './mobile.module.css';

/** The link this page load came with (memory only: a reload forgets it). */
let held: PhoneSignInLink | null = null;

/**
 * The QR code's link held for this page (AP-526): read once from the fragment, which then leaves the address bar and
 * history (like every secret link here). Never sent anywhere, never redeemed in a browser: only the app redeems it.
 */
export function takePhoneLink(
  loc: Pick<Location, 'href' | 'origin' | 'pathname' | 'hash'>,
): PhoneSignInLink | null {
  if (loc.pathname.replace(/\/+$/, '') !== PHONE_SIGNIN_PATH) return null;
  if (loc.hash) {
    held = parsePhoneSignInLink(loc.href, [loc.origin]);
    window.history.replaceState(null, '', PHONE_SIGNIN_PATH);
  }
  return held;
}

/** The same link in the app's scheme (`whombat://auth/phone#…`): opens the app where it is installed. */
export function appLink(link: PhoneSignInLink): string {
  const params = new URLSearchParams({ t: link.token, k: link.key });
  if (link.appliance) {
    params.set('d', link.appliance.device);
    params.set('p', link.appliance.peerId);
  }
  return `whombat:/${PHONE_SIGNIN_PATH}#${params.toString()}`;
}

/**
 * `/auth/phone` in a browser (AP-526): a phone without the app scanned the QR code with its camera, or someone opened
 * the link on a computer. Open it in the app, get the app, or scan it with the app. No sign-in needed; nothing here
 * uses the token.
 */
export function PhoneLinkPage({ loadDownload }: { loadDownload: DownloadLoader }) {
  const [link] = useState(() => takePhoneLink(window.location));
  const t = MOBILE_TEXT.landing;
  return (
    <AuthLayout kicker={t.kicker} title={t.title} sub={t.sub} tip={t.tip}>
      <div className={styles.stack}>
        <div className={styles.landingOpen}>
          {link ? (
            <ButtonLink variant="primary" size="xl" href={appLink(link)} data-testid="open-in-app">
              {t.open}
            </ButtonLink>
          ) : (
            <p className={styles.note} role="status">
              {t.broken}
            </p>
          )}
          <p className={styles.landingLine}>{t.noApp}</p>
        </div>
        <DownloadCard load={loadDownload} />
        <p className={styles.landingLine}>{t.computer}</p>
      </div>
    </AuthLayout>
  );
}

/**
 * `/mobile` without a sign-in (AP-526): the download for anyone, since the phone app's “Update the app” opens this
 * page in the phone's browser, and a phone there usually isn't signed in to the web. Signed in, `/mobile` is the QR page.
 */
export function PublicMobilePage({
  loadDownload,
  onSignIn,
}: {
  loadDownload: DownloadLoader;
  onSignIn: () => void;
}) {
  const t = MOBILE_TEXT.public;
  return (
    <AuthLayout kicker={MOBILE_TEXT.kicker} title={t.title} sub={t.sub} tip={t.tip}>
      <div className={styles.stack}>
        <DownloadCard load={loadDownload} />
        <div>
          <Button variant="secondary" size="md" onClick={onSignIn}>
            {t.signIn}
          </Button>
        </div>
      </div>
    </AuthLayout>
  );
}
