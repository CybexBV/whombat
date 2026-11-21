/**
 * The reason before Android's question (MN-05): a card at the top of the inbox while notifications haven't been asked
 * for — what they are for, “Turn on” (then the system dialog) and “Not now”. The grouped-list card of the inbox
 * (20dp radius, `sf`, `line`), 44dp buttons like the passkey nudge's. Nothing when there is nothing to ask.
 */
import { useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Button } from '../ui/primitives';
import { PUSH_PROMPT_COPY } from './prompt';
import { pushPrompt } from './promptStore';

export function PushRationaleCard() {
  const theme = useTheme();
  const state = useSyncExternalStore(pushPrompt.subscribe, pushPrompt.state);
  if (!state.shown) return null;
  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
      <View
        style={{
          borderRadius: 20,
          borderWidth: 1,
          borderColor: theme.colors.line,
          backgroundColor: theme.colors.sf,
          paddingTop: 14,
          paddingBottom: 8,
          paddingLeft: 16,
          paddingRight: 8,
          gap: 4,
        }}
      >
        <Text size={15} weight={600} style={{ paddingRight: 8 }}>
          {PUSH_PROMPT_COPY.title}
        </Text>
        <Text size={13.5} lh={1.45} color={theme.colors.ink2} style={{ paddingRight: 8 }}>
          {PUSH_PROMPT_COPY.text}
        </Text>
        <View style={{ flexDirection: 'row', gap: 4, justifyContent: 'flex-end', paddingTop: 6 }}>
          <Button
            label={PUSH_PROMPT_COPY.notNow}
            variant="quiet"
            disabled={state.busy}
            onPress={() => void pushPrompt.notNow()}
          />
          <Button
            label={PUSH_PROMPT_COPY.turnOn}
            variant="secondary"
            busy={state.busy}
            onPress={() => void pushPrompt.turnOn()}
          />
        </View>
      </View>
    </View>
  );
}
