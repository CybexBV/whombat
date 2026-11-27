/**
 * A conversation's pinned messages (Whombat essentials item 14; CT-174; not mocked; AP-509): opened from the header's
 * “More”, newest pin first, each as the author's row with the message's first lines and who pinned it when. A tap on
 * a reply opens its thread at the reply; on a top-level message it goes back to the conversation, at the message
 * (MX-03). Unpin is on the message's own long-press menu.
 */

import { CommonActions } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { usePins } from '@whombat/client/react';
import { formatRecent, MESSAGE_DELETED_TEXT, type Message } from '@whombat/core';
import { RefreshControl, ScrollView, View } from 'react-native';
import { PrincipalAvatar } from '../avatars/Avatars';
import { useBurrowBase, useViewContext } from '../data/BurrowProvider';
import { pinnedMessageOpen } from '../data/chatScroll';
import { useI18n, useMobileT } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { useTheme } from '../theme/theme';
import { BackBar, LargeTitle, Screen } from '../ui/headers';
import { ListRow } from '../ui/ListRow';
import { ErrorState, QuietText, Section, SkeletonRows } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';

type Props = NativeStackScreenProps<RootStackParamList, 'Pins'>;

/** The first lines of a pinned message: its text, else what it carries. */
function pinnedText(m: Message): string {
  if (m.deletedAt) return MESSAGE_DELETED_TEXT;
  if (m.text.trim()) return m.text.trim();
  if (m.card) return 'A card';
  return m.attachments.length ? `${m.attachments.length} file${m.attachments.length === 1 ? '' : 's'}` : '';
}

export function PinsScreen({ route, navigation }: Props) {
  const { rawLocale, tClient } = useI18n();

  const { t: tMobile } = useMobileT();
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const { slug, people } = useBurrowBase();
  const ctx = useViewContext();
  const { conversationId, title } = route.params;
  const pins = usePins({ params: { burrow: slug, conversationId } });
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));
  const messages = pins.data?.messages ?? [];
  const open = (m: Message) => {
    const state = navigation.getState();
    const below = state.routes[state.index - 1];
    const to = pinnedMessageOpen(m, conversationId, below?.name);
    if (to.kind === 'thread')
      navigation.navigate('Thread', { messageId: to.messageId, back: 'Pinned', anchor: to.anchor });
    else if (to.kind === 'conversation')
      navigation.navigate('Conversation', { conversationId: to.conversationId, anchor: to.anchor });
    else if (below) {
      // The conversation below opens at the message as this screen goes.
      navigation.dispatch({ ...CommonActions.setParams({ anchor: to.anchor }), source: below.key });
      navigation.goBack();
    }
  };

  return (
    <Screen>
      <BackBar label={title} onPress={goBack} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 20 + bottomRoom }}
        refreshControl={
          <RefreshControl
            refreshing={pins.isRefetching}
            onRefresh={() => void pins.refetch()}
            colors={[theme.colors.ink]}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <LargeTitle title={tClient('overview.tab.pinned')} />
        <View style={{ height: 10 }} />
        {pins.isPending ? (
          <SkeletonRows count={4} avatarSize={44} label={tMobile('screens.loading-pinned-messages')} />
        ) : pins.error && !pins.data ? (
          <ErrorState
            text={tMobile('screens.pinned-messages-didnt-load')}
            onRetry={() => void pins.refetch()}
          />
        ) : messages.length === 0 ? (
          <QuietText>{tMobile('screens.nothing-is-pinned-here-yet-long-press-a')}</QuietText>
        ) : (
          <Section title={`PINNED · ${messages.length}`}>
            {messages.map((m) => {
              const name = people.name(m.authorId);
              const text = pinnedText(m);
              const pinnedBy = m.pinnedById ? people.name(m.pinnedById) : null;
              const when = m.pinnedAt ? formatRecent(m.pinnedAt, ctx.now, ctx.timeZone, rawLocale) : null;
              const meta = [pinnedBy ? `pinned by ${pinnedBy}` : null, when].filter(Boolean).join(' · ');
              return (
                <ListRow
                  key={m.id}
                  leading={<PrincipalAvatar principal={people.get(m.authorId)} size={44} />}
                  title={name}
                  meta={meta}
                  trailing={formatRecent(m.createdAt, ctx.now, ctx.timeZone, rawLocale)}
                  body={text}
                  accessibilityLabel={`${name}: ${text}. ${meta}`}
                  onPress={() => open(m)}
                />
              );
            })}
          </Section>
        )}
      </ScrollView>
    </Screen>
  );
}
