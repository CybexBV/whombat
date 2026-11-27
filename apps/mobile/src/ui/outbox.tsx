/**
 * Messages waiting to send (AP-717), above the composer: the viewer's own message as a flat row (AP-706), faded, with “Waiting to send” (or
 * “Sending…”) under it; one that wasn't sent says why in `bad`, with Retry and Delete (44dp each).
 */

import { View } from 'react-native';
import { useOutbox } from '../data/OutboxProvider';
import { outboxLabel } from '../data/outbox';
import { useI18n, useMobileT } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { MessageBody } from './chat';
import { CHAT_GUTTER } from './insets';
import { Button } from './primitives';

export function OutboxRows({
  conversationId,
  threadRootId = null,
}: {
  conversationId: string | null;
  threadRootId?: string | null;
}) {
  const { t: tMobile } = useMobileT();
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const { items, retry, remove } = useOutbox(conversationId, threadRootId);
  if (items.length === 0) return null;
  return (
    <View style={{ gap: 14, paddingHorizontal: CHAT_GUTTER, paddingTop: 6, paddingBottom: 10 }}>
      {items.map((item) => {
        const failed = item.state === 'failed';
        const label = outboxLabel(item, rawLocale);
        return (
          <MessageBody key={item.id} text={item.text} sending>
            <View accessible accessibilityLabel={label} accessibilityLiveRegion="polite">
              <Text size={12} weight={500} mono color={failed ? theme.colors.bad : theme.colors.mut}>
                {label}
              </Text>
            </View>
            {failed ? (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button
                  label={tMobile('ui.delete')}
                  variant="quiet"
                  onPress={() => remove(item.id)}
                  accessibilityHint={tMobile('ui.deletes-this-message-without-sending-it')}
                  style={{ paddingHorizontal: 16 }}
                />
                <Button
                  label={tMobile('ui.retry')}
                  variant="secondary"
                  onPress={() => retry(item.id)}
                  accessibilityHint={tMobile('ui.sends-this-message-again')}
                  style={{ paddingHorizontal: 18 }}
                />
              </View>
            ) : null}
          </MessageBody>
        );
      })}
    </View>
  );
}
