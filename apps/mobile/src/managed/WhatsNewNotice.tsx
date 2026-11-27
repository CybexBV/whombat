/**
 * The one-time “Whombat updated” notice in the strip under the status bar, under the passkey nudge when that shows
 * too: once per update of this Whombat, with See what’s new (the web app's page in the in-app browser) and Dismiss.
 * The release is kept as seen as soon as it shows; the notice stays until one of the two is tapped. It reads the status
 * the Settings list already asks for (same query), again whenever the session opens after a drop and every few
 * seconds while an update is being installed; no poll of its own otherwise.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { WHATS_NEW_TEXT, whatsNewRefetchInterval } from '@whombat/client/managed';
import type { ApplianceSession } from '@whombat/client/session';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { secureStore } from '../lib/storage';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Button } from '../ui/primitives';
import { openSignInPage } from './openSignInPage';
import { applianceStatusQuery } from './useApplianceStatus';
import { markWhatsNewTold, WHATS_NEW_URL, watchStatusOnReopen, whatsNewWatcher } from './whatsNew';

export interface WhatsNewNoticeState {
  see: () => void;
  dismiss: () => void;
}

export function useWhatsNewNotice({
  session,
  cacheScope,
  whombat,
  open,
}: {
  session: ApplianceSession;
  cacheScope: string;
  /** The Whombat's own id (its device id): what this phone saw is kept per Whombat. */
  whombat: string;
  /** The session is open: asked before, a failed read would keep the notice away until Settings asks again. */
  open: boolean;
}): WhatsNewNoticeState | null {
  const queryClient = useQueryClient();
  // When the session last opened again: for a short while after, a status without update facts is asked again.
  const backAt = useRef<() => number>(() => 0);
  // While an update is being installed its last update changes when it is done: ask until then.
  const status = useQuery({
    ...applianceStatusQuery({ session, cacheScope }),
    enabled: open,
    refetchInterval: whatsNewRefetchInterval(() => backAt.current()),
  }).data;
  // The box comes back after a drop (an update restarts it): ask again at once, however fresh the last answer.
  useEffect(() => {
    const watch = watchStatusOnReopen(
      session,
      queryClient,
      applianceStatusQuery({ session, cacheScope }).queryKey,
    );
    backAt.current = watch.backAt;
    return watch.stop;
  }, [session, queryClient, cacheScope]);
  const [shown, setShown] = useState<{ whombat: string; release: string } | null>(null);
  // One watcher per Whombat: a refreshed answer doesn't cancel the notice an earlier one is about to show.
  const watcher = useRef<ReturnType<typeof whatsNewWatcher> | null>(null);
  useEffect(() => {
    const watch = whatsNewWatcher(secureStore, whombat, (release) => setShown({ whombat, release }));
    watcher.current = watch;
    return () => {
      watch.stop();
      if (watcher.current === watch) watcher.current = null;
    };
  }, [whombat]);
  // A later read says nothing (the release is kept already): what shows stays until it is tapped.
  useEffect(() => {
    watcher.current?.see(status);
  }, [status]);
  const release = shown?.whombat === whombat ? shown.release : null;
  // The strip draws it while the session is open (`stripNotices`): only then is it told, so one found while the
  // connection is down still shows after the app is closed or another Whombat opened.
  useEffect(() => {
    if (open && release) void markWhatsNewTold(secureStore, whombat, release);
  }, [open, release, whombat]);
  return useMemo(() => {
    if (!release) return null;
    const close = () => setShown(null);
    return {
      see: () => {
        close();
        void openSignInPage(WHATS_NEW_URL);
      },
      dismiss: close,
    };
  }, [release]);
}

/** Drawn as the passkey nudge is: a calm card with its sentence and the two buttons under it. */
export function WhatsNewNoticeView({ notice }: { notice: WhatsNewNoticeState }) {
  const theme = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        marginTop: 4,
        marginHorizontal: 12,
        paddingLeft: 14,
        paddingRight: 4,
        paddingVertical: 4,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sf,
      }}
    >
      <Text size={13.5} lh={1.35} color={theme.colors.ink2} style={{ paddingVertical: 8 }}>
        {WHATS_NEW_TEXT.notice}
      </Text>
      <View style={{ flexDirection: 'row', gap: 4, justifyContent: 'flex-end' }}>
        <Button label={WHATS_NEW_TEXT.see} variant="secondary" onPress={notice.see} />
        <Button label={WHATS_NEW_TEXT.dismiss} variant="quiet" onPress={notice.dismiss} />
      </View>
    </View>
  );
}
