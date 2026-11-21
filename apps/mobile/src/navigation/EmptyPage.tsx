/**
 * The right page while nothing is open there (docs/app/decisions/iphone-duo.md): beside Chat a new chat, elsewhere one
 * quiet line saying what to pick in the list, so the page doesn't look broken.
 */
import { View } from 'react-native';
import type { Tab } from '../data/shell';
import { NewChatPage } from '../screens/ChatRoomScreen';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Screen } from '../ui/headers';

export const EMPTY_PAGE_WORDS: Record<Exclude<Tab, 'ChatRoom'>, string> = {
  NeedsYou: 'Pick something to see it here.',
  Dashboard: 'Pick a server or a connection to see it here.',
  Automations: 'Pick an automation to see what it does.',
  Settings: 'Pick a setting to see it here.',
};

export function EmptyPage({ tab }: { tab: Tab }) {
  const theme = useTheme();
  if (tab === 'ChatRoom') return <NewChatPage />;
  return (
    <Screen>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
        <Text size={15} color={theme.colors.mut} style={{ textAlign: 'center' }}>
          {EMPTY_PAGE_WORDS[tab]}
        </Text>
      </View>
    </Screen>
  );
}
