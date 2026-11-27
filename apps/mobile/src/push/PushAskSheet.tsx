/**
 * The one question about notifications, with its reason (docs/app/decisions/mobile-reach.md): a sheet over whatever the
 * first open after sign-in shows, only where the phone must ask before an app notifies and hasn't (Android 13 and
 * later; `pushStart` says `sheet`). The bell, “Get a ping when {Agent} needs you?”, one line on what Whombat sends,
 * then Turn on (Android's question follows) and Not now. Closing it counts as Not now: it isn't shown again on this
 * phone, and Settings → Notifications keeps Turn on. Nothing when there is nothing to ask.
 */
import { useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { useTheAgentHere } from '../data/useAgent';
import { useI18n } from '../i18n';
import { IconTile } from '../managed/ui';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Bell } from '../ui/icons';
import { Button } from '../ui/primitives';
import { Sheet } from '../ui/sheet';
import { pushPromptCopy } from './prompt';
import { pushPrompt } from './promptStore';

export function PushAskSheet() {
  const theme = useTheme();
  const state = useSyncExternalStore(pushPrompt.subscribe, pushPrompt.state);
  const { rawLocale } = useI18n();
  const copy = pushPromptCopy(useTheAgentHere()?.name, rawLocale);
  return (
    <Sheet visible={state.shown} onClose={() => void pushPrompt.notNow()} label={copy.title} surface="sf">
      <View style={{ paddingHorizontal: 22, paddingTop: 4, paddingBottom: 8, gap: 18 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 14 }}>
          <IconTile icon={Bell} />
          <View style={{ flex: 1, gap: 6 }}>
            <Text size={18} weight={700} lh={1.3} accessibilityRole="header">
              {copy.title}
            </Text>
            <Text size={15} lh={1.5} color={theme.colors.ink2}>
              {copy.text}
            </Text>
          </View>
        </View>
        <View style={{ gap: 10 }}>
          <Button label={copy.turnOn} size="lg" busy={state.busy} onPress={() => void pushPrompt.turnOn()} />
          <Button
            label={copy.notNow}
            variant="quiet"
            size="lg"
            disabled={state.busy}
            onPress={() => void pushPrompt.notNow()}
          />
        </View>
      </View>
    </Sheet>
  );
}
