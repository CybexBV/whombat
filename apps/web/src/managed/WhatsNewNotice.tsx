/**
 * “Whombat updated · See what’s new”, once per update, in the shell's notice slot: a managed Whombat's last update
 * (`appliance.status` → `update.lastUpdate`) compared with the release this browser saw last (`whatsNewNotice`). The
 * first look only remembers, since there is nothing to compare with. The release is kept as seen as soon as the notice
 * shows (and when What's new is open), so it shows once; it stays on this page until See what’s new or Dismiss. An
 * open page asks for the status again when the box comes back after a drop, and every few seconds while an update is
 * being installed (and for a short while after it is back, until it says how its updates stand), which is how an
 * update reaches it. Kept in this browser's storage with when the update was installed, so an older answer never goes
 * back to an earlier release; pages claim it in turn so only one tells; where it can't be read the notice stays away
 * rather than showing at every start.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  onSessionReopen,
  WHATS_NEW_PATH,
  WHATS_NEW_TEXT,
  whatsNewNotice,
  whatsNewRefetchInterval,
  whatsNewSeenKey,
} from '@whombat/client/managed';
import { sessionOps } from '@whombat/client/session';
import { useEffect, useRef, useState } from 'react';
import { useAppServices } from '../app/providers';
import styles from '../app/shell/ShellLayout.module.css';
import { cx } from '../components/cx';
import { StatusDot } from '../components/StatusDot';
import { APPLIANCE_STATUS_KEY } from '../features/settings/version';
import { whatsNewOpensFresh } from '../features/whatsNew/freshPage';

/** The release this browser saw for a Whombat: undefined where its storage can't be read. */
function readSeen(key: string): string | null | undefined {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return undefined;
  }
}

/** Keeps what this browser saw; false when it can't (storage full or refused). */
function keepSeen(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decides again from what this browser keeps now and keeps the update as seen when it is new to it: true when this
 * page should tell. Pages that hear of an update at the same moment ask in turn (the browser's lock, where it has one),
 * so one tells; a page gone before its turn keeps nothing, so another can tell, and an older answer (a page still
 * holding a status from before the update) never replaces a newer one.
 */
async function claimRelease(
  key: string,
  status: Parameters<typeof whatsNewNotice>[0],
  tell: boolean,
  live: () => boolean,
): Promise<boolean> {
  const take = () => {
    if (!live()) return false;
    const seen = readSeen(key);
    if (seen === undefined) return false;
    const notice = whatsNewNotice(status, seen);
    if (notice.action === 'none') return false;
    // Not kept, it would tell again at every start: it says nothing, as when storage can't be read.
    if (!keepSeen(key, notice.value)) return false;
    return tell && notice.action === 'show';
  };
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) return take();
  try {
    return await locks.request(`${key}.lock`, take);
  } catch {
    return take();
  }
}

export function WhatsNewNotice({ onWhatsNew }: { onWhatsNew: boolean }) {
  const { managed, session } = useAppServices();
  const queryClient = useQueryClient();
  const id = managed?.applianceId;
  // When the box's session last opened again: for a short while after, a status without update facts is asked again.
  const backAt = useRef(0);
  const status = useQuery({
    queryKey: APPLIANCE_STATUS_KEY,
    queryFn: () => sessionOps.applianceStatus(session),
    enabled: Boolean(id),
    staleTime: 5 * 60_000,
    retry: false,
    // While an update is being installed its last update changes when it is done: ask until then.
    refetchInterval: whatsNewRefetchInterval(() => backAt.current),
  });
  // The box comes back after a drop (an update restarts it): ask again, so an open page hears of the update.
  useEffect(() => {
    if (!id) return;
    // Already open: the first answer gets the same second chance as one after a drop.
    if (session.state().status === 'open') backAt.current = Date.now();
    return onSessionReopen(session, () => {
      backAt.current = Date.now();
      void queryClient.invalidateQueries({ queryKey: APPLIANCE_STATUS_KEY });
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
  const data = status.data;
  useEffect(() => {
    if (!key || !data || !release || action === 'none' || action === undefined) return;
    let live = true;
    void claimRelease(key, data, action === 'show' && !onWhatsNew, () => live).then((mine) => {
      if (live && mine) setShown({ key, release });
    });
    return () => {
      live = false;
    };
  }, [key, data, action, release, onWhatsNew]);
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
      <Link
        to={WHATS_NEW_PATH as never}
        reloadDocument={whatsNewOpensFresh()}
        className={styles.noticeLink}
        onClick={close}
      >
        {WHATS_NEW_TEXT.see}
      </Link>
      <button type="button" className={cx(styles.noticeButton, styles.noticeQuiet)} onClick={close}>
        {WHATS_NEW_TEXT.dismiss}
      </button>
    </div>
  );
}
