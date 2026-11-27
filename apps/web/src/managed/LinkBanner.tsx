/**
 * The line while Whombat Link ends or after it ended (Whombat docs/decisions/whombat-link.md): what still works, and
 * **Turn on Tailscale** (a real button) as the way in from away while Tailscale isn't on. Turning it on happens right here; while
 * Tailscale waits for a sign-in, the line offers Tailscale's own page. A full-width line in the shell's notice slot, so
 * it never covers the app's own top line. Asked when the app opens and every ten minutes; nothing while Link is on or
 * off, on a box before Link, or outside a managed Whombat.
 */
import {
  type HostTailscaleOutput,
  TAILSCALE_TEXT,
  tailscaleAnswer,
  tailscaleApi,
  tailscaleErrorText,
  tailscaleView,
} from '@whombat/client';
import { linkBannerView, REACH_TEXT, readReach } from '@whombat/client/managed';
import type { ApplianceSession } from '@whombat/client/session';
import type { ReachGetOutput } from '@whombat/protocol/session';
import { useEffect, useMemo, useState } from 'react';
import { useAppServices } from '../app/providers';
import styles from '../app/shell/ShellLayout.module.css';
import { Button, ButtonLink } from '../components/Button';
import { StatusDot } from '../components/StatusDot';
import { useWebI18n } from '../i18n/provider';

const REACH_POLL_MS = 10 * 60_000;

export function LinkBanner() {
  const { session, managed } = useAppServices();
  if (!managed) return null;
  return <LinkLine session={session} />;
}

function LinkLine({ session }: { session: ApplianceSession }) {
  const { tag: uiLocale } = useWebI18n();
  const [reach, setReach] = useState<ReachGetOutput | null>(null);
  const [tailscale, setTailscale] = useState<HostTailscaleOutput | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const api = useMemo(() => tailscaleApi(session), [session]);
  useEffect(() => {
    let live = true;
    const ask = () =>
      readReach(session).then(
        (r) => live && setReach(r),
        () => {},
      );
    void ask();
    const timer = setInterval(() => void ask(), REACH_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [session]);
  // Once turned on here, Tailscale is followed until it is on (its sign-in link shows meanwhile).
  const t = tailscaleView(tailscale);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each answer asks again after its own wait.
  useEffect(() => {
    if (!t.pollMs) return;
    const timer = setTimeout(() => {
      api.state().then(setTailscale, () => {});
    }, t.pollMs);
    return () => clearTimeout(timer);
  }, [t.pollMs, tailscale, api]);

  const followed = tailscale?.tailscale ?? null;
  const banner = linkBannerView(reach && (followed ? { ...reach, tailscale: followed } : reach), uiLocale);
  if (!banner) return null;
  const turnOn = async () => {
    setBusy(true);
    setNote(null);
    try {
      setTailscale(tailscaleAnswer(await api.on()));
    } catch (error) {
      setNote(tailscaleErrorText(error));
    } finally {
      setBusy(false);
    }
  };
  const signIn = followed?.state === 'needs_sign_in' ? t.loginUrl : null;
  return (
    <div className={styles.notice} role="status" data-testid="link-strip">
      <StatusDot tone={banner.tone === 'bad' ? 'bad' : 'warn'} size={7} label={null} />
      <span className={styles.noticeText}>{note ?? banner.text}</span>
      {/* A real button, not the notice's quiet link: the one way in from away when Link ends must not look disabled. */}
      {signIn ? (
        <ButtonLink variant="secondary" size="sm" href={signIn} target="_blank" rel="noopener noreferrer">
          {TAILSCALE_TEXT.openSignIn}
        </ButtonLink>
      ) : banner.tailscale && !followed ? (
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void turnOn()}>
          {REACH_TEXT.tailscale.turnOn}
        </Button>
      ) : null}
    </div>
  );
}
