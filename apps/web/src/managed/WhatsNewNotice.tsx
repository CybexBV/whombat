/**
 * “Whombat updated · See what’s new”, once per update, in the shell's notice slot: a managed Whombat's last update
 * (`appliance.status` → `update.lastUpdate`) compared with the release this browser saw last (`whatsNewNotice`). The
 * first look only remembers, since there is nothing to compare with. The release is kept as seen as soon as the notice
 * shows (and when What's new is open), so it shows once; it stays on this page until See what’s new or Dismiss. An
 * open page asks for the status again when the box comes back after a drop, and every few seconds while an update is
 * being installed, which is how an update reaches it. Kept in this browser's storage, read afresh each time so two
 * pages don't both tell; where it can't be read the notice stays away rather than showing at every start.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  WHATS_NEW_PATH,
  WHATS_NEW_TEXT,
  whatsNewNotice,
  whatsNewPollMs,
  whatsNewSeenKey,
} from '@whombat/client/managed';
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
  const queryClient = useQueryClient();
  const id = managed?.applianceId;
  const status = useQuery({
    queryKey: APPLIANCE_STATUS_KEY,
    queryFn: () => sessionOps.applianceStatus(session),
    enabled: Boolean(id),
    staleTime: 5 * 60_000,
    retry: false,
    // While an update is being installed its last update changes when it is done: ask until then.
    refetchInterval: (query) => whatsNewPollMs(query.state.data),
  });
  // The box comes back after a drop (an update restarts it): ask again, so an open page hears of the update.
  useEffect(() => {
    if (!id) return;
    let wasOpen = session.state().status === 'open';
    return session.onState((s) => {
      const open = s.status === 'open';
      if (open && !wasOpen) void queryClient.invalidateQueries({ queryKey: APPLIANCE_STATUS_KEY });
      wasOpen = open;
    });
  }, [id, session, queryClient]);
  // Kept per Whombat: without its id there is nowhere to keep it, so no notice.
  const key = id ? whatsNewSeenKey(id) : null;
  // The notice on screen: it stays until it is tapped, though its release is already kept.
  const [shown, setShown] = useState<{ key: string; release: string } | null>(null);
  // Read from storage each time: another page of this browser may have shown the notice already.
  const seen = key ? readSeen(key) : undefined;
  const notice = status.data && seen !== undefined ? whatsNewNotice(status.data, seen) : null;
  const action = notice?.action;
  const release = notice?.release;
  useEffect(() => {
    if (!key || !release || action === 'none' || action === undefined) return;
    keepSeen(key, release);
    if (action === 'show' && !onWhatsNew) setShown({ key, release });
  }, [key, action, release, onWhatsNew]);
  // Reading What's new is what the notice asked for: it doesn't come back after.
  useEffect(() => {
    if (onWhatsNew) setShown(null);
  }, [onWhatsNew]);
  if (!key || shown?.key !== key || onWhatsNew) return null;
  const close = () => setShown(null);
  return (
    <div className={styles.notice} role="status" data-testid="whats-new-notice">
      <StatusDot tone="ok" size={7} label={null} />
      <span className={styles.noticeText}>{WHATS_NEW_TEXT.notice}</span>
      <Link to={WHATS_NEW_PATH as never} className={styles.noticeLink} onClick={close}>
        {WHATS_NEW_TEXT.see}
      </Link>
      <button type="button" className={cx(styles.noticeButton, styles.noticeQuiet)} onClick={close}>
        {WHATS_NEW_TEXT.dismiss}
      </button>
    </div>
  );
}
