/**
 * The right page while nothing is open there (docs/app/decisions/iphone-duo.md): beside Chat a new chat, elsewhere one
 * quiet line saying what to pick in the list, so the page doesn't look broken. Beside Servers or Connections only once
 * the person closed what was open: the place opens on a row by itself.
 */
import type { ThingPlace } from '@whombat/client';
import { View } from 'react-native';
import { PLACE_PICK } from '../data/places';
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

export function EmptyPage({
  tab,
  place = null,
  waiting = false,
}: {
  tab: Tab;
  place?: ThingPlace | null;
  /** A place that hasn't opened its first page yet: blank, as it is about to fill. */
  waiting?: boolean;
}) {
  const theme = useTheme();
  if (!place && tab === 'ChatRoom') return <NewChatPage />;
  if (place && waiting) return <Screen>{null}</Screen>;
  return (
    <Screen>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
        <Text size={15} color={theme.colors.mut} style={{ textAlign: 'center' }}>
          {place ? PLACE_PICK[place] : EMPTY_PAGE_WORDS[tab as Exclude<Tab, 'ChatRoom'>]}
        </Text>
      </View>
    </Screen>
  );
}
