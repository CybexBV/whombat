/**
 * “Whombat updated · See what’s new”, once per update, in the shell's notice slot: a managed Whombat's last update
 * (`appliance.status` → `update.lastUpdate`) compared with the release this browser saw last (`whatsNewNotice`). The
 * first look only remembers, since there is nothing to compare with; See what’s new, Dismiss or opening What's new keeps
 * the release, so the notice comes back only with the next update. Kept in this browser's storage; where it can't be
 * read the notice stays away rather than showing at every start.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { WHATS_NEW_PATH, WHATS_NEW_TEXT, whatsNewNotice, whatsNewSeenKey } from '@whombat/client/managed';
import { sessionOps } from '@whombat/client/session';
import { useEffect, useState } from 'react';
import { useAppServices } from '../app/providers';
import styles from '../app/shell/ShellLayout.module.css';
import { cx } from '../components/cx';
import { StatusDot } from '../components/StatusDot';
import { APPLIANCE_STATUS_KEY } from '../features/settings/version';

/** The release this browser saw for a Whombat: undefined where its storage can't be read. */
function readSeen(key: string): string | null | undefined {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return undefined;
  }
}

function keepSeen(key: string, release: string) {
  try {
    window.localStorage.setItem(key, release);
  } catch {
    // Nowhere to keep it: the notice simply goes away for this page.
  }
}

export function WhatsNewNotice({ onWhatsNew }: { onWhatsNew: boolean }) {
  const { managed, session } = useAppServices();
  const status = useQuery({
    queryKey: APPLIANCE_STATUS_KEY,
    queryFn: () => sessionOps.applianceStatus(session),
    enabled: Boolean(managed?.applianceId),
    staleTime: 5 * 60_000,
    retry: false,
  });
  // Kept per Whombat: without its id there is nowhere to keep it, so no notice.
  const key = managed?.applianceId ? whatsNewSeenKey(managed.applianceId) : null;
  // What this page kept (or found kept), so the notice follows a click at once.
  const [kept, setKept] = useState<string | null>(null);
  const seen = key ? readSeen(key) : undefined;
  const notice = status.data && seen !== undefined ? whatsNewNotice(status.data, kept ?? seen) : null;
  const action = notice?.action;
  const release = notice?.release;
  // The first look and reading What's new itself both count as having seen it.
  useEffect(() => {
    if (!key || !release) return;
    if (action === 'remember' || (action === 'show' && onWhatsNew)) {
      keepSeen(key, release);
      setKept(release);
    }
  }, [key, action, release, onWhatsNew]);
  if (!key || !release || action !== 'show' || onWhatsNew) return null;
  const done = () => {
    keepSeen(key, release);
    setKept(release);
  };
  return (
    <div className={styles.notice} role="status" data-testid="whats-new-notice">
      <StatusDot tone="ok" size={7} label={null} />
      <span className={styles.noticeText}>{WHATS_NEW_TEXT.notice}</span>
      <Link to={WHATS_NEW_PATH as never} className={styles.noticeLink} onClick={done}>
        {WHATS_NEW_TEXT.see}
      </Link>
      <button type="button" className={cx(styles.noticeButton, styles.noticeQuiet)} onClick={done}>
        {WHATS_NEW_TEXT.dismiss}
      </button>
    </div>
  );
}
