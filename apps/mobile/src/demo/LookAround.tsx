/**
 * “Look around without a Whombat” (docs/app/decisions/look-around.md): the first screen opens the demo world, the one a
 * demo build shows (Burrow HQ on an in-memory box, `DemoRoot`), inside the app everyone installs. Every screen carries
 * one strip under the status bar saying it is a demo, with Leave, which goes back to the first screen. Nothing reaches a
 * Whombat or Whombat's servers: the demo world answers inside the phone, and leaving forgets what was done in it.
 */
import { useState } from 'react';
import { View } from 'react-native';
import { mobileTranslator, useI18n } from '../i18n';
import { managedCopy } from '../managed/copy';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ScreenStripContext } from '../ui/headers';
import { Button } from '../ui/primitives';

/** The web's words (`COPY.lookAround`), with a shorter button for the phone's strip. */
export function lookAroundText(locale?: string) {
  const look = managedCopy(locale).lookAround;
  return {
    strip: look.notice,
    leave: mobileTranslator(locale).t('demo.leave'),
    leaveLabel: look.leave,
  };
}

export const LOOK_AROUND_TEXT = lookAroundText();

/** The strip every demo screen shows: the strip's look (`ApplianceRoot`'s `StripLine`), with the way back. */
function DemoStrip({ onLeave }: { onLeave: () => void }) {
  const { rawLocale } = useI18n();
  const text = lookAroundText(rawLocale);
  const theme = useTheme();
  return (
    <View
      style={{
        marginTop: 4,
        marginHorizontal: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingLeft: 14,
        paddingRight: 4,
        minHeight: 48,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sf,
      }}
    >
      <Text size={13.5} lh={1.35} color={theme.colors.ink2} style={{ flex: 1, paddingVertical: 8 }}>
        {text.strip}
      </Text>
      <Button label={text.leave} variant="quiet" accessibilityLabel={text.leaveLabel} onPress={onLeave} />
    </View>
  );
}

export function LookAround({ onLeave }: { onLeave: () => void }) {
  // The demo world loads only when someone opens it: the app's own start stays as it is (AP-920).
  const [DemoRoot] = useState(() => (require('./DemoRoot') as typeof import('./DemoRoot')).DemoRoot);
  return (
    <ScreenStripContext.Provider value={<DemoStrip onLeave={onLeave} />}>
      <DemoRoot />
    </ScreenStripContext.Provider>
  );
}
