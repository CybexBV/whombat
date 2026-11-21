/**
 * “Your desk screen wants to unlock” at the top of This Whombat (Whombat desk-display.md DK-04; desk-display-android.md
 * AP-3054): someone at the paired screen pressed “Confirm on your phone”. It shows from the request until it is
 * answered here or elsewhere or its two minutes are over: an amber dot, the words, “Ends in 2 min.”
 * counting down, and Unlock (filled) · No, 44dp side by side. The push about it (kind `security`, the “Needs you”
 * channel) opens This Whombat, where this is. Words: `DESK_TEXT.unlock`.
 */
import { DESK_TEXT, type DeskApi, deskUnlockAnswerText } from '@whombat/client/desk';
import { useDeskActions, useDeskUnlockRequest } from '@whombat/client/desk/react';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { showNotice } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Button } from '../ui/primitives';
import { Card } from './ui';

const U = DESK_TEXT.unlock;

export function DeskUnlockCard({ api }: { api: DeskApi | null }) {
  const theme = useTheme();
  const request = useDeskUnlockRequest(api);
  const actions = useDeskActions(api);
  const [busy, setBusy] = useState<'unlock' | 'no' | null>(null);
  if (!request) return null;
  const answer = async (unlock: boolean) => {
    setBusy(unlock ? 'unlock' : 'no');
    try {
      await actions.answerUnlock({ id: request.id, unlock });
      showNotice(deskUnlockAnswerText(unlock));
    } catch (error) {
      Alert.alert('That didn’t go through', deskUnlockAnswerText(unlock, error));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card>
      <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 14, paddingHorizontal: 16 }}>
        {/* The title says it; the dot is its colour only (as NEEDS YOU's rows). */}
        <View
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{ width: 8, height: 8, borderRadius: 4, marginTop: 7, backgroundColor: theme.colors.warn }}
        />
        <View style={{ flex: 1, gap: 3 }}>
          <Text size={15} weight={600} lh={1.35} accessibilityRole="header">
            {U.title}
          </Text>
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {U.meta(request.secondsLeft)}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 9 }}>
            <Button
              label={U.unlock}
              busy={busy === 'unlock'}
              disabled={busy !== null}
              onPress={() => void answer(true)}
              style={{ flex: 1 }}
            />
            <Button
              label={U.no}
              variant="secondary"
              busy={busy === 'no'}
              disabled={busy !== null}
              onPress={() => void answer(false)}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      </View>
    </Card>
  );
}
