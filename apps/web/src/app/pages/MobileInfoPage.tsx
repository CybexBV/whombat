import { Link, useCanGoBack, useRouter } from '@tanstack/react-router';
import { MOBILE_TEXT, MobilePage, SeeDevicesLink, usePhoneAppSources } from '../../features/mobile';

/**
 * `/mobile` where it keeps its own page: signed out of a Whombat (fixture mode, the self-hosted server), sign a phone in
 * by QR code and get the app (AP-521). With a Whombat open the route sends the person to Settings → Phone app, inside
 * the app (settings-phone-link.md SPL-23). Back returns to the page the person came from, or to the start when they
 * opened this address directly.
 */
export function MobileInfoPage() {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const { signIn, whombatName, loadDownload } = usePhoneAppSources();
  return (
    <MobilePage
      signIn={signIn}
      whombatName={whombatName}
      loadDownload={loadDownload}
      back={
        <Link
          to="/"
          onClick={(e) => {
            if (!canGoBack) return;
            e.preventDefault();
            router.history.back();
          }}
        >
          {MOBILE_TEXT.back}
        </Link>
      }
      devices={<SeeDevicesLink />}
    />
  );
}
