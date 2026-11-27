/**
 * The one-time “Whombat updated” notice in the strip under the status bar, beside the passkey nudge: once per update
 * of this Whombat, with See what’s new (the web app's page in the in-app browser) and Dismiss. Either one keeps the
 * release as seen; showing it doesn't, so a phone closed in between shows it again. It reads the status the Settings
 * list already asks for (same query), not a poll of its own.
 */
import { useQuery } from '@tanstack/react-query';
import { WHATS_NEW_TEXT } from '@whombat/client/managed';
import type { ApplianceSession } from '@whombat/client/session';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { secureStore } from '../lib/storage';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Button } from '../ui/primitives';
import { openSignInPage } from './openSignInPage';
import { applianceStatusQuery } from './useApplianceStatus';
import { WHATS_NEW_URL, whatsNewSeen, whatsNewToShow } from './whatsNew';

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
  const status = useQuery({ ...applianceStatusQuery({ session, cacheScope }), enabled: open }).data;
  const [shown, setShown] = useState<{ whombat: string; release: string } | null>(null);
  useEffect(() => {
    if (!status) return;
    let live = true;
    void whatsNewToShow(secureStore, whombat, status).then((release) => {
      if (live) setShown(release ? { whombat, release } : null);
    });
    return () => {
      live = false;
    };
  }, [status, whombat]);
  const release = shown?.whombat === whombat ? shown.release : null;
  return useMemo(() => {
    if (!release) return null;
    const seen = () => {
      setShown(null);
      void whatsNewSeen(secureStore, whombat, release);
    };
    return {
      see: () => {
        seen();
        void openSignInPage(WHATS_NEW_URL);
      },
      dismiss: seen,
    };
  }, [release, whombat]);
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
